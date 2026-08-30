import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  ACT_SUBSYSTEMS,
  type ActAutonomyPatch,
  type ActBudget,
  type ActInterventionEvent,
  type ActInterventionRule,
  type ActLedger,
  type ActLedgerEntry,
  type ActPolicySnapshot,
  type ActReplay,
  type ActReplayEvent,
  type ActReplayTimeline,
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
  /** Tasks ACT holds, before the relay's display cap. */
  ledgerTotal: number;
  replays: ActReplay[];
  /** Per-subsystem read record; drives the stale badge and the fault flags. */
  reads: SubsystemReads;
  isPolling: boolean;
  /** The replay opened in the timeline, and its agent id. */
  openReplayAgentId: string | null;
  replayEvents: ActReplayEvent[];
  /** Events in the stored replay, before the relay's display cap. */
  replayTotal: number;
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

  /** Reads the policy; returns the snapshot, or null when the read failed. */
  async function readPolicy(): Promise<ActPolicySnapshot | null> {
    let fetched: ActPolicySnapshot | null = null;
    await read(
      "policy",
      () => invoke<ActPolicySnapshot>("act_get_policy"),
      (policy) => {
        fetched = policy;
        return { policy };
      },
    );
    return fetched;
  }

  return {
    policy: null,
    rules: [],
    events: [],
    budget: null,
    ledger: [],
    ledgerTotal: 0,
    replays: [],
    reads: emptyReads(),
    isPolling: false,
    openReplayAgentId: null,
    replayEvents: [],
    replayTotal: 0,
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
            () => invoke<ActLedger>("act_list_ledger"),
            (payload) => ({ ledger: payload.entries, ledgerTotal: payload.total }),
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
      /* ACT REPLACES the autonomy block rather than merging it (its
         `updatePolicy` spreads `updates` shallowly and deep-merges only
         agent_priority, tool_policies and today_overrides), so the write has to
         carry a complete block and whatever we merge onto is what survives.
         Re-read immediately before writing rather than trusting the last poll:
         the merge base is then at most milliseconds old instead of up to a
         poll interval, so a policy change made elsewhere in between is carried
         forward rather than silently clobbered. One extra request on a control
         clicked occasionally is a cheap price for not overwriting unseen
         state — which is the whole point of a panel meant to make policy
         legible. */
      const fresh = await readPolicy();
      if (!fresh) {
        // Could not confirm what we would be overwriting, so write nothing.
        // `readPolicy` has already recorded the underlying cause; name the
        // consequence so a failed click never reads as an applied one.
        set((state) => ({
          reads: {
            ...state.reads,
            policy: {
              fetchedAt: state.reads.policy.fetchedAt,
              error: `Could not confirm the current policy, so nothing was written. ${
                state.reads.policy.error ?? ""
              }`.trim(),
            },
          },
        }));
        return;
      }

      const merged = { ...fresh.autonomy, ...patch };
      try {
        await invoke<number>("act_set_autonomy", { autonomy: merged });
      } catch (err) {
        // Surface on the policy subsystem and return: re-reading here would
        // look like the write landed. ACT's stored policy stays the source of
        // truth, so nothing is set optimistically.
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
      set({ openReplayAgentId: agentId, replayEvents: [], replayTotal: 0, replayError: null });
      try {
        const timeline = await invoke<ActReplayTimeline>("act_get_replay", { agentId });
        // Guard against a slow response for a replay the user has since
        // closed or swapped away from.
        if (get().openReplayAgentId !== agentId) return;
        set({ replayEvents: timeline.events, replayTotal: timeline.total });
      } catch (err) {
        if (get().openReplayAgentId !== agentId) return;
        set({ replayError: String(err) });
      }
    },

    closeReplay: () =>
      set({ openReplayAgentId: null, replayEvents: [], replayTotal: 0, replayError: null }),
  };
});
