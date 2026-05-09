import { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore } from './stores/appStore';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TerminalPanel } from './components/Terminal/TerminalPanel';
import { LoginForm } from './components/Auth/LoginForm';
import { useEffectiveTheme } from './hooks/useEffectiveTheme';
import { useMediaQuery, MOBILE_QUERY } from './hooks/useMediaQuery';

type AuthState = 'loading' | 'needs-setup' | 'needs-login' | 'authenticated';

export default function App() {
  const { initialized, init, pollActive } = useAppStore();
  const { ui } = useEffectiveTheme();
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const [authState, setAuthState] = useState<AuthState>('loading');
  const [permWarning, setPermWarning] = useState<string | null>(null);
  const [permChecking, setPermChecking] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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

  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  // Poll the active workspace's session list every 5s so the sidebar's CWD
  // subtitle reflects `cd` activity. Pauses when the tab is hidden — no point
  // refreshing data the user can't see.
  useEffect(() => {
    if (!initialized) return;
    const tick = () => {
      if (document.visibilityState === 'visible') {
        pollActive();
      }
    };
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [initialized, pollActive]);

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
        minHeight: '100vh',
        backgroundColor: ui.appBg,
        color: ui.textPrimary,
        fontFamily: "'JetBrains Mono', monospace",
        padding: '24px',
      }}>
        Starting LociTerm...
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
        minHeight: '100vh',
        backgroundColor: ui.appBg,
        color: ui.textPrimary,
        fontFamily: "'JetBrains Mono', monospace",
        padding: '24px',
      }}>
        Loading...
      </div>
    );
  }

  const sidebarPanelWidth = isMobile ? Math.min(280, window.innerWidth - 56) : sidebarWidth;

  return (
    <div style={{
      display: 'flex',
      width: '100vw',
      height: '100dvh',
      backgroundColor: ui.appBg,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {permWarning && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: ui.overlayBg,
          fontFamily: "'JetBrains Mono', monospace",
          padding: '16px',
        }}>
          <div style={{
            backgroundColor: ui.tabActiveBg,
            border: `1px solid ${ui.sidebarBorder}`,
            padding: '24px',
            maxWidth: '480px',
            width: '100%',
            boxSizing: 'border-box',
            borderRadius: 6,
          }}>
            <div style={{
              color: ui.warning,
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
              marginBottom: '20px',
            }}>
              LociTerm needs <span style={{ color: ui.textPrimary }}>Full Disk Access</span> to
              access protected directories like ~/Documents and ~/Desktop.
            </div>

            <div style={{
              color: ui.textSecondary,
              fontSize: '13px',
              lineHeight: 1.9,
              marginBottom: '20px',
            }}>
              <div style={{ color: ui.textPrimary, marginBottom: 4 }}>Steps:</div>
              <div>1. Open <span style={{ color: ui.accent }}>System Settings</span></div>
              <div>2. Go to <span style={{ color: ui.accent }}>Privacy & Security {'>'} Full Disk Access</span></div>
              <div style={{ wordBreak: 'break-all' }}>
                3. Click <span style={{ color: ui.accent }}>+</span> and add <span style={{ color: ui.textPrimary, background: ui.hoverBg, padding: '1px 6px', borderRadius: 3 }}>/usr/local/bin/lociterm</span>
              </div>
              <div>4. Restart the service</div>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button
                onClick={checkPermissions}
                disabled={permChecking}
                style={{
                  flex: '1 1 200px',
                  padding: '12px',
                  backgroundColor: ui.accent,
                  border: 'none',
                  color: '#fff',
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  cursor: permChecking ? 'wait' : 'pointer',
                  opacity: permChecking ? 0.6 : 1,
                  borderRadius: 4,
                  minHeight: 44,
                }}
              >
                {permChecking ? 'Checking...' : "I've fixed it — Check again"}
              </button>
              <button
                onClick={() => setPermWarning(null)}
                style={{
                  padding: '12px 16px',
                  backgroundColor: 'transparent',
                  border: `1px solid ${ui.sidebarBorder}`,
                  color: ui.textSecondary,
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  borderRadius: 4,
                  minHeight: 44,
                }}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}

      {!isMobile && (
        <>
          <div style={{ width: sidebarPanelWidth, flexShrink: 0, height: '100%' }}>
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
        </>
      )}

      {isMobile && mobileSidebarOpen && (
        <>
          <div
            onClick={() => setMobileSidebarOpen(false)}
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: ui.overlayBg,
              zIndex: 999,
            }}
            aria-hidden
          />
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: sidebarPanelWidth,
            zIndex: 1000,
            boxShadow: '2px 0 8px rgba(0,0,0,0.35)',
          }}>
            <Sidebar onCloseMobile={() => setMobileSidebarOpen(false)} />
          </div>
        </>
      )}

      <div style={{ flex: 1, height: '100%', overflow: 'hidden', minWidth: 0 }}>
        <TerminalPanel
          showMenuButton={isMobile}
          onMenuClick={() => setMobileSidebarOpen(true)}
        />
      </div>
    </div>
  );
}
