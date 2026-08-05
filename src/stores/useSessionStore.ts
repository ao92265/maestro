import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { samePath } from "@/lib/path";
import { useAgentStore } from "@/stores/useAgentStore";

/** AI provider variants supported by the backend orchestrator. */
export type AiMode = "Claude" | "Gemini" | "Codex" | "OpenCode" | "Plain";

/**
 * Backend-emitted session lifecycle states.
 * Must stay in sync with the Rust `SessionStatus` enum.
 * "Timeout" is a frontend-only status for sessions stuck in Starting state.
 */
export type BackendSessionStatus =
  | "Starting"
  | "Idle"
  | "Working"
  | "NeedsInput"
  | "Done"
  | "Error"
  | "Timeout";

/** Timeout in milliseconds for sessions stuck in Starting state (Bug #74) */
const SESSION_STARTUP_TIMEOUT_MS = 30000;

/**
 * Mirrors the Rust `SessionConfig` struct returned by `get_sessions`.
 *
 * @property id - Unique numeric session ID assigned by the backend.
 * @property branch - Git branch the session operates on, or null for the default branch.
 * @property worktree_path - Filesystem path to the git worktree, if one was created.
 * @property project_path - Canonicalized project directory this session belongs to.
 * @property statusMessage - Brief description of what the agent is doing (from MCP status).
 * @property needsInputPrompt - When status is NeedsInput, the specific question for the user.
 */
export interface SessionConfig {
  id: number;
  mode: AiMode;
  name?: string | null;
  branch: string | null;
  status: BackendSessionStatus;
  worktree_path: string | null;
  project_path: string;
  /** The actual directory the shell was spawned in (may differ from project_path in multi-repo workspaces). */
  working_directory?: string | null;
  statusMessage?: string;
  needsInputPrompt?: string;
  /** Timestamp of the last MCP-driven status update (used by activity heuristic). */
  lastMcpUpdateTime?: number;
}

/** Shape of the Tauri `session-status-changed` event payload. */
interface SessionStatusPayload {
  session_id: number;
  project_path: string;
  status: BackendSessionStatus;
  message?: string;
  needs_input_prompt?: string;
}

/**
 * Raw wire payload for `session-status-changed`. The Claude Stop hook emits
 * "AwaitingInput" (agent ended its turn, user's move); it is normalized to
 * NeedsInput before it reaches the store, so it never appears in a session.
 */
type RawSessionStatusPayload = Omit<SessionStatusPayload, "status"> & {
  status: BackendSessionStatus | "AwaitingInput";
};

/**
 * Zustand store slice for session metadata (not PTY I/O -- that lives in terminal.ts).
 *
 * @property sessions - Authoritative list of sessions fetched from the backend.
 * @property fetchSessions - Performs a one-shot IPC fetch to replace the session list.
 * @property initListeners - Subscribes to the global `session-status-changed` Tauri event.
 *   Returns an unlisten function; callers must invoke the cleanup to decrement
 *   a reference count and remove the listener when the last subscriber exits.
 */
interface SessionState {
  sessions: SessionConfig[];
  /**
   * Sessions hidden ("parked") from the terminal grids. The PTY keeps
   * running; only the pane is CSS-hidden. In-memory only — session IDs are
   * ephemeral (reassigned each app launch), so persisting them to disk would
   * hide unrelated future sessions that reuse the same numbers.
   */
  parkedSessionIds: number[];
  /**
   * Sessions the user flagged as "warning" by clicking the terminal header or
   * tab strip — their chrome renders yellow. In-memory only, same rationale
   * as parkedSessionIds: session IDs are reassigned each app launch.
   */
  flaggedSessionIds: number[];
  /**
   * Sessions that were auto-unparked because their agent stopped and asked
   * for input while parked. Rendered as a yellow "attention" highlight on the
   * session's header and tabs (same styling as the manual warning flag) until
   * the user focuses/selects the session. In-memory only, same rationale as
   * parkedSessionIds.
   */
  attentionSessionIds: number[];
  isLoading: boolean;
  error: string | null;
  parkSession: (sessionId: number) => void;
  unparkSession: (sessionId: number) => void;
  toggleSessionFlag: (sessionId: number) => void;
  clearSessionAttention: (sessionId: number) => void;
  fetchSessions: () => Promise<void>;
  fetchSessionsForProject: (projectPath: string) => Promise<void>;
  addSession: (session: SessionConfig) => void;
  removeSession: (sessionId: number) => void;
  removeSessionsForProject: (projectPath: string) => Promise<SessionConfig[]>;
  updateSession: (sessionId: number, updates: Partial<SessionConfig>) => void;
  renameSession: (sessionId: number, name: string | null) => Promise<void>;
  getSessionsByProject: (projectPath: string) => SessionConfig[];
  initListeners: () => Promise<UnlistenFn>;
}

/**
 * Global session store. Not persisted — sessions are ephemeral and
 * re-fetched from the backend on app launch via `fetchSessions`.
 */
let listenerCount = 0;
let pendingInit: Promise<void> | null = null;
let activeUnlisten: UnlistenFn | null = null;

/**
 * Buffer for status events that arrive before their session is added to the store.
 * Key is "session_id:project_path", value is the latest status payload for that session.
 */
const pendingStatusUpdates: Map<string, SessionStatusPayload> = new Map();

/**
 * Tracks startup timeout timers for sessions (Bug #74).
 * Key is session ID, value is the timeout handle.
 * When a session transitions out of "Starting" state, its timer is cleared.
 */
const startupTimeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();

/** Generate a unique key for buffering status updates */
function statusBufferKey(sessionId: number, projectPath: string): string {
  return `${sessionId}:${projectPath}`;
}

/**
 * Clears the startup timeout for a session.
 * Called when session transitions out of "Starting" state.
 */
function clearStartupTimeout(sessionId: number): void {
  const timer = startupTimeouts.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    startupTimeouts.delete(sessionId);
  }
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  parkedSessionIds: [],
  flaggedSessionIds: [],
  attentionSessionIds: [],
  isLoading: false,
  error: null,

  parkSession: (sessionId: number) => {
    set((state) => {
      const alreadyParked = state.parkedSessionIds.includes(sessionId);
      const hasAttention = state.attentionSessionIds.includes(sessionId);
      // No-op guard: don't replace arrays (and re-render subscribers)
      // when nothing changes.
      if (alreadyParked && !hasAttention) return state;
      return {
        parkedSessionIds: alreadyParked
          ? state.parkedSessionIds
          : [...state.parkedSessionIds, sessionId],
        // Parking is a deliberate act on the session — an auto-unpark
        // attention highlight would be stale once it's hidden again.
        attentionSessionIds: hasAttention
          ? state.attentionSessionIds.filter((id) => id !== sessionId)
          : state.attentionSessionIds,
      };
    });
  },

  unparkSession: (sessionId: number) => {
    set((state) => ({
      parkedSessionIds: state.parkedSessionIds.filter((id) => id !== sessionId),
    }));
  },

  toggleSessionFlag: (sessionId: number) => {
    set((state) => ({
      flaggedSessionIds: state.flaggedSessionIds.includes(sessionId)
        ? state.flaggedSessionIds.filter((id) => id !== sessionId)
        : [...state.flaggedSessionIds, sessionId],
    }));
  },

  clearSessionAttention: (sessionId: number) => {
    set((state) =>
      state.attentionSessionIds.includes(sessionId)
        ? {
            attentionSessionIds: state.attentionSessionIds.filter(
              (id) => id !== sessionId
            ),
          }
        : state
    );
  },

  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await invoke<SessionConfig[]>("get_sessions");
      set((state) => ({
        sessions,
        isLoading: false,
        // Prune parked/flagged/attention IDs that no longer exist in the fetched list
        parkedSessionIds: state.parkedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        flaggedSessionIds: state.flaggedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        attentionSessionIds: state.attentionSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
      }));
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
      set({ error: String(err), isLoading: false });
    }
  },

  fetchSessionsForProject: async (projectPath: string) => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await invoke<SessionConfig[]>("get_sessions_for_project", {
        projectPath,
      });
      set((state) => ({
        sessions,
        isLoading: false,
        // Prune parked/flagged/attention IDs that no longer exist in the fetched list
        parkedSessionIds: state.parkedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        flaggedSessionIds: state.flaggedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        attentionSessionIds: state.attentionSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
      }));
    } catch (err) {
      console.error("Failed to fetch sessions for project:", err);
      set({ error: String(err), isLoading: false });
    }
  },

  addSession: (session: SessionConfig) => {
    // Clear any stale buffered status for this session ID across ALL projects
    // This prevents pollution from old sessions with the same ID
    for (const key of pendingStatusUpdates.keys()) {
      if (key.startsWith(`${session.id}:`)) {
        console.log(`[SessionStore] Clearing stale buffered status for key: '${key}'`);
        pendingStatusUpdates.delete(key);
      }
    }

    // Check if we have a buffered status update for this session
    const bufferKey = statusBufferKey(session.id, session.project_path);
    const bufferedStatus = pendingStatusUpdates.get(bufferKey);

    console.log(`[SessionStore] addSession id=${session.id} project_path='${session.project_path}'`);
    console.log(`[SessionStore] Buffer key: '${bufferKey}', has buffered status: ${!!bufferedStatus}`);
    if (pendingStatusUpdates.size > 0) {
      console.log("[SessionStore] All buffered keys:", Array.from(pendingStatusUpdates.keys()));
    }

    if (bufferedStatus) {
      pendingStatusUpdates.delete(bufferKey);
      console.log(`[SessionStore] Applying buffered status: ${bufferedStatus.status}`);
      // Apply the buffered status to the session before adding
      session = {
        ...session,
        status: bufferedStatus.status,
        statusMessage: bufferedStatus.message,
        needsInputPrompt: bufferedStatus.needs_input_prompt,
      };
    }

    // Start a timeout timer for sessions in "Starting" state (Bug #74)
    // If no status update is received within the timeout, mark as "Timeout"
    if (session.status === "Starting") {
      // Clear any existing timeout for this session (shouldn't happen, but be safe)
      clearStartupTimeout(session.id);

      const timeoutTimer = setTimeout(() => {
        startupTimeouts.delete(session.id);
        // Check if session is still in Starting state
        const currentState = get();
        const currentSession = currentState.sessions.find((s) => s.id === session.id);
        if (currentSession && currentSession.status === "Starting") {
          console.warn(`[SessionStore] Session ${session.id} startup timeout after ${SESSION_STARTUP_TIMEOUT_MS}ms`);
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === session.id
                ? {
                    ...s,
                    status: "Timeout" as BackendSessionStatus,
                    statusMessage: "CLI failed to start - check terminal for errors",
                  }
                : s
            ),
          }));
        }
      }, SESSION_STARTUP_TIMEOUT_MS);

      startupTimeouts.set(session.id, timeoutTimer);
    }

    set((state) => {
      // Don't add if session already exists
      if (state.sessions.some((s) => s.id === session.id)) {
        return state;
      }
      return { sessions: [...state.sessions, session] };
    });
  },

  updateSession: (sessionId: number, updates: Partial<SessionConfig>) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...updates } : s
      ),
    }));
  },

  renameSession: async (sessionId: number, name: string | null) => {
    try {
      const updated = await invoke<SessionConfig>("rename_session", {
        sessionId,
        name,
      });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, name: updated.name } : s
        ),
      }));
    } catch (err) {
      console.error("Failed to rename session:", err);
    }
  },

  removeSession: (sessionId: number) => {
    // Clear any startup timeout for this session
    clearStartupTimeout(sessionId);

    // Clear any buffered status for this session to prevent pollution on restart
    const sessionsToRemove = get().sessions.filter((s) => s.id === sessionId);
    for (const session of sessionsToRemove) {
      const bufferKey = statusBufferKey(session.id, session.project_path);
      pendingStatusUpdates.delete(bufferKey);
    }

    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
      parkedSessionIds: state.parkedSessionIds.filter((id) => id !== sessionId),
      flaggedSessionIds: state.flaggedSessionIds.filter((id) => id !== sessionId),
      attentionSessionIds: state.attentionSessionIds.filter((id) => id !== sessionId),
    }));
  },

  removeSessionsForProject: async (projectPath: string) => {
    try {
      const removed = await invoke<SessionConfig[]>("remove_sessions_for_project", {
        projectPath,
      });
      // Remove the sessions from local state
      set((state) => ({
        sessions: state.sessions.filter(
          (s) => !removed.some((r) => r.id === s.id)
        ),
        parkedSessionIds: state.parkedSessionIds.filter(
          (id) => !removed.some((r) => r.id === id)
        ),
        flaggedSessionIds: state.flaggedSessionIds.filter(
          (id) => !removed.some((r) => r.id === id)
        ),
        attentionSessionIds: state.attentionSessionIds.filter(
          (id) => !removed.some((r) => r.id === id)
        ),
      }));
      return removed;
    } catch (err) {
      console.error("Failed to remove sessions for project:", err);
      return [];
    }
  },

  getSessionsByProject: (projectPath: string) => {
    return get().sessions.filter((s) => samePath(s.project_path, projectPath));
  },

  initListeners: async () => {
    listenerCount += 1;
    try {
      if (!activeUnlisten) {
        if (!pendingInit) {
          pendingInit = listen<RawSessionStatusPayload>("session-status-changed", (event) => {
            const { session_id, project_path, message, needs_input_prompt } = event.payload;

            // Normalize the Stop-hook signal: treat "AwaitingInput" as
            // NeedsInput, but never downgrade an explicit terminal state
            // (Done/Error) or a startup Timeout the agent/frontend already set.
            let status: BackendSessionStatus;
            let statusMessage = message;
            if (event.payload.status === "AwaitingInput") {
              const existing = get().sessions.find(
                (s) => s.id === session_id && s.project_path === project_path
              );
              if (existing && ["Done", "Error", "Timeout"].includes(existing.status)) {
                return;
              }
              // The Stop hook fires whenever the agent ends its turn — including
              // when it ends the turn precisely because it handed work off to
              // background subagents. Those are still running, so the session is
              // working, not waiting on the user. Self-correcting: the next turn
              // end, once no subagent is running, reports NeedsInput as normal.
              const runningSubagents = useAgentStore
                .getState()
                .agents.filter((a) => a.sessionId === session_id && a.completedAt === null).length;
              if (runningSubagents > 0) {
                status = "Working";
                statusMessage = `${runningSubagents} subagent${
                  runningSubagents === 1 ? "" : "s"
                } running`;
              } else {
                status = "NeedsInput";
              }
            } else {
              status = event.payload.status;
            }

            // Check if session exists in store
            const sessionExists = get().sessions.some(
              (s) => s.id === session_id && s.project_path === project_path
            );

            if (!sessionExists) {
              // Buffer this status update - it will be applied when the session is added
              const bufferKey = statusBufferKey(session_id, project_path);
              console.log(`[SessionStore] Buffering status for non-existent session. Key: '${bufferKey}'`);
              pendingStatusUpdates.set(bufferKey, {
                ...event.payload,
                status,
                message: statusMessage,
              });
              return;
            }

            // Clear startup timeout when session transitions out of Starting state (Bug #74)
            if (status !== "Starting") {
              clearStartupTimeout(session_id);
            }

            set((state) => {
              // Auto-unpark on the TRANSITION into NeedsInput: a parked agent
              // that stops and asks for the user must come back into view,
              // marked for attention (yellow chrome) until the user selects
              // it. Edge-triggered on purpose — if the user re-parks the
              // still-NeedsInput session, repeated NeedsInput events are not
              // a new transition and must not undo that manual choice.
              const existing = state.sessions.find(
                (s) => s.id === session_id && s.project_path === project_path
              );
              const autoUnpark =
                existing !== undefined &&
                status === "NeedsInput" &&
                existing.status !== "NeedsInput" &&
                state.parkedSessionIds.includes(session_id);

              return {
                sessions: state.sessions.map((s) =>
                  s.id === session_id && s.project_path === project_path
                    ? {
                        ...s,
                        status,
                        statusMessage,
                        needsInputPrompt: needs_input_prompt,
                        lastMcpUpdateTime: Date.now(),
                      }
                    : s
                ),
                ...(autoUnpark
                  ? {
                      parkedSessionIds: state.parkedSessionIds.filter(
                        (id) => id !== session_id
                      ),
                      attentionSessionIds: state.attentionSessionIds.includes(
                        session_id
                      )
                        ? state.attentionSessionIds
                        : [...state.attentionSessionIds, session_id],
                    }
                  : {}),
              };
            });
          })
            .then((unlisten) => {
              activeUnlisten = unlisten;
            })
            .finally(() => {
              pendingInit = null;
            });
        }
        await pendingInit;
      }
    } catch (err) {
      listenerCount = Math.max(0, listenerCount - 1);
      throw err;
    }

    return () => {
      listenerCount = Math.max(0, listenerCount - 1);
      if (listenerCount === 0 && activeUnlisten) {
        activeUnlisten();
        activeUnlisten = null;
      }
    };
  },
}));

