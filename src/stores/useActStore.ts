import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  type ActGate,
  type ActRun,
  type ActRunDetail,
  type ActSpecInput,
  type ActSubmitOutcome,
  isTerminal,
  parseGates,
  runNeedsYou,
} from "@/lib/act";

/**
 * Factory-lane state: the ACT runs list, the confidence-gated subset (Home's
 * band 1), one open run detail, and spec submission.
 *
 * Failure convention (rohcna's ACT client, ported): a failed poll keeps the
 * previous data and records the error; the view renders a stale badge. An
 * unreachable ACT is a NORMAL state — the factory is simply off.
 */

/**
 * How many non-terminal runs get a detail probe per poll (gate detection).
 * A gated run at position 11+ is missed until earlier runs finish; accepted
 * trade-off to keep the poll cheap.
 */
const GATE_PROBE_LIMIT = 10;

/** A successful fetch older than this reads as stale in the UI. */
export const ACT_STALE_MS = 90 * 1000;

interface ActState {
  runs: ActRun[];
  /** Runs whose embedded task is blocked at a confidence gate. */
  gatedRuns: ActRun[];
  /** Last successful list fetch; 0 = never (offline state). */
  fetchedAt: number;
  /** Last failure, cleared on the next success. */
  error: string | null;
  isPolling: boolean;
  detail: ActRunDetail | null;
  /** Pending pipeline gates for the open run's task (GateManager side). */
  detailGates: ActGate[];
  detailError: string | null;
  isSubmitting: boolean;
  submitOutcome: ActSubmitOutcome | null;
  refresh: () => Promise<void>;
  openDetail: (runId: string) => Promise<void>;
  closeDetail: () => void;
  submit: (spec: ActSpecInput) => Promise<ActSubmitOutcome | null>;
  cancelRun: (runId: string) => Promise<void>;
  /** Clear (approve) or archive (reject) a low-confidence task block. */
  unblockTask: (taskId: string, approve: boolean) => Promise<void>;
  /** Resolve a pipeline gate by the gate's OWN id. */
  resolveGate: (gateId: string, decision: string, input?: string) => Promise<void>;
}

export const useActStore = create<ActState>((set, get) => ({
  runs: [],
  gatedRuns: [],
  fetchedAt: 0,
  error: null,
  isPolling: false,
  detail: null,
  detailGates: [],
  detailError: null,
  isSubmitting: false,
  submitOutcome: null,

  refresh: async () => {
    if (get().isPolling) return;
    set({ isPolling: true });
    try {
      const runs = await invoke<ActRun[]>("act_list_runs");
      /* Gate detection needs each run's embedded task, which only the detail
         route carries. Probe the newest non-terminal runs CONCURRENTLY — a
         serial loop of slow probes could eat most of the 30s poll window
         (review b43c16d, MEDIUM). A failed probe just means "not gated". */
      const candidates = runs.filter((r) => !isTerminal(r.status)).slice(0, GATE_PROBE_LIMIT);
      const probes = await Promise.allSettled(
        candidates.map((run) => invoke<ActRunDetail>("act_get_run", { runId: run.id })),
      );
      const gatedRuns: ActRun[] = candidates.filter((_run, i) => {
        const probe = probes[i];
        return probe.status === "fulfilled" && runNeedsYou(probe.value);
      });
      set({ runs, gatedRuns, fetchedAt: Date.now(), error: null });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ isPolling: false });
    }
  },

  openDetail: async (runId: string) => {
    try {
      const detail = await invoke<ActRunDetail>("act_get_run", { runId });
      /* Pipeline gates are keyed by the run's TASK id. A gate fetch failing
         must not hide the detail — gates are just one section of it. */
      let detailGates: ActGate[] = [];
      if (detail.task?.id) {
        try {
          detailGates = parseGates(
            await invoke<unknown>("act_list_gates", { taskId: detail.task.id }),
          );
        } catch {
          /* no gates section, detail still renders */
        }
      }
      set({ detail, detailGates, detailError: null });
    } catch (err) {
      set({ detailError: String(err) });
    }
  },

  closeDetail: () => set({ detail: null, detailGates: [], detailError: null }),

  submit: async (spec: ActSpecInput) => {
    set({ isSubmitting: true, submitOutcome: null });
    try {
      const outcome = await invoke<ActSubmitOutcome>("act_submit_spec", { spec });
      set({ submitOutcome: outcome });
      void get().refresh();
      return outcome;
    } catch (err) {
      set({
        submitOutcome: {
          accepted: false,
          runId: null,
          taskId: null,
          stages: null,
          complexity: null,
          httpStatus: 0,
          error: String(err),
          currentInFlight: null,
          limit: null,
          usedTokens: null,
          capTokens: null,
          remainingTokens: null,
        },
      });
      return null;
    } finally {
      set({ isSubmitting: false });
    }
  },

  cancelRun: async (runId: string) => {
    try {
      await invoke<number>("act_cancel_run", { runId });
    } catch (err) {
      // Return early: openDetail's success path resets detailError, which
      // would wipe this message one frame after we set it.
      set({ detailError: String(err) });
      return;
    }
    void get().refresh();
    if (get().detail?.id === runId) void get().openDetail(runId);
  },

  unblockTask: async (taskId: string, approve: boolean) => {
    try {
      await invoke<number>("act_set_task_status", {
        taskId,
        status: approve ? "pending" : "archived",
      });
    } catch (err) {
      // Return early: openDetail's success path resets detailError, which
      // would wipe this message one frame after we set it.
      set({ detailError: String(err) });
      return;
    }
    const open = get().detail;
    if (open) void get().openDetail(open.id);
    void get().refresh();
  },

  resolveGate: async (gateId: string, decision: string, input?: string) => {
    try {
      await invoke<number>("act_resolve_gate", { gateId, decision, input: input ?? null });
    } catch (err) {
      // Return early: openDetail's success path resets detailError, which
      // would wipe this message one frame after we set it.
      set({ detailError: String(err) });
      return;
    }
    const open = get().detail;
    if (open) void get().openDetail(open.id);
    void get().refresh();
  },
}));
