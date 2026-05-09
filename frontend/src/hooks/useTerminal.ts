import { useEffect, useRef, useCallback } from 'react';
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
}

const instances = new Map<string, TerminalInstance>();

// True when the container has real layout dimensions (i.e. is currently
// `display: block` and laid out). Calling fit() against a 0x0 container
// shrinks the PTY to 2x1, corrupts xterm's reflow, and (with WebGL) wipes
// the framebuffer — that's what made the first workspace go black on return.
function hasRealSize(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  return el.offsetWidth > 0 && el.offsetHeight > 0;
}

function fitAndSendResize(inst: TerminalInstance, container: HTMLElement) {
  if (!hasRealSize(container)) return;
  inst.fitAddon.fit();
  const dims = inst.fitAddon.proposeDimensions();
  if (dims && inst.ws?.readyState === WebSocket.OPEN) {
    inst.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
  }
}

// Factory exported for testing — returns the ResizeObserver callback so
// tests can drive it without a real ResizeObserver.
export function createResizeHandler(
  inst: TerminalInstance,
  container: HTMLElement,
): ResizeObserverCallback {
  let wasHidden = false;
  return (entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) {
        wasHidden = true;
        continue;
      }
      fitAndSendResize(inst, container);
      if (wasHidden) {
        wasHidden = false;
        // WebGL framebuffer can lose its contents while the canvas was 0x0;
        // force xterm to repaint its current buffer state.
        inst.terminal.refresh(0, Math.max(0, inst.terminal.rows - 1));
      }
    }
  };
}

export function useTerminal({ sessionId, containerRef, theme }: UseTerminalOptions) {
  const activeTheme = theme ?? darkTerminalTheme;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);

  const connect = useCallback((term: Terminal, sid: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws/terminal/${sid}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      const inst = instances.get(sid);
      if (!inst) return;
      inst.fitAddon.fit();
      const dims = inst.fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'attached') {
            console.log('Terminal attached');
          }
        } catch {}
      }
    };

    ws.onclose = () => {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = window.setTimeout(() => {
        if (instances.has(sid)) {
          connect(term, sid);
        }
      }, 2000);
    };

    wsRef.current = ws;
    const inst = instances.get(sid);
    if (inst) inst.ws = ws;

    const sendString = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const encoder = new TextEncoder();
        ws.send(encoder.encode(data));
      }
    };

    term.onData((data) => sendString(data));

    term.attachCustomKeyEventHandler(createShiftEnterHandler(sendString));

    term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const buffer = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          buffer[i] = data.charCodeAt(i);
        }
        ws.send(buffer);
      }
    });
  }, []);

  useEffect(() => {
    if (!sessionId || !containerRef.current) return;

    let inst = instances.get(sessionId);

    if (!inst) {
      const terminal = new Terminal({
        theme: activeTheme,
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

      inst = { terminal, fitAddon, ws: null };
      instances.set(sessionId, inst);
    }

    const container = containerRef.current;
    // xterm's open() is not idempotent: re-running it on a new container leaves the
    // previous element orphaned and the new container blank. After the first open()
    // we move the existing terminal element across mounts (e.g. workspace switches)
    // so the cached instance keeps its viewport, scrollback, and event handlers.
    if (inst.terminal.element) {
      if (inst.terminal.element.parentElement !== container) {
        container.appendChild(inst.terminal.element);
      }
    } else {
      inst.terminal.open(container);
      try {
        inst.terminal.loadAddon(new WebglAddon());
      } catch {
        console.warn('WebGL addon failed, using canvas renderer');
      }
      // Tame mobile keyboards: stop autocapitalize/autocorrect/spellcheck from
      // mangling input, especially CJK IME where mid-composition jamo can be
      // "corrected" before the syllable is committed.
      const ta = (inst.terminal as unknown as { textarea?: HTMLTextAreaElement }).textarea;
      if (ta) {
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('spellcheck', 'false');
      }
    }

    inst.fitAddon.fit();

    if (!inst.ws || inst.ws.readyState === WebSocket.CLOSED) {
      connect(inst.terminal, sessionId);
    }

    const resizeObserver = new ResizeObserver(createResizeHandler(inst, container));
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [sessionId, containerRef, connect, activeTheme]);

  useEffect(() => {
    if (!sessionId) return;
    const inst = instances.get(sessionId);
    if (!inst) return;
    inst.terminal.options.theme = activeTheme;
  }, [sessionId, activeTheme]);

  useEffect(() => {
    return () => {
      clearTimeout(reconnectTimer.current);
    };
  }, []);
}

export function disposeTerminal(sessionId: string) {
  const inst = instances.get(sessionId);
  if (inst) {
    inst.ws?.close();
    inst.terminal.dispose();
    instances.delete(sessionId);
  }
}

export function pasteToTerminal(sessionId: string, text: string): boolean {
  const inst = instances.get(sessionId);
  if (!inst) return false;
  inst.terminal.paste(text);
  return true;
}
