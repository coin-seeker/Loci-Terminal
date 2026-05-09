import { useAppStore } from '../../stores/appStore';
import { TabBar } from './TabBar';
import { TerminalView } from './TerminalView';

interface TerminalPanelProps {
  showMenuButton?: boolean;
  onMenuClick?: () => void;
}

export function TerminalPanel({ showMenuButton, onMenuClick }: TerminalPanelProps) {
  const { activeSessionId, sessions } = useAppStore();
  // Render every session across every workspace and toggle visibility instead
  // of remounting on workspace switch. Detaching a TerminalView from the DOM
  // detaches xterm's element/canvas, and the WebGL renderer doesn't recover
  // its contents on reattach — that's what caused the blank-terminal-until-
  // refresh bug when switching back to the first workspace.
  const allSessions = Object.values(sessions).flat();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      overflow: 'hidden',
    }}>
      <TabBar showMenuButton={showMenuButton} onMenuClick={onMenuClick} />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {allSessions.map((sess) => (
          <div
            key={sess.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: sess.id === activeSessionId ? 'block' : 'none',
            }}
          >
            <TerminalView sessionId={sess.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
