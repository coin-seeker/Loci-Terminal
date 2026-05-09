import { describe, it, expect, vi } from 'vitest';
import { createShiftEnterHandler } from './shiftEnter';

function makeEvent(init: Partial<KeyboardEventInit> & { type?: string }): KeyboardEvent {
  const { type = 'keydown', ...rest } = init;
  return new KeyboardEvent(type, rest);
}

describe('createShiftEnterHandler', () => {
  it('sends ESC+CR and returns false on Shift+Enter keydown', () => {
    const send = vi.fn();
    const handler = createShiftEnterHandler(send);

    const result = handler(makeEvent({ key: 'Enter', shiftKey: true, type: 'keydown' }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('\x1b\r');
    expect(result).toBe(false);
  });

  it('passes through plain Enter (no send, returns true)', () => {
    const send = vi.fn();
    const handler = createShiftEnterHandler(send);

    const result = handler(makeEvent({ key: 'Enter', shiftKey: false, type: 'keydown' }));

    expect(send).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('passes through Shift+other key (no send, returns true)', () => {
    const send = vi.fn();
    const handler = createShiftEnterHandler(send);

    const result = handler(makeEvent({ key: 'A', shiftKey: true, type: 'keydown' }));

    expect(send).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('ignores Shift+Enter on keyup (only keydown triggers send)', () => {
    const send = vi.fn();
    const handler = createShiftEnterHandler(send);

    const result = handler(makeEvent({ key: 'Enter', shiftKey: true, type: 'keyup' }));

    expect(send).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('does not throw if send throws (graceful)', () => {
    const send = vi.fn(() => {
      throw new Error('socket closed');
    });
    const handler = createShiftEnterHandler(send);

    expect(() => handler(makeEvent({ key: 'Enter', shiftKey: true, type: 'keydown' }))).not.toThrow();
  });

  it('does not trigger when Ctrl or Alt also held (avoid clobbering shortcuts)', () => {
    const send = vi.fn();
    const handler = createShiftEnterHandler(send);

    handler(makeEvent({ key: 'Enter', shiftKey: true, ctrlKey: true, type: 'keydown' }));
    handler(makeEvent({ key: 'Enter', shiftKey: true, altKey: true, type: 'keydown' }));
    handler(makeEvent({ key: 'Enter', shiftKey: true, metaKey: true, type: 'keydown' }));

    expect(send).not.toHaveBeenCalled();
  });
});
