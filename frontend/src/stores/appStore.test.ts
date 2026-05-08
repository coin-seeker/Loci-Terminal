import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from './appStore';

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

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [],
      sessions: {},
      activeWorkspaceId: null,
      activeSessionId: null,
      initialized: false,
    });
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
});
