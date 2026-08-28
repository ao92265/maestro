import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  ACT_SUBSYSTEMS,
  type ActAutonomyPatch,
  type ActBudget,
  type ActInterventionEvent,
  type ActInterventionRule,
  type ActLedgerEntry,
  type ActPolicySnapshot,
  type ActReplay,
  type ActReplayEvent,
  type SubsystemKey,
  type SubsystemReads,
} from "@/lib/actControl";

/**
 * Control-panel state: ACT's six read-only subsystems plus the one write the
 * panel is allowed to make (the autonomy ladder).
 *
 * Each subsystem is polled and recorded INDEPENDENTLY. ACT serves these from
 * six different routes and an older engine can answer five of them; folding
 * them into one error would blank a panel that is mostly fine. The rohcna
 * ACT-client contract still holds per subsystem: a failed read keeps the last
 * good rows and records the error, so the view renders stale data behind a
 * badge. An unreachable ACT is a NORMAL state, never an error screen.
 */

/** How many intervention events to pull for the feed. */
const EVENT_FEED_LIMIT = 50;

const emptyReads = (): SubsystemReads =>
  Object.fromEntries(
    ACT_SUBSYSTEMS.map(({ key }) => [key, { fetchedAt: 0, error: null }]),
  ) as SubsystemReads;

interface ActControlState {
  policy: ActPolicySnapshot | null;
  rules: ActInterventionRule[];
  events: ActInterventionEvent[];
  budget: ActBudget | null;
  ledger: ActLedgerEntry[];
  replays: ActReplay[];
  /** Per-subsystem read record; drives the stale badge and the fault flags. */
  reads: SubsystemReads;
  isPolling: boolean;
  /** The replay opened in the timeline, and its agent id. */
  openReplayAgentId: string | null;
  replayEvents: ActReplayEvent[];
  replayError: string | null;
  refreshAll: () => Promise<void>;
  setAutonomy: (patch: ActAutonomyPatch) => Promise<void>;
  openReplay: (agentId: string) => Promise<void>;
  closeReplay: () => void;
}

export const useActControlStore = create<ActControlState>((set, get) => {
  /**
   * Run one subsystem read. On success it stores the value and clears that
   * subsystem's error; on failure it records the error and leaves the
   * previous value in place.
   */
  async function read<T>(
    key: SubsystemKey,
    fetcher: () => Promise<T>,
    apply: (value: T) => Partial<ActControlState>,
  ): Promise<void> {
    try {
      const value = await fetcher();
      set((state) => ({
        ...apply(value),
        reads: { ...state.reads, [key]: { fetchedAt: Date.now(), error: null } },
      }));
    } catch (err) {
      set((state) => ({
        reads: {
          ...state.reads,
          [key]: { fetchedAt: state.reads[key].fetchedAt, error: String(err) },
        },
      }));
    }
  }

  async function readPolicy(): Promise<void> {
    await read(
      "policy",
      () => invoke<ActPolicySnapshot>("act_get_policy"),
      (policy) => ({ policy }),
    );
  }

  return {
    policy: null,
    rules: [],
    events: [],
    budget: null,
    ledger: [],
    replays: [],
    reads: emptyReads(),
    isPolling: false,
    openReplayAgentId: null,
    replayEvents: [],
    replayError: null,

    refreshAll: async () => {
      if (get().isPolling) return;
      set({ isPolling: true });
      try {
        /* Concurrent, not serial: six 4-second relay timeouts in a row would
           outlast the panel's poll interval when ACT is down. */
        await Promise.all([
          readPolicy(),
          read(
            "rules",
            () => invoke<ActInterventionRule[]>("act_list_intervention_rules"),
            (rules) => ({ rules }),
          ),
          read(
            "events",
            () =>
              invoke<ActInterventionEvent[]>("act_list_intervention_events", {
                limit: EVENT_FEED_LIMIT,
              }),
            (events) => ({ events }),
          ),
          read(
            "budget",
            () => invoke<ActBudget>("act_get_budget"),
            (budget) => ({ budget }),
          ),
          read(
            "ledger",
            () => invoke<ActLedgerEntry[]>("act_list_ledger"),
            (ledger) => ({ ledger }),
          ),
          read(
            "replays",
            () => invoke<ActReplay[]>("act_list_replays"),
            (replays) => ({ replays }),
          ),
        ]);
      } finally {
        set({ isPolling: false });
      }
    },

    setAutonomy: async (patch: ActAutonomyPatch) => {
      try {
        await invoke<number>("act_set_autonomy", { autonomy: patch });
      } catch (err) {
        // Surface on the policy subsystem and return: re-reading here would
        // look like the write landed. ACT's own merge is the source of
        // truth for what the policy becomes, so nothing is set optimistically.
        set((state) => ({
          reads: {
            ...state.reads,
            policy: { fetchedAt: state.reads.policy.fetchedAt, error: String(err) },
          },
        }));
        return;
      }
      await readPolicy();
    },

    openReplay: async (agentId: string) => {
      set({ openReplayAgentId: agentId, replayEvents: [], replayError: null });
      try {
        const events = await invoke<ActReplayEvent[]>("act_get_replay", { agentId });
        // Guard against a slow response for a replay the user has since
        // closed or swapped away from.
        if (get().openReplayAgentId !== agentId) return;
        set({ replayEvents: events });
      } catch (err) {
        if (get().openReplayAgentId !== agentId) return;
        set({ replayError: String(err) });
      }
    },

    closeReplay: () => set({ openReplayAgentId: null, replayEvents: [], replayError: null }),
  };
});
