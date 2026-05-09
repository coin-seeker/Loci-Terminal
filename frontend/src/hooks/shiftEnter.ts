export type SendFn = (data: string) => void;

export function createShiftEnterHandler(send: SendFn) {
  return (event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown') return true;
    if (event.key !== 'Enter') return true;
    if (!event.shiftKey) return true;
    if (event.ctrlKey || event.altKey || event.metaKey) return true;

    try {
      // ESC + CR — the de facto Shift+Enter sequence used by iTerm2, WezTerm,
      // and kitty. Modern AI CLIs (Claude Code, Aider, Codex via ink) treat
      // this as "newline within prompt"; bash readline ignores the lone ESC
      // and processes the CR as ordinary Enter, so it's safe in raw shells too.
      send('\x1b\r');
    } catch {
      // WebSocket may have closed; swallow to avoid breaking xterm input pipeline.
    }
    return false;
  };
}
