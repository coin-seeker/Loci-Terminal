import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { ITheme } from '@xterm/xterm';
import { darkTerminalTheme } from '../lib/theme';
import { createShiftEnterHandler } from './shiftEnter';

interface UseTerminalOptions {
  sessionId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  theme?: ITheme;
}

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket | null;
  webgl: WebglAddon | null;
  reconnectTimer: number | undefined;
  listenersBound: boolean;
}

const instances = new Map<string, TerminalInstance>();

function createInstance(theme: ITheme): TerminalInstance {
  const terminal = new Terminal({
    theme,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Noto Sans KR', 'Noto Sans CJK SC', monospace",
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    allowProposedApi: true,
    scrollback: 10000,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  return {
    terminal,
    fitAddon,
    ws: null,
    webgl: null,
    reconnectTimer: undefined,
    listenersBound: false,
  };
}

// Per xterm.js WebglAddon README: register onContextLoss to dispose the
// addon when the browser evicts the WebGL context. xterm falls back to its
// built-in renderer automatically. Without this, the canvas goes black and
// stays black for the lifetime of the page.
function loadWebgl(inst: TerminalInstance): void {
  if (inst.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      inst.webgl = null;
    });
    inst.terminal.loadAddon(webgl);
    inst.webgl = webgl;
  } catch {
    console.warn('WebGL addon failed, using fallback renderer');
  }
}

function configureTextarea(inst: TerminalInstance): void {
  const ta = (inst.terminal as unknown as { textarea?: HTMLTextAreaElement }).textarea;
  if (!ta) return;
  // Stop mobile keyboards from autocapitalize/autocorrect/spellcheck on
  // terminal input — particularly important for CJK IME mid-composition.
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('spellcheck', 'false');
}

// Bind input → WebSocket listeners exactly once per instance. The listener
// closures read `inst.ws` at call time so they survive reconnects without
// needing to be re-attached (which would otherwise leak duplicate listeners).
function bindInputListeners(inst: TerminalInstance): void {
  if (inst.listenersBound) return;
  inst.listenersBound = true;

  // WebSocket.send rejects views over SharedArrayBuffer in current TS lib types,
  // so the parameter is narrowed to Uint8Array<ArrayBuffer>. Both TextEncoder
  // output and `new Uint8Array(length)` produce that exact type.
  const sendBytes = (bytes: Uint8Array<ArrayBuffer>) => {
    const ws = inst.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(bytes);
    }
  };
  const sendString = (data: string) => sendBytes(new TextEncoder().encode(data));

  inst.terminal.onData(sendString);
  inst.terminal.attachCustomKeyEventHandler(createShiftEnterHandler(sendString));
  inst.terminal.onBinary((data) => {
    const buf = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i);
    sendBytes(buf);
  });
}

function connectWebSocket(inst: TerminalInstance, sid: string): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws/terminal/${sid}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    inst.fitAddon.fit();
    const dims = inst.fitAddon.proposeDimensions();
    if (dims) {
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      inst.terminal.write(new Uint8Array(e.data));
    } else {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'attached') {
          console.log('Terminal attached');
        }
      } catch {
        // ignore non-JSON text frames
      }
    }
  };

  ws.onclose = () => {
    clearTimeout(inst.reconnectTimer);
    inst.reconnectTimer = window.setTimeout(() => {
      if (instances.has(sid)) {
        connectWebSocket(inst, sid);
      }
    }, 2000);
  };

  inst.ws = ws;
}

// Detach the cached terminal element for `sessionId` from `container` if it
// is currently mounted there. The instance itself stays alive in the map;
// only its DOM presence is removed.
function detachFromContainer(sessionId: string, container: HTMLElement): void {
  const inst = instances.get(sessionId);
  const el = inst?.terminal.element;
  if (el && el.parentElement === container) {
    container.removeChild(el);
  }
}

export function useTerminal({ sessionId, containerRef, theme }: UseTerminalOptions) {
  const activeTheme = theme ?? darkTerminalTheme;
  const previousSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previousSessionId = previousSessionIdRef.current;
    if (previousSessionId && previousSessionId !== sessionId) {
      detachFromContainer(previousSessionId, container);
    }

    if (!sessionId) {
      previousSessionIdRef.current = null;
      return;
    }

    let inst = instances.get(sessionId);
    if (!inst) {
      inst = createInstance(activeTheme);
      instances.set(sessionId, inst);
    }

    if (inst.terminal.element) {
      // Re-attach the cached element to the (possibly new) container.
      // VS Code's pattern: keep one xterm instance per session alive but
      // move its DOM node in/out as the user switches tabs. Avoids
      // xterm.js's display:none corruption (xtermjs/xterm.js#494, #3029).
      if (inst.terminal.element.parentElement !== container) {
        container.appendChild(inst.terminal.element);
      }
    } else {
      inst.terminal.open(container);
      loadWebgl(inst);
      configureTextarea(inst);
      bindInputListeners(inst);
    }

    inst.fitAddon.fit();

    if (!inst.ws || inst.ws.readyState === WebSocket.CLOSED) {
      connectWebSocket(inst, sessionId);
    }

    previousSessionIdRef.current = sessionId;

    const resizeObserver = new ResizeObserver(() => {
      const i = instances.get(sessionId);
      if (!i) return;
      i.fitAddon.fit();
      const dims = i.fitAddon.proposeDimensions();
      if (dims && i.ws?.readyState === WebSocket.OPEN) {
        i.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [sessionId, containerRef, activeTheme]);

  useEffect(() => {
    if (!sessionId) return;
    const inst = instances.get(sessionId);
    if (!inst) return;
    inst.terminal.options.theme = activeTheme;
  }, [sessionId, activeTheme]);
}

export function disposeTerminal(sessionId: string): void {
  const inst = instances.get(sessionId);
  if (!inst) return;
  clearTimeout(inst.reconnectTimer);
  inst.ws?.close();
  inst.terminal.dispose();
  instances.delete(sessionId);
}

export function pasteToTerminal(sessionId: string, text: string): boolean {
  const inst = instances.get(sessionId);
  if (!inst) return false;
  inst.terminal.paste(text);
  return true;
}
