import { useCallback, useRef, useState } from 'react';
import { sendToTerminal } from '../../hooks/useTerminal';
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme';

interface MobileInputBarProps {
  sessionId: string | null;
}

interface ToolKey {
  label: string;
  // Bytes sent to the PTY when tapped. Multi-byte sequences are fine.
  bytes: string;
  title?: string;
}

// Mobile virtual keyboards rarely surface Esc/Tab/Ctrl/arrow keys, and their
// hidden-textarea IME path breaks Korean/Chinese composition (see TODO.md).
// We give mobile users a normal <textarea> + toolbar instead, send the
// finalized text via WebSocket, and let xterm stay read-only on mobile.
const TOOL_KEYS: ToolKey[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: '^C', bytes: '\x03', title: 'Ctrl+C (interrupt)' },
  { label: '^D', bytes: '\x04', title: 'Ctrl+D (EOF)' },
  { label: '^Z', bytes: '\x1a', title: 'Ctrl+Z (suspend)' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
  { label: '←', bytes: '\x1b[D' },
  { label: '→', bytes: '\x1b[C' },
];

export function MobileInputBar({ sessionId }: MobileInputBarProps) {
  const { ui } = useEffectiveTheme();
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const sendKey = useCallback(
    (bytes: string) => {
      if (!sessionId) return;
      sendToTerminal(sessionId, bytes);
    },
    [sessionId],
  );

  const handleSend = useCallback(() => {
    if (!sessionId) return;
    // Send composed text + CR. Multi-line text (newlines from the textarea)
    // passes through as-is — the receiving CLI interprets `\n`s in pasted
    // input as ordinary newlines.
    sendToTerminal(sessionId, text + '\r');
    setText('');
    taRef.current?.focus();
  }, [sessionId, text]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Plain Enter sends. Shift+Enter inserts a newline (handled natively by
      // the textarea — we just need to not intercept it).
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: `1px solid ${ui.sidebarBorder}`,
        backgroundColor: ui.tabActiveBg,
        // Respect iOS home-indicator safe area.
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '6px 8px',
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {TOOL_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            title={k.title ?? k.label}
            onClick={() => sendKey(k.bytes)}
            style={{
              flex: '0 0 auto',
              minWidth: 44,
              height: 36,
              padding: '0 10px',
              backgroundColor: ui.hoverBg,
              border: `1px solid ${ui.sidebarBorder}`,
              borderRadius: 6,
              color: ui.textPrimary,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          padding: '0 8px 8px',
        }}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type and press Send (Shift+Enter for newline)"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 120,
            resize: 'none',
            padding: '8px 10px',
            backgroundColor: ui.appBg,
            border: `1px solid ${ui.sidebarBorder}`,
            borderRadius: 6,
            color: ui.textPrimary,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 14,
            lineHeight: 1.4,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!sessionId}
          style={{
            flex: '0 0 auto',
            minWidth: 56,
            height: 40,
            padding: '0 14px',
            backgroundColor: ui.accent,
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            fontFamily: 'inherit',
            fontSize: 14,
            fontWeight: 600,
            cursor: sessionId ? 'pointer' : 'not-allowed',
            opacity: sessionId ? 1 : 0.5,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
