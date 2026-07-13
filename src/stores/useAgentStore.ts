import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ClaudeEvent } from "@/types/claude-events";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * A subagent spawned by a Claude Code session (a `Task` tool invocation
 * detected in the session's transcript). Completion arrives as the
 * `SubagentCompleted` event the transcript watcher emits when the Task's
 * tool_result appears.
 */
export interface SubagentInfo {
  /** The Task tool_use id — unique per spawn. */
  agentId: string;
  /** Maestro session (terminal) the agent runs inside. */
  sessionId: number;
  agentType: string;
  description: string;
  /** Transcript timestamp of the spawn. */
  spawnedAt: string;
  /** Epoch ms of completion; null while running. Derived from the transcript
   *  timestamp so replayed history is pruned quickly instead of lingering. */
  completedAt: number | null;
  /** Whether the Task tool_result reported success; null while running. */
  success: boolean | null;
}

/** How long a completed agent stays visible with a DONE badge. */
export const AGENT_DONE_LINGER_MS = 60_000;
const PRUNE_INTERVAL_MS = 10_000;

interface AgentState {
  agents: SubagentInfo[];
  handleEvent: (event: ClaudeEvent) => void;
  /** Drop completed agents past their linger window and orphans of dead sessions. */
  prune: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],

  handleEvent: (event: ClaudeEvent) => {
    switch (event.event_type) {
      case "SubagentSpawned":
        set((state) => {
          if (state.agents.some((a) => a.agentId === event.agent_id)) return state;
          return {
            agents: [
              ...state.agents,
              {
                agentId: event.agent_id,
                sessionId: event.session_id,
                agentType: event.agent_type,
                description: event.description,
                spawnedAt: event.timestamp,
                completedAt: null,
                success: null,
              },
            ],
          };
        });
        break;
      case "SubagentCompleted":
        set((state) => {
          if (
            !state.agents.some((a) => a.agentId === event.agent_id && a.completedAt === null)
          ) {
            return state;
          }
          // Use the transcript timestamp: catch-up reads replay old history,
          // and a wall-clock stamp would parade long-finished agents through
          // the sidebar for the full linger window on every session resume.
          const parsed = Date.parse(event.timestamp);
          const completedAt = Number.isNaN(parsed) ? Date.now() : parsed;
          return {
            agents: state.agents.map((a) =>
              a.agentId === event.agent_id && a.completedAt === null
                ? { ...a, completedAt, success: event.success }
                : a
            ),
          };
        });
        break;
      default:
        break;
    }
  },

  prune: () => {
    const now = Date.now();
    const liveSessionIds = new Set(useSessionStore.getState().sessions.map((s) => s.id));
    const { agents } = get();
    const kept = agents.filter(
      (a) =>
        liveSessionIds.has(a.sessionId) &&
        (a.completedAt === null || now - a.completedAt < AGENT_DONE_LINGER_MS)
    );
    if (kept.length !== agents.length) set({ agents: kept });
  },
}));

// Global event listener. `active` tracks the *desired* state so an init/stop
// pair that races the pending listen() promise (React StrictMode's dev
// double-mount) can't leak a second listener or prune interval.
let unlisten: UnlistenFn | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let starting: Promise<void> | null = null;
let active = false;

export async function initAgentListener(): Promise<void> {
  active = true;
  if (unlisten || starting) return;
  starting = listen<ClaudeEvent>("claude-event", (event) => {
    useAgentStore.getState().handleEvent(event.payload);
  })
    .then((fn) => {
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
      pruneTimer ??= setInterval(() => {
        useAgentStore.getState().prune();
      }, PRUNE_INTERVAL_MS);
    })
    .finally(() => {
      starting = null;
    });
  await starting;
}

export function stopAgentListener(): void {
  active = false;
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
