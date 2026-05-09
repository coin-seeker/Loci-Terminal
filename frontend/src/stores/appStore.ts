import { create } from 'zustand';
import type { Workspace, Session } from '../types';
import { api } from '../api/client';

export interface SessionActivity {
  unread: boolean;
  lastOutputAt: number;
  notifiedAt: number;
}

// "Idle-after-busy" heuristic: an output burst marks unread only after
// IDLE_MS of silence and only if the burst was longer than MIN_BUSY_MS.
// This filters spinner/cursor noise (which never goes idle and is too
// brief individually) while still catching real task completion — the
// moment a Claude/Codex/build-process stops producing output.
const IDLE_MS = 1500;
const MIN_BUSY_MS = 500;

interface BusyTrack {
  startedAt: number;
  lastByteAt: number;
}

// Module-level transient state — kept outside zustand so per-byte
// bookkeeping doesn't trigger any subscriber re-renders. Zustand state
// only mutates when the idle timer fires and decides to flip `unread`.
const busyTrack = new Map<string, BusyTrack>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelIdleTracking(sessionId: string): void {
  const t = idleTimers.get(sessionId);
  if (t !== undefined) {
    clearTimeout(t);
    idleTimers.delete(sessionId);
  }
  busyTrack.delete(sessionId);
}

// Test-only escape hatch: the module-level Maps survive `useAppStore.setState`
// resets in test setup, so tests need an explicit way to clear them.
export function __resetActivityTrackingForTests(): void {
  for (const t of idleTimers.values()) clearTimeout(t);
  idleTimers.clear();
  busyTrack.clear();
}

interface AppState {
  workspaces: Workspace[];
  sessions: Record<string, Session[]>;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  // Last active session per workspace. Used both to restore the right tab when
  // switching workspaces and to pick which session's CWD the sidebar shows.
  activeSessionByWorkspace: Record<string, string>;
  sessionActivity: Record<string, SessionActivity>;
  initialized: boolean;

  init: () => Promise<void>;
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  setActiveWorkspace: (id: string) => Promise<void>;

  fetchSessions: (workspaceId: string) => Promise<void>;
  pollActive: () => Promise<void>;
  createSession: (workspaceId: string, title?: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  setActiveSession: (id: string) => void;

  markSessionOutput: (sessionId: string) => void;
  clearSessionUnread: (sessionId: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: [],
  sessions: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  activeSessionByWorkspace: {},
  sessionActivity: {},
  initialized: false,

  init: async () => {
    let workspaces = await api.listWorkspaces();

    if (workspaces.length === 0) {
      const ws = await api.createWorkspace('Default');
      workspaces = [ws];
    }

    // Fetch all workspaces' sessions in parallel so the sidebar can show CWD
    // for every workspace, not just the active one.
    const lists = await Promise.all(workspaces.map((w) => api.listSessions(w.id)));
    const sessions: Record<string, Session[]> = {};
    const activeSessionByWorkspace: Record<string, string> = {};
    workspaces.forEach((w, i) => {
      sessions[w.id] = lists[i];
      if (lists[i].length > 0) {
        activeSessionByWorkspace[w.id] = lists[i][0].id;
      }
    });

    const wid = workspaces[0].id;
    if (sessions[wid].length === 0) {
      const sess = await api.createSession(wid);
      sessions[wid] = [sess];
      activeSessionByWorkspace[wid] = sess.id;
    }

    set({
      workspaces,
      sessions,
      activeWorkspaceId: wid,
      activeSessionId: activeSessionByWorkspace[wid] ?? null,
      activeSessionByWorkspace,
      initialized: true,
    });
  },

  fetchWorkspaces: async () => {
    const workspaces = await api.listWorkspaces();
    set({ workspaces });
  },

  createWorkspace: async (name: string) => {
    const ws = await api.createWorkspace(name);
    const sess = await api.createSession(ws.id);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      sessions: { ...s.sessions, [ws.id]: [sess] },
      activeWorkspaceId: ws.id,
      activeSessionId: sess.id,
      activeSessionByWorkspace: { ...s.activeSessionByWorkspace, [ws.id]: sess.id },
    }));
  },

  deleteWorkspace: async (id: string) => {
    await api.deleteWorkspace(id);
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const removedSessions = s.sessions[id] ?? [];
      const sessions = { ...s.sessions };
      delete sessions[id];
      const activeSessionByWorkspace = { ...s.activeSessionByWorkspace };
      delete activeSessionByWorkspace[id];
      const nextWid = workspaces.length > 0 ? workspaces[0].id : null;
      const nextActive = nextWid ? activeSessionByWorkspace[nextWid] ?? sessions[nextWid]?.[0]?.id ?? null : null;
      const sessionActivity = { ...s.sessionActivity };
      for (const sess of removedSessions) {
        delete sessionActivity[sess.id];
        cancelIdleTracking(sess.id);
      }
      return {
        workspaces,
        sessions,
        activeWorkspaceId: nextWid,
        activeSessionId: nextActive,
        activeSessionByWorkspace,
        sessionActivity,
      };
    });
  },

  renameWorkspace: async (id: string, name: string) => {
    const updated = await api.updateWorkspace(id, name);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? updated : w)),
    }));
  },

  setActiveWorkspace: async (id: string) => {
    const state = get();
    let sessions = state.sessions[id];
    if (!sessions) {
      sessions = await api.listSessions(id);
    }
    set((s) => {
      const remembered = s.activeSessionByWorkspace[id];
      const stillExists = remembered && sessions.some((sess) => sess.id === remembered);
      const nextActive = stillExists ? remembered : sessions[0]?.id ?? null;
      return {
        sessions: { ...s.sessions, [id]: sessions },
        activeWorkspaceId: id,
        activeSessionId: nextActive,
        activeSessionByWorkspace: nextActive
          ? { ...s.activeSessionByWorkspace, [id]: nextActive }
          : s.activeSessionByWorkspace,
      };
    });
  },

  fetchSessions: async (workspaceId: string) => {
    const sessions = await api.listSessions(workspaceId);
    set((s) => ({
      sessions: { ...s.sessions, [workspaceId]: sessions },
    }));
  },

  // Refresh the active workspace's session list — primarily to pick up CWD
  // changes for the sidebar subtitle. Called on a 5s interval from App.tsx.
  pollActive: async () => {
    const wid = get().activeWorkspaceId;
    if (!wid) return;
    const sessions = await api.listSessions(wid);
    set((s) => ({
      sessions: { ...s.sessions, [wid]: sessions },
    }));
  },

  createSession: async (workspaceId: string, title?: string) => {
    const sess = await api.createSession(workspaceId, title);
    set((s) => ({
      sessions: {
        ...s.sessions,
        [workspaceId]: [...(s.sessions[workspaceId] || []), sess],
      },
      activeSessionId: sess.id,
      activeSessionByWorkspace: { ...s.activeSessionByWorkspace, [workspaceId]: sess.id },
    }));
  },

  deleteSession: async (id: string) => {
    await api.deleteSession(id);
    cancelIdleTracking(id);
    set((s) => {
      const wid = s.activeWorkspaceId;
      if (!wid) return s;
      const sessions = (s.sessions[wid] || []).filter((sess) => sess.id !== id);
      const wasActive = s.activeSessionId === id;
      const nextActive = wasActive ? sessions[0]?.id ?? null : s.activeSessionId;
      const activeSessionByWorkspace = { ...s.activeSessionByWorkspace };
      if (activeSessionByWorkspace[wid] === id) {
        if (nextActive) {
          activeSessionByWorkspace[wid] = nextActive;
        } else {
          delete activeSessionByWorkspace[wid];
        }
      }
      const sessionActivity = { ...s.sessionActivity };
      delete sessionActivity[id];
      return {
        sessions: { ...s.sessions, [wid]: sessions },
        activeSessionId: nextActive,
        activeSessionByWorkspace,
        sessionActivity,
      };
    });
  },

  renameSession: async (id: string, title: string) => {
    const updated = await api.updateSession(id, title);
    set((s) => {
      const wid = s.activeWorkspaceId;
      if (!wid) return s;
      return {
        sessions: {
          ...s.sessions,
          [wid]: (s.sessions[wid] || []).map((sess) =>
            sess.id === id ? updated : sess
          ),
        },
      };
    });
  },

  setActiveSession: (id: string) => {
    cancelIdleTracking(id);
    set((s) => {
      const wid = s.activeWorkspaceId;
      const prev = s.sessionActivity[id];
      const sessionActivity =
        prev && prev.unread
          ? { ...s.sessionActivity, [id]: { ...prev, unread: false } }
          : s.sessionActivity;
      return {
        activeSessionId: id,
        activeSessionByWorkspace: wid
          ? { ...s.activeSessionByWorkspace, [wid]: id }
          : s.activeSessionByWorkspace,
        sessionActivity,
      };
    });
  },

  // Idle-after-busy: each output chunk only updates the in-memory busy
  // tracker and resets a debounce timer. The store mutates (and Sidebar /
  // TabBar re-render) only when IDLE_MS of silence follows a burst longer
  // than MIN_BUSY_MS — i.e. when an agent / build / shell command has
  // genuinely finished, not while a spinner is animating.
  markSessionOutput: (sessionId: string) => {
    const state = get();
    const isActiveForeground =
      sessionId === state.activeSessionId &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible';
    if (isActiveForeground) {
      cancelIdleTracking(sessionId);
      return;
    }

    const now = Date.now();
    const track = busyTrack.get(sessionId);
    if (track) {
      track.lastByteAt = now;
    } else {
      busyTrack.set(sessionId, { startedAt: now, lastByteAt: now });
    }

    const existing = idleTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);

    idleTimers.set(
      sessionId,
      setTimeout(() => {
        idleTimers.delete(sessionId);
        const t = busyTrack.get(sessionId);
        busyTrack.delete(sessionId);
        if (!t) return;
        // Burst length is wall time between first and last byte of this
        // burst — NOT the time the timer waited. A single stray byte has
        // length 0 and never qualifies; a 600ms streaming chunk does.
        if (t.lastByteAt - t.startedAt < MIN_BUSY_MS) return;

        // Re-check at fire time — the user may have switched to this
        // session, or the tab may have returned to foreground, while the
        // idle window was elapsing.
        const fresh = get();
        const stillBackground =
          sessionId !== fresh.activeSessionId ||
          (typeof document !== 'undefined' &&
            document.visibilityState !== 'visible');
        if (!stillBackground) return;

        set((s) => {
          const prev = s.sessionActivity[sessionId];
          if (prev?.unread) return s;
          return {
            sessionActivity: {
              ...s.sessionActivity,
              [sessionId]: {
                unread: true,
                lastOutputAt: t.lastByteAt,
                notifiedAt: prev?.notifiedAt ?? 0,
              },
            },
          };
        });
      }, IDLE_MS)
    );
  },

  clearSessionUnread: (sessionId: string) => {
    cancelIdleTracking(sessionId);
    set((s) => {
      const prev = s.sessionActivity[sessionId];
      if (!prev || !prev.unread) return s;
      return {
        sessionActivity: {
          ...s.sessionActivity,
          [sessionId]: { ...prev, unread: false },
        },
      };
    });
  },
}));

export function sessionUnread(state: AppState, sessionId: string): boolean {
  return state.sessionActivity[sessionId]?.unread === true;
}

export function workspaceUnread(state: AppState, workspaceId: string): boolean {
  const list = state.sessions[workspaceId];
  if (!list) return false;
  for (const s of list) {
    if (state.sessionActivity[s.id]?.unread === true) return true;
  }
  return false;
}
