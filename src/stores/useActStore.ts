import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  type ActRun,
  type ActRunDetail,
  type ActSpecInput,
  type ActSubmitOutcome,
  isTerminal,
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

/** How many non-terminal runs get a detail probe per poll (gate detection). */
const GATE_PROBE_LIMIT = 5;

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
  detailError: string | null;
  isSubmitting: boolean;
  submitOutcome: ActSubmitOutcome | null;
  refresh: () => Promise<void>;
  openDetail: (runId: string) => Promise<void>;
  closeDetail: () => void;
  submit: (spec: ActSpecInput) => Promise<ActSubmitOutcome | null>;
  cancelRun: (runId: string) => Promise<void>;
  resolveGate: (gateId: string, approve: boolean, note?: string) => Promise<void>;
}

export const useActStore = create<ActState>((set, get) => ({
  runs: [],
  gatedRuns: [],
  fetchedAt: 0,
  error: null,
  isPolling: false,
  detail: null,
  detailError: null,
  isSubmitting: false,
  submitOutcome: null,

  refresh: async () => {
    if (get().isPolling) return;
    set({ isPolling: true });
    try {
      const runs = await invoke<ActRun[]>("act_list_runs");
      /* Gate detection needs each run's embedded task, which only the detail
         route carries. Probe the newest few non-terminal runs sequentially —
         local HTTP, bounded, and a failed probe just means "not gated". */
      const gatedRuns: ActRun[] = [];
      for (const run of runs.filter((r) => !isTerminal(r.status)).slice(0, GATE_PROBE_LIMIT)) {
        try {
          const detail = await invoke<ActRunDetail>("act_get_run", { runId: run.id });
          if (runNeedsYou(detail)) gatedRuns.push(run);
        } catch {
          /* detail probe failing must not fail the poll */
        }
      }
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
      set({ detail, detailError: null });
    } catch (err) {
      set({ detailError: String(err) });
    }
  },

  closeDetail: () => set({ detail: null, detailError: null }),

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
          complexity: null,
          httpStatus: 0,
          error: String(err),
          currentInFlight: null,
          limit: null,
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
      set({ detailError: String(err) });
    }
    void get().refresh();
    if (get().detail?.id === runId) void get().openDetail(runId);
  },

  resolveGate: async (gateId: string, approve: boolean, note?: string) => {
    try {
      await invoke<number>("act_resolve_gate", { gateId, approve, note: note ?? null });
    } catch (err) {
      set({ detailError: String(err) });
    }
    const open = get().detail;
    if (open) void get().openDetail(open.id);
    void get().refresh();
  },
}));
