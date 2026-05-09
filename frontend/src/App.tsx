import { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore } from './stores/appStore';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TerminalPanel } from './components/Terminal/TerminalPanel';
import { LoginForm } from './components/Auth/LoginForm';
import { ui } from './lib/theme';

type AuthState = 'loading' | 'needs-setup' | 'needs-login' | 'authenticated';

export default function App() {
  const { initialized, init } = useAppStore();
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [permWarning, setPermWarning] = useState<string | null>(null);
  const [permChecking, setPermChecking] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const dragging = useRef(false);

  const checkAuth = useCallback(async () => {
    const res = await fetch('/api/v1/auth/check');
    const data = await res.json();

    if (data.needsSetup) {
      setAuthState('needs-setup');
    } else {
      const testRes = await fetch('/api/v1/workspaces');
      if (testRes.status === 401) {
        setAuthState('needs-login');
      } else {
        setAuthState('authenticated');
      }
    }
  }, []);

  const checkPermissions = useCallback(async () => {
    setPermChecking(true);
    try {
      const res = await fetch('/api/v1/health');
      const data = await res.json();
      if (data.permissions === false && data.permissionMessage) {
        setPermWarning(data.permissionMessage);
      } else {
        setPermWarning(null);
      }
    } catch {}
    setPermChecking(false);
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (authState === 'authenticated' && !initialized) {
      init();
      checkPermissions();
    }
  }, [authState, initialized, init, checkPermissions]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (e: MouseEvent) => {
      if (dragging.current) {
        setSidebarWidth(Math.max(140, Math.min(400, e.clientX)));
      }
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  if (authState === 'loading') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: ui.terminalBg,
        color: ui.textPrimary,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        Starting Loci Terminal...
      </div>
    );
  }

  if (authState === 'needs-setup' || authState === 'needs-login') {
    return (
      <LoginForm
        needsSetup={authState === 'needs-setup'}
        onSuccess={() => setAuthState('authenticated')}
      />
    );
  }

  if (!initialized) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: ui.terminalBg,
        color: ui.textPrimary,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      width: '100vw',
      height: '100vh',
      backgroundColor: ui.terminalBg,
      overflow: 'hidden',
    }}>
      {permWarning && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          <div style={{
            backgroundColor: ui.tabActiveBg,
            border: `1px solid ${ui.sidebarBorder}`,
            padding: '32px',
            maxWidth: '480px',
            width: '90%',
          }}>
            <div style={{
              color: '#d29922',
              fontSize: '16px',
              fontWeight: 600,
              marginBottom: '16px',
            }}>
              Permission Required
            </div>

            <div style={{
              color: ui.textSecondary,
              fontSize: '13px',
              lineHeight: 1.6,
              marginBottom: '24px',
            }}>
              Loci Terminal needs <span style={{ color: ui.textPrimary }}>Full Disk Access</span> to
              access protected directories like ~/Documents and ~/Desktop.
            </div>

            <div style={{
              color: ui.textSecondary,
              fontSize: '13px',
              lineHeight: 2,
              marginBottom: '24px',
            }}>
              <div style={{ color: ui.textPrimary }}>Steps:</div>
              <div>1. Open <span style={{ color: ui.accent }}>System Settings</span></div>
              <div>2. Go to <span style={{ color: ui.accent }}>Privacy & Security {'>'} Full Disk Access</span></div>
              <div>3. Click <span style={{ color: ui.accent }}>+</span> and add <span style={{ color: ui.textPrimary, background: ui.sidebarBorder, padding: '1px 6px' }}>/usr/local/bin/ghostterm</span></div>
              <div>4. Restart the service</div>
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={checkPermissions}
                disabled={permChecking}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: ui.accent,
                  border: 'none',
                  color: '#fff',
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  cursor: permChecking ? 'wait' : 'pointer',
                  opacity: permChecking ? 0.6 : 1,
                }}
              >
                {permChecking ? 'Checking...' : 'I\'ve fixed it — Check again'}
              </button>
              <button
                onClick={() => setPermWarning(null)}
                style={{
                  padding: '10px 16px',
                  backgroundColor: 'transparent',
                  border: `1px solid ${ui.sidebarBorder}`,
                  color: ui.textSecondary,
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ width: sidebarWidth, flexShrink: 0, height: '100%' }}>
        <Sidebar />
      </div>

      <div
        onMouseDown={onMouseDown}
        style={{
          width: '4px',
          cursor: 'col-resize',
          backgroundColor: 'transparent',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLElement).style.backgroundColor = ui.accent;
        }}
        onMouseLeave={(e) => {
          if (!dragging.current) {
            (e.target as HTMLElement).style.backgroundColor = 'transparent';
          }
        }}
      />

      <div style={{ flex: 1, height: '100%', overflow: 'hidden' }}>
        <TerminalPanel />
      </div>
    </div>
  );
}
