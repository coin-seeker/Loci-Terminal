import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { renderHook, cleanup, act, waitFor } from '@testing-library/react';
import { useRef } from 'react';

// Per-instance spies — captured by the @xterm mocks below and inspected by tests.
interface FakeTerminal {
  id: number;
  ctorOptions: Record<string, unknown>;
  element: HTMLElement | null;
  rows: number;
  options: { theme: unknown };
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onBinary: ReturnType<typeof vi.fn>;
  attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
}

interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface FakeFitAddon {
  fit: Mock<() => void>;
  proposeDimensions: Mock<() => TerminalDimensions | undefined>;
}

interface FakeWebglAddon {
  onContextLoss: Mock<(handler: () => void) => void>;
  dispose: Mock<() => void>;
  clearTextureAtlas: Mock<() => void>;
  triggerContextLoss: () => void;
}

const created: FakeTerminal[] = [];
const fitAddons: FakeFitAddon[] = [];
const webglAddons: FakeWebglAddon[] = [];

vi.mock('@xterm/xterm', () => {
  let nextId = 0;
  return {
    Terminal: class {
      id = nextId++;
      ctorOptions: Record<string, unknown> = {};
      element: HTMLElement | null = null;
      rows = 24;
      options = { theme: undefined };
      open = vi.fn((container: HTMLElement) => {
        const el = document.createElement('div');
        el.dataset.fake = 'xterm';
        container.appendChild(el);
        this.element = el;
      });
      loadAddon = vi.fn();
      refresh = vi.fn();
      onData = vi.fn();
      onBinary = vi.fn();
      attachCustomKeyEventHandler = vi.fn();
      dispose = vi.fn();
      paste = vi.fn();
      constructor(opts: Record<string, unknown> = {}) {
        this.ctorOptions = opts;
        created.push(this as unknown as FakeTerminal);
      }
    },
  };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    constructor() {
      fitAddons.push(this as unknown as FakeFitAddon);
    }
  },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    contextLossHandler: (() => void) | null = null;
    onContextLoss = vi.fn((handler: () => void) => {
      this.contextLossHandler = handler;
    });
    dispose = vi.fn();
    clearTextureAtlas = vi.fn();
    constructor() {
      webglAddons.push(this as unknown as FakeWebglAddon);
    }
    triggerContextLoss(): void {
      this.contextLossHandler?.();
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  binaryType = 'arraybuffer';
  onopen: ((this: FakeWebSocket) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    sockets.push(this);
  }
}

const sockets: FakeWebSocket[] = [];

class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(public cb: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
  trigger(): void {
    this.cb([], this as unknown as ResizeObserver);
  }
}

const resizeObservers: FakeResizeObserver[] = [];

// useTerminal stores instances in a module-level Map; reset between tests.
import { useTerminal, disposeTerminal, nextReconnectDelay } from './useTerminal';

function harness(sessionId: string | null) {
  return renderHook(
    ({ sid }: { sid: string | null }) => {
      const ref = useRef<HTMLDivElement | null>(null);
      // The hook reads ref.current before doing anything; provide a stable container.
      if (!ref.current) {
        const div = document.createElement('div');
        document.body.appendChild(div);
        (ref as { current: HTMLDivElement }).current = div;
      }
      useTerminal({ sessionId: sid, containerRef: ref });
      return ref.current;
    },
    { initialProps: { sid: sessionId } },
  );
}

function installBrowserFakes(): void {
  created.length = 0;
  fitAddons.length = 0;
  webglAddons.length = 0;
  sockets.length = 0;
  resizeObservers.length = 0;
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  (window as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver =
    FakeResizeObserver;
  (window as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver =
    FakeResizeObserver;
  const fetchTicket = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ticket: 'ticket' }),
    }),
  );
  vi.stubGlobal('fetch', fetchTicket);
  (window as unknown as { fetch: typeof fetchTicket }).fetch = fetchTicket;
}

async function settleSocketSetup(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
}

async function latestSocket(): Promise<FakeWebSocket> {
  await settleSocketSetup();
  await waitFor(() => {
    expect(sockets).toHaveLength(1);
  });
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('expected a WebSocket to be created');
  return socket;
}

function latestResizeObserver(): FakeResizeObserver {
  const resizeObserver = resizeObservers[resizeObservers.length - 1];
  if (!resizeObserver) throw new Error('expected a ResizeObserver to be created');
  return resizeObserver;
}

describe('useTerminal — VS Code detach/attach pattern', () => {
  beforeEach(() => {
    installBrowserFakes();
  });

  afterEach(() => {
    cleanup();
    // Drain the module-level instance cache so each test starts fresh.
    disposeTerminal('A');
    disposeTerminal('B');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens a terminal on first mount and does not call refresh', () => {
    const { result } = harness('A');
    expect(created).toHaveLength(1);
    const t = created[0];
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(t.element?.parentElement).toBe(result.current);
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it('A → B detaches A from the container and opens B', () => {
    const { result, rerender } = harness('A');
    const a = created[0];
    const container = result.current!;
    expect(a.element?.parentElement).toBe(container);

    rerender({ sid: 'B' });

    expect(created).toHaveLength(2);
    const b = created[1];
    expect(a.element?.parentElement).toBeNull();
    expect(b.element?.parentElement).toBe(container);
  });

  it('A → B → A re-attaches the cached A element AND triggers refresh', () => {
    const { result, rerender } = harness('A');
    const a = created[0];
    const container = result.current!;

    rerender({ sid: 'B' });
    const b = created[1];

    rerender({ sid: 'A' });

    expect(b.element?.parentElement).toBeNull();
    expect(a.element?.parentElement).toBe(container);
    // The fix: xterm doesn't auto-redraw after DOM re-attach, so refresh must be called.
    expect(a.refresh).toHaveBeenCalledWith(0, a.rows - 1);
    // We did not re-open A — it's still the cached instance.
    expect(a.open).toHaveBeenCalledTimes(1);
  });
});

describe('useTerminal — ResizeObserver debounce and attached gate', () => {
  beforeEach(() => {
    installBrowserFakes();
  });

  afterEach(() => {
    cleanup();
    disposeTerminal('R');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('dedupes same dimensions — ws.send called once after debounce', async () => {
    harness('R');
    const socket = await latestSocket();
    const fitAddon = fitAddons[0];
    if (!fitAddon) throw new Error('expected a FitAddon to be created');

    socket.onopen?.call(socket);
    fitAddon.proposeDimensions.mockReturnValue({ cols: 100, rows: 30 });
    socket.onmessage?.({ data: JSON.stringify({ type: 'attached' }) });
    socket.send.mockClear();
    fitAddon.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });

    vi.useFakeTimers();
    const resizeObserver = latestResizeObserver();
    resizeObserver.trigger();
    resizeObserver.trigger();
    resizeObserver.trigger();

    expect(socket.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(79);
    expect(socket.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });

  it('zero-size guard — ws.send not called for 0x0', async () => {
    harness('R');
    const socket = await latestSocket();
    const fitAddon = fitAddons[0];
    if (!fitAddon) throw new Error('expected a FitAddon to be created');
    fitAddon.proposeDimensions.mockReturnValue({ cols: 0, rows: 0 });

    socket.onopen?.call(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: 'attached' }) });
    socket.send.mockClear();

    vi.useFakeTimers();
    latestResizeObserver().trigger();
    vi.advanceTimersByTime(80);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('initial resize is gated by the attached message', async () => {
    harness('R');
    const socket = await latestSocket();

    socket.onopen?.call(socket);
    expect(socket.send).not.toHaveBeenCalled();

    socket.onmessage?.({ data: JSON.stringify({ type: 'attached' }) });

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });
});

describe('useTerminal — WebGL context loss recovery', () => {
  beforeEach(() => {
    installBrowserFakes();
  });

  afterEach(() => {
    cleanup();
    disposeTerminal('W');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('webgl context loss recovery — addon reloaded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      harness('W');
      const terminal = created[0];
      const firstWebgl = webglAddons[0];
      if (!terminal || !firstWebgl) throw new Error('expected terminal and WebGL addon');
      terminal.loadAddon.mockClear();

      firstWebgl.triggerContextLoss();

      const secondWebgl = webglAddons[1];
      if (!secondWebgl) throw new Error('expected WebGL addon reload');
      expect(firstWebgl.dispose).toHaveBeenCalledTimes(1);
      expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
      expect(terminal.loadAddon).toHaveBeenCalledWith(secondWebgl);
    } finally {
      warn.mockRestore();
    }
  });

  it('webgl context loss fallback — graceful degrade if reload fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = harness('W');
      const terminal = created[0];
      const firstWebgl = webglAddons[0];
      if (!terminal || !firstWebgl) throw new Error('expected terminal and WebGL addon');
      terminal.loadAddon.mockClear();
      terminal.loadAddon.mockImplementationOnce(() => {
        throw new Error('reload failed');
      });

      expect(() => firstWebgl.triggerContextLoss()).not.toThrow();

      expect(firstWebgl.dispose).toHaveBeenCalledTimes(1);
      expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(terminal.element?.parentElement).toBe(result.current);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Terminal constructor options', () => {
  beforeEach(() => {
    installBrowserFakes();
  });

  afterEach(() => {
    cleanup();
    disposeTerminal('S');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses smoothScrollDuration 0 for instant scroll', () => {
    harness('S');
    expect(created).toHaveLength(1);
    const opts = created[0].ctorOptions;
    expect(opts.smoothScrollDuration).toBe(0);
  });
});

describe('nextReconnectDelay (exponential backoff with jitter)', () => {
  it('grows as 500 * 2^attempts, capped at 10s', () => {
    // Force jitter to zero (Math.random()=0.5 → jitter coefficient 0).
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(nextReconnectDelay(0)).toBe(500);
      expect(nextReconnectDelay(1)).toBe(1000);
      expect(nextReconnectDelay(2)).toBe(2000);
      expect(nextReconnectDelay(3)).toBe(4000);
      expect(nextReconnectDelay(4)).toBe(8000);
      expect(nextReconnectDelay(5)).toBe(10_000); // cap holds
      expect(nextReconnectDelay(6)).toBe(10_000);
      expect(nextReconnectDelay(99)).toBe(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('floors at 250ms even with worst-case negative jitter', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // jitter coeff = -1
    try {
      const d = nextReconnectDelay(0);
      // base=500, jitter=-100, raw=400; floor of 250 must keep us above 250.
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('produces a spread when many tabs reconnect at once (jitter desyncs them)', () => {
    // 100 reconnect timings at attempt=2 should not all be identical.
    const delays = new Set<number>();
    for (let i = 0; i < 100; i++) delays.add(nextReconnectDelay(2));
    expect(delays.size).toBeGreaterThan(1);
  });
});
