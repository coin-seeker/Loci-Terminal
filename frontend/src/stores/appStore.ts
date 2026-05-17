import { create } from 'zustand';
import type { Workspace, Session } from '../types';
import { api } from '../api/client';

export interface SessionActivity {
  unread: boolean;
  lastOutputAt: number;
  notifiedAt: number;
}

export interface Toast {
  id: string;
  sessionId: string;
  workspaceId: string;
  sessionTitle: string;
  createdAt: number;
}

const MAX_TOASTS = 5;

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

// Shallow equality for the fields pollActive actually reflects in the UI
// (id stability + sidebar subtitle + tab title). pollActive runs every 5s,
// so without this guard every poll creates fresh array/object refs and
// re-renders every Sidebar/TabBar subscriber even when nothing changed.
// JSON.stringify is intentionally avoided — slower and key-order sensitive.
function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (
      ai.id !== bi.id ||
      ai.title !== bi.title ||
      ai.cwd !== bi.cwd ||
      ai.updatedAt !== bi.updatedAt
    ) {
      return false;
    }
  }
  return true;
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
  toasts: Toast[];
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
  dismissToast: (id: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: [],
  sessions: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  activeSessionByWorkspace: {},
  sessionActivity: {},
  toasts: [],
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
      const removedIds = new Set<string>();
      for (const sess of removedSessions) {
        delete sessionActivity[sess.id];
        cancelIdleTracking(sess.id);
        removedIds.add(sess.id);
      }
      const toasts = s.toasts.some((t) => removedIds.has(t.sessionId))
        ? s.toasts.filter((t) => !removedIds.has(t.sessionId))
        : s.toasts;
      return {
        workspaces,
        sessions,
        activeWorkspaceId: nextWid,
        activeSessionId: nextActive,
        activeSessionByWorkspace,
        sessionActivity,
        toasts,
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
      // Switching to a workspace counts as viewing its active session, so
      // clear that session's unread/toasts and any pending idle timer the
      // same way setActiveSession does. Without this, a previously-seen
      // alert resurfaces as soon as the user navigates away and back.
      let sessionActivity = s.sessionActivity;
      let toasts = s.toasts;
      if (nextActive) {
        cancelIdleTracking(nextActive);
        const prev = s.sessionActivity[nextActive];
        if (prev?.unread) {
          sessionActivity = {
            ...s.sessionActivity,
            [nextActive]: { ...prev, unread: false },
          };
        }
        if (toasts.some((t) => t.sessionId === nextActive)) {
          toasts = toasts.filter((t) => t.sessionId !== nextActive);
        }
      }
      return {
        sessions: { ...s.sessions, [id]: sessions },
        activeWorkspaceId: id,
        activeSessionId: nextActive,
        activeSessionByWorkspace: nextActive
          ? { ...s.activeSessionByWorkspace, [id]: nextActive }
          : s.activeSessionByWorkspace,
        sessionActivity,
        toasts,
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
  // Skips setState when the fetched list is structurally identical to the
  // cached one so subscribers don't re-render on every poll tick.
  pollActive: async () => {
    const wid = get().activeWorkspaceId;
    if (!wid) return;
    const sessions = await api.listSessions(wid);
    const existing = get().sessions[wid] ?? [];
    if (sessionsEqual(existing, sessions)) return;
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
      const toasts = s.toasts.some((t) => t.sessionId === id)
        ? s.toasts.filter((t) => t.sessionId !== id)
        : s.toasts;
      return {
        sessions: { ...s.sessions, [wid]: sessions },
        activeSessionId: nextActive,
        activeSessionByWorkspace,
        sessionActivity,
        toasts,
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
      const toasts = s.toasts.some((t) => t.sessionId === id)
        ? s.toasts.filter((t) => t.sessionId !== id)
        : s.toasts;
      return {
        activeSessionId: id,
        activeSessionByWorkspace: wid
          ? { ...s.activeSessionByWorkspace, [wid]: id }
          : s.activeSessionByWorkspace,
        sessionActivity,
        toasts,
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
          const nextActivity = {
            ...s.sessionActivity,
            [sessionId]: {
              unread: true,
              lastOutputAt: t.lastByteAt,
              notifiedAt: t.lastByteAt,
            },
          };
          // Resolve the session's title and parent workspace for the toast.
          // The unread flip is independent: if we can't find the session in
          // the loaded session lists (e.g. data hasn't synced yet) we still
          // light the badge — we just skip the toast for this fire.
          let sessionTitle = '';
          let workspaceId = '';
          for (const [wid, list] of Object.entries(s.sessions)) {
            const found = list.find((sess) => sess.id === sessionId);
            if (found) {
              sessionTitle = found.title;
              workspaceId = wid;
              break;
            }
          }
          if (!workspaceId) {
            return { sessionActivity: nextActivity };
          }
          const toast: Toast = {
            id: `${sessionId}-${t.lastByteAt}`,
            sessionId,
            workspaceId,
            sessionTitle,
            createdAt: t.lastByteAt,
          };
          // Coalesce: replace any existing toast for the same session, then
          // cap the visible stack so a long absence doesn't pile up dozens.
          const filtered = s.toasts.filter((x) => x.sessionId !== sessionId);
          const toasts = [...filtered, toast].slice(-MAX_TOASTS);
          return {
            sessionActivity: nextActivity,
            toasts,
          };
        });
      }, IDLE_MS)
    );
  },

  clearSessionUnread: (sessionId: string) => {
    cancelIdleTracking(sessionId);
    set((s) => {
      const prev = s.sessionActivity[sessionId];
      const hasToast = s.toasts.some((t) => t.sessionId === sessionId);
      if ((!prev || !prev.unread) && !hasToast) return s;
      return {
        sessionActivity:
          prev && prev.unread
            ? { ...s.sessionActivity, [sessionId]: { ...prev, unread: false } }
            : s.sessionActivity,
        toasts: hasToast ? s.toasts.filter((t) => t.sessionId !== sessionId) : s.toasts,
      };
    });
  },

  dismissToast: (id: string) => {
    set((s) => {
      if (!s.toasts.some((t) => t.id === id)) return s;
      return { toasts: s.toasts.filter((t) => t.id !== id) };
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
