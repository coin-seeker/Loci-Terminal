import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useAppStore,
  sessionUnread,
  workspaceUnread,
  __resetActivityTrackingForTests,
} from './appStore';
import { api } from '../api/client';

const { mockWorkspace, mockSession } = vi.hoisted(() => ({
  mockWorkspace: { id: 'ws-1', name: 'Test', sortOrder: 0, createdAt: '', updatedAt: '' },
  mockSession: { id: 's-1', workspaceId: 'ws-1', title: 'Terminal', sortOrder: 0, createdAt: '', updatedAt: '' },
}));

vi.mock('../api/client', () => ({
  api: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn().mockResolvedValue(mockWorkspace),
    updateWorkspace: vi.fn().mockResolvedValue({ ...mockWorkspace, name: 'Renamed' }),
    deleteWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue(mockSession),
    updateSession: vi.fn().mockResolvedValue({ ...mockSession, title: 'Updated' }),
    deleteSession: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [],
      sessions: {},
      activeWorkspaceId: null,
      activeSessionId: null,
      activeSessionByWorkspace: {},
      sessionActivity: {},
      toasts: [],
      initialized: false,
    });
    setVisibility('visible');
    __resetActivityTrackingForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts uninitialized', () => {
    const state = useAppStore.getState();
    expect(state.initialized).toBe(false);
    expect(state.workspaces).toEqual([]);
    expect(state.activeWorkspaceId).toBeNull();
    expect(state.activeSessionId).toBeNull();
  });

  it('createWorkspace adds workspace and creates session', async () => {
    await useAppStore.getState().createWorkspace('Test');
    const state = useAppStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].name).toBe('Test');
    expect(state.activeWorkspaceId).toBe('ws-1');
    expect(state.activeSessionId).toBe('s-1');
    expect(state.sessions['ws-1']).toHaveLength(1);
  });

  it('deleteWorkspace removes workspace and sessions', async () => {
    useAppStore.setState({
      workspaces: [mockWorkspace],
      sessions: { 'ws-1': [mockSession] },
      activeWorkspaceId: 'ws-1',
      activeSessionId: 's-1',
    });

    await useAppStore.getState().deleteWorkspace('ws-1');
    const state = useAppStore.getState();
    expect(state.workspaces).toHaveLength(0);
    expect(state.sessions['ws-1']).toBeUndefined();
    expect(state.activeWorkspaceId).toBeNull();
  });

  it('renameWorkspace updates the workspace name', async () => {
    useAppStore.setState({
      workspaces: [mockWorkspace],
      activeWorkspaceId: 'ws-1',
    });

    await useAppStore.getState().renameWorkspace('ws-1', 'Renamed');
    const ws = useAppStore.getState().workspaces[0];
    expect(ws.name).toBe('Renamed');
  });

  it('setActiveSession updates activeSessionId', () => {
    useAppStore.getState().setActiveSession('s-2');
    expect(useAppStore.getState().activeSessionId).toBe('s-2');
  });

  it('deleteSession updates active to next', async () => {
    const s2 = { ...mockSession, id: 's-2', title: 'Second' };
    useAppStore.setState({
      workspaces: [mockWorkspace],
      sessions: { 'ws-1': [mockSession, s2] },
      activeWorkspaceId: 'ws-1',
      activeSessionId: 's-1',
    });

    await useAppStore.getState().deleteSession('s-1');
    const state = useAppStore.getState();
    expect(state.sessions['ws-1']).toHaveLength(1);
    expect(state.activeSessionId).toBe('s-2');
  });

  describe('sessionActivity', () => {
    // Drive a sustained burst (>= MIN_BUSY_MS) so the idle-after-busy
    // heuristic considers it real activity, then advance past IDLE_MS to
    // trigger the timer.
    function driveBurstAndIdle(sessionId: string, burstMs = 600, idleMs = 2000) {
      useAppStore.getState().markSessionOutput(sessionId);
      vi.advanceTimersByTime(burstMs);
      useAppStore.getState().markSessionOutput(sessionId);
      vi.advanceTimersByTime(idleMs);
    }

    it('flips unread after a sustained background burst goes idle', () => {
      useAppStore.setState({ activeSessionId: 's-1' });
      driveBurstAndIdle('s-2');
      const state = useAppStore.getState();
      expect(sessionUnread(state, 's-2')).toBe(true);
      expect(state.sessionActivity['s-2'].lastOutputAt).toBeGreaterThan(0);
    });

    it('does not flip unread while output is still streaming', () => {
      useAppStore.setState({ activeSessionId: 's-1' });
      useAppStore.getState().markSessionOutput('s-2');
      // 10 chunks @ 200ms = 2s of activity, but never an idle gap of 1.5s.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(200);
        useAppStore.getState().markSessionOutput('s-2');
      }
      expect(sessionUnread(useAppStore.getState(), 's-2')).toBe(false);
    });

    it('does not flip unread for a single brief output (under MIN_BUSY_MS)', () => {
      useAppStore.setState({ activeSessionId: 's-1' });
      useAppStore.getState().markSessionOutput('s-2');
      vi.advanceTimersByTime(2000); // > IDLE_MS, but burst length was 0
      expect(sessionUnread(useAppStore.getState(), 's-2')).toBe(false);
      expect(useAppStore.getState().sessionActivity['s-2']).toBeUndefined();
    });

    it('does not flip unread for jitter shorter than MIN_BUSY_MS', () => {
      useAppStore.setState({ activeSessionId: 's-1' });
      useAppStore.getState().markSessionOutput('s-2');
      vi.advanceTimersByTime(100);
      useAppStore.getState().markSessionOutput('s-2');
      vi.advanceTimersByTime(2000);
      expect(sessionUnread(useAppStore.getState(), 's-2')).toBe(false);
    });

    it('markSessionOutput is a no-op when sessionId is active and document is visible', () => {
      useAppStore.setState({ activeSessionId: 's-1' });
      setVisibility('visible');
      useAppStore.getState().markSessionOutput('s-1');
      vi.advanceTimersByTime(2000);
      const state = useAppStore.getState();
      expect(sessionUnread(state, 's-1')).toBe(false);
      expect(state.sessionActivity['s-1']).toBeUndefined();
    });

    it('flips unread for the active session when the tab is hidden', () => {
      useAppStore.setState({ activeSessionId: 's-1' });
      setVisibility('hidden');
      driveBurstAndIdle('s-1');
      expect(sessionUnread(useAppStore.getState(), 's-1')).toBe(true);
    });

    it('switching to a session during the idle window cancels the pending unread', () => {
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, { ...mockSession, id: 's-2' }] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      useAppStore.getState().markSessionOutput('s-2');
      vi.advanceTimersByTime(600);
      useAppStore.getState().markSessionOutput('s-2');
      // User switches to s-2 mid-idle-window.
      vi.advanceTimersByTime(500);
      useAppStore.getState().setActiveSession('s-2');
      vi.advanceTimersByTime(2000);
      expect(sessionUnread(useAppStore.getState(), 's-2')).toBe(false);
    });

    it('does not flip unread for a session deleted during the idle window', async () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      useAppStore.getState().markSessionOutput('s-2');
      vi.advanceTimersByTime(600);
      useAppStore.getState().markSessionOutput('s-2');
      await useAppStore.getState().deleteSession('s-2');
      vi.advanceTimersByTime(2000);
      expect(useAppStore.getState().sessionActivity['s-2']).toBeUndefined();
    });

    it('setActiveSession clears unread for the newly-active session', () => {
      useAppStore.setState({
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
        sessionActivity: {
          's-2': { unread: true, lastOutputAt: 100, notifiedAt: 0 },
        },
      });
      useAppStore.getState().setActiveSession('s-2');
      const state = useAppStore.getState();
      expect(state.activeSessionId).toBe('s-2');
      expect(sessionUnread(state, 's-2')).toBe(false);
      // Timestamps preserved — only `unread` flips.
      expect(state.sessionActivity['s-2'].lastOutputAt).toBe(100);
    });

    it('clearSessionUnread leaves lastOutputAt and notifiedAt untouched', () => {
      useAppStore.setState({
        sessionActivity: {
          's-1': { unread: true, lastOutputAt: 100, notifiedAt: 50 },
        },
      });
      useAppStore.getState().clearSessionUnread('s-1');
      const a = useAppStore.getState().sessionActivity['s-1'];
      expect(a.unread).toBe(false);
      expect(a.lastOutputAt).toBe(100);
      expect(a.notifiedAt).toBe(50);
    });

    it('workspaceUnread is true when any session in that workspace has unread', () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        sessionActivity: {
          's-2': { unread: true, lastOutputAt: 1, notifiedAt: 0 },
        },
      });
      expect(workspaceUnread(useAppStore.getState(), 'ws-1')).toBe(true);
    });

    it('workspaceUnread is false when no session in that workspace has unread', () => {
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession] },
        sessionActivity: {
          's-1': { unread: false, lastOutputAt: 1, notifiedAt: 0 },
        },
      });
      expect(workspaceUnread(useAppStore.getState(), 'ws-1')).toBe(false);
    });

    it('deleteSession prunes its sessionActivity entry', async () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
        sessionActivity: {
          's-2': { unread: true, lastOutputAt: 1, notifiedAt: 0 },
        },
      });
      await useAppStore.getState().deleteSession('s-2');
      expect(useAppStore.getState().sessionActivity['s-2']).toBeUndefined();
    });
  });

  describe('toasts', () => {
    function driveBurstAndIdle(sessionId: string, burstMs = 600, idleMs = 2000) {
      useAppStore.getState().markSessionOutput(sessionId);
      vi.advanceTimersByTime(burstMs);
      useAppStore.getState().markSessionOutput(sessionId);
      vi.advanceTimersByTime(idleMs);
    }

    it('pushes a toast when a background session goes idle after a burst', () => {
      const s2 = { ...mockSession, id: 's-2', title: 'Build' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      driveBurstAndIdle('s-2');
      const toasts = useAppStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].sessionId).toBe('s-2');
      expect(toasts[0].workspaceId).toBe('ws-1');
      expect(toasts[0].sessionTitle).toBe('Build');
    });

    it('does not push a toast for the active foreground session', () => {
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      driveBurstAndIdle('s-1');
      expect(useAppStore.getState().toasts).toHaveLength(0);
    });

    it('coalesces repeat toasts for the same session', () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      driveBurstAndIdle('s-2');
      // Reset unread so the next idle fire isn't a no-op, simulating that
      // the user briefly viewed the session and stepped away again.
      useAppStore.getState().clearSessionUnread('s-2');
      driveBurstAndIdle('s-2');
      const toasts = useAppStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].sessionId).toBe('s-2');
    });

    it('setActiveSession dismisses pending toasts for that session', () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      driveBurstAndIdle('s-2');
      useAppStore.getState().setActiveSession('s-2');
      expect(useAppStore.getState().toasts).toHaveLength(0);
    });

    it('dismissToast removes a single toast by id', () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      driveBurstAndIdle('s-2');
      const toast = useAppStore.getState().toasts[0];
      useAppStore.getState().dismissToast(toast.id);
      expect(useAppStore.getState().toasts).toHaveLength(0);
    });

    it('deleteSession drops toasts for that session', async () => {
      const s2 = { ...mockSession, id: 's-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession, s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
        toasts: [
          { id: 't-1', sessionId: 's-2', workspaceId: 'ws-1', sessionTitle: 'x', createdAt: 1 },
        ],
      });
      await useAppStore.getState().deleteSession('s-2');
      expect(useAppStore.getState().toasts).toHaveLength(0);
    });
  });

  describe('pollActive', () => {
    it('skips setState when fetched sessions are unchanged', async () => {
      const initial = [{ ...mockSession, cwd: '/tmp' }];
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': initial },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      vi.mocked(api.listSessions).mockResolvedValueOnce([{ ...mockSession, cwd: '/tmp' }]);

      const before = useAppStore.getState().sessions['ws-1'];
      await useAppStore.getState().pollActive();
      const after = useAppStore.getState().sessions['ws-1'];

      expect(after).toBe(before);
    });

    it('updates sessions when a title changes', async () => {
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [{ ...mockSession, title: 'Terminal' }] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      vi.mocked(api.listSessions).mockResolvedValueOnce([{ ...mockSession, title: 'Renamed' }]);

      const before = useAppStore.getState().sessions['ws-1'];
      await useAppStore.getState().pollActive();
      const after = useAppStore.getState().sessions['ws-1'];

      expect(after).not.toBe(before);
      expect(after[0].title).toBe('Renamed');
    });

    it('updates sessions when the list length changes', async () => {
      useAppStore.setState({
        workspaces: [mockWorkspace],
        sessions: { 'ws-1': [mockSession] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
      });
      const s2 = { ...mockSession, id: 's-2', title: 'Second' };
      vi.mocked(api.listSessions).mockResolvedValueOnce([mockSession, s2]);

      const before = useAppStore.getState().sessions['ws-1'];
      await useAppStore.getState().pollActive();
      const after = useAppStore.getState().sessions['ws-1'];

      expect(after).not.toBe(before);
      expect(after).toHaveLength(2);
      expect(after[1].id).toBe('s-2');
    });
  });

  describe('setActiveWorkspace clears unread', () => {
    it('clears unread and toasts on the workspace’s remembered session', async () => {
      const ws2 = { ...mockWorkspace, id: 'ws-2', name: 'Other' };
      const s2 = { ...mockSession, id: 's-2', workspaceId: 'ws-2' };
      useAppStore.setState({
        workspaces: [mockWorkspace, ws2],
        sessions: { 'ws-1': [mockSession], 'ws-2': [s2] },
        activeWorkspaceId: 'ws-1',
        activeSessionId: 's-1',
        activeSessionByWorkspace: { 'ws-1': 's-1', 'ws-2': 's-2' },
        sessionActivity: {
          's-2': { unread: true, lastOutputAt: 100, notifiedAt: 100 },
        },
        toasts: [
          { id: 't-1', sessionId: 's-2', workspaceId: 'ws-2', sessionTitle: 'x', createdAt: 100 },
        ],
      });
      await useAppStore.getState().setActiveWorkspace('ws-2');
      const state = useAppStore.getState();
      expect(state.activeWorkspaceId).toBe('ws-2');
      expect(state.activeSessionId).toBe('s-2');
      expect(sessionUnread(state, 's-2')).toBe(false);
      expect(state.toasts).toHaveLength(0);
      // Timestamps preserved — only `unread` flips.
      expect(state.sessionActivity['s-2'].lastOutputAt).toBe(100);
    });
  });
});
