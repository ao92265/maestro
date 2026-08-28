import { create } from "zustand";

import {
  buildGoalPrompt,
  buildOrchestratorBrief,
  controlSequence,
  orchestratorClear,
  orchestratorDecide,
  orchestratorDropDir,
  orchestratorIngest,
  orchestratorMark,
  orchestratorSetSafeMode,
  orchestratorSetScope,
  type Proposal,
  type ScopeEntry,
} from "@/lib/orchestrator";
import { writeStdin } from "@/lib/terminal";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";

/**
 * Orchestrator lane state: the proposal queue, safe mode, the operator's
 * session scope, and the one session the orchestrator itself runs in.
 *
 * The safety property this store exists to hold: `decide` is the ONLY place
 * that ever writes to another session. `refresh` polls and renders, it never
 * delivers — a poll that could send is a poll that can double-send when two
 * views are mounted. Free-run mode moves the approval into Rust (proposals
 * arrive already approved); it does not add a second delivery path.
 *
 * Failure convention follows the ACT lane: a failed poll keeps the last good
 * queue and records the error, rather than blanking a queue the operator is
 * mid-decision on.
 */

/** Terminal name the orchestrator session launches under, and is found again by. */
export const ORCHESTRATOR_SESSION_NAME = "orchestrator";

/** Brief file stem under `<briefDir>/.maestro/briefs/`. */
const BRIEF_STEM = "orchestrator-brief";

interface OrchestratorState {
  proposals: Proposal[];
  safeMode: boolean;
  scope: ScopeEntry[];
  /** The orchestrator's own session id, once its terminal is up. */
  sessionId: number | null;
  /** Last poll or delivery failure, cleared by the next success. */
  error: string | null;
  refresh: () => Promise<void>;
  setSafeMode: (on: boolean) => Promise<void>;
  setScope: (scope: ScopeEntry[]) => Promise<void>;
  decide: (id: number, approve: boolean) => Promise<void>;
  /** Adopt (or forget) the running orchestrator terminal. */
  setSessionId: (sessionId: number | null) => void;
  /** Hand the running orchestrator a goal. False when no session is attached. */
  sendGoal: (goal: string) => Promise<boolean>;
  /**
   * Queue the orchestrator's own launch into a project tab's grid. An optional
   * first goal rides in with the brief, so one click both starts it and sets
   * it going (rohcna's "panel opens; first goal starts the session").
   */
  launch: (tabId: string, projectPath: string, goal?: string) => Promise<void>;
  /** Fresh start: drop the queue and the scope, keep the terminal. */
  clear: () => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  proposals: [],
  safeMode: true,
  scope: [],
  sessionId: null,
  error: null,

  refresh: async () => {
    try {
      const queue = await orchestratorIngest();
      set({
        proposals: queue.proposals,
        safeMode: queue.safeMode,
        scope: queue.scope,
        error: null,
      });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  setSafeMode: async (on) => {
    try {
      // The flag Rust persisted, not the one that was asked for: a failed
      // write must never leave the toggle reading "free run" while the queue
      // is still gating every proposal.
      const safeMode = await orchestratorSetSafeMode(on);
      set({ safeMode, error: null });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  setScope: async (scope) => {
    try {
      await orchestratorSetScope(scope);
      set({ scope, error: null });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  decide: async (id, approve) => {
    let decision: Awaited<ReturnType<typeof orchestratorDecide>>;
    try {
      decision = await orchestratorDecide(id, approve);
    } catch (error) {
      set({ error: message(error) });
      return;
    }
    // `dispatch` is Rust's verdict on whether this approval is still live
    // (pending, inside its TTL, target in scope). Re-deriving it here would
    // give the queue two decision points that can disagree.
    if (decision.dispatch) {
      const { proposal } = decision;
      try {
        // The orchestrator must never be its own target: it would wake itself,
        // propose again off its own nudge, and fill the queue with its echo.
        // Rust cannot catch this — only the frontend knows which session the
        // orchestrator is running in.
        if (proposal.targetSessionId === get().sessionId) {
          throw new Error("refused: a proposal cannot target the orchestrator itself");
        }
        const keys = proposal.key ? controlSequence(proposal.key) : null;
        if (proposal.key && !keys) throw new Error(`unsupported control key: ${proposal.key}`);
        if (keys) {
          await writeStdin(proposal.targetSessionId, keys);
        } else {
          // Text and submit are separate writes: writeStdin serializes per
          // session, so they land in order without racing the PTY.
          await writeStdin(proposal.targetSessionId, proposal.text);
          await writeStdin(proposal.targetSessionId, "\r");
        }
        await orchestratorMark(id, "sent", null);
      } catch (error) {
        // A dead target must read as a failed delivery, never as a sent one.
        await orchestratorMark(id, "error", message(error)).catch(() => {});
        set({ error: message(error) });
      }
    }
    await get().refresh();
  },

  setSessionId: (sessionId) => set({ sessionId }),

  sendGoal: async (goal) => {
    const { sessionId, scope } = get();
    if (sessionId === null || !goal.trim()) return false;
    try {
      // Collapsed to one line for the same reason the backend collapses an
      // armed prompt: a newline mid-message submits half of it.
      const prompt = buildGoalPrompt(goal, scope).replace(/\s+/g, " ").trim();
      await writeStdin(sessionId, prompt);
      await writeStdin(sessionId, "\r");
      set({ error: null });
      return true;
    } catch (error) {
      set({ error: message(error) });
      return false;
    }
  },

  launch: async (tabId, projectPath, goal) => {
    try {
      const scope = get().scope;
      const dropDir = await orchestratorDropDir();
      const brief = buildOrchestratorBrief(dropDir, scope);
      const firstGoal = goal?.trim()
        ? `\n\n## Your first goal\n\n${buildGoalPrompt(goal, scope)}`
        : "";
      // The brief goes out as a FILE and a one-line pointer: typed inline it
      // would be whitespace-collapsed, flattening its JSON examples.
      usePendingLaunchStore.getState().request({
        tabId,
        mode: "Claude",
        resumeSessionId: null,
        workingDirOverride: null,
        branch: null,
        customName: ORCHESTRATOR_SESSION_NAME,
        initialPrompt: `${brief}${firstGoal}`,
        briefDir: projectPath,
        briefStem: BRIEF_STEM,
      });
      set({ error: null });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  clear: async () => {
    try {
      await orchestratorClear();
      set({ proposals: [], scope: [], error: null });
    } catch (error) {
      set({ error: message(error) });
    }
  },
}));
