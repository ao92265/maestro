import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { localDateString, useStandupStore } from "./useStandupStore";

/** Mirrors the Rust `DailyPlan` struct. */
export interface DailyPlan {
  date: string;
  markdown: string;
  generated_at: string;
}

export type PlanStatus = "idle" | "generating" | "ready" | "error";

interface PlanState {
  /** Transient state of the single cross-project plan. Not persisted. */
  status: PlanStatus;
  plan: DailyPlan | null;
  error: string | null;
  /**
   * Free-text notes the user keeps in the Plan tab; fed into the prompt as the
   * highest-priority input. Persisted like the other settings.
   */
  concerns: string;
  /**
   * Local date (YYYY-MM-DD) of the last COMPLETED scheduled run. Only
   * persisted once the plan exists, so quitting mid-run can't consume the day.
   * Separate from the standup's own lastRunDate — they are separate artifacts
   * that can succeed independently — but both fire off the same schedule.
   */
  lastRunDate: string | null;
  /** True while a scheduled/catch-up run is in flight. In-memory only. */
  runInProgress: boolean;
  /**
   * Failed scheduled attempts so far on `failedRunsDate`. In-memory only, so
   * a restart (which may well be what fixes the problem) buys a fresh budget.
   */
  failedRuns: number;
  failedRunsDate: string | null;
  setConcerns: (concerns: string) => void;
  /**
   * Load the newest saved plan from disk — today's when it exists, otherwise
   * the last generated one, so a plan stays readable until the next day's
   * replaces it. Skipped when a plan is already shown or being generated; an
   * earlier error is NOT a reason to skip, so a failed read can recover.
   */
  loadLatest: () => Promise<void>;
  /** Generate (or regenerate) the plan across the given projects. */
  generate: (repoPaths: string[]) => Promise<void>;
  /**
   * Generate only when no plan for `date` is saved yet; an existing one is
   * adopted as-is. Resolves false when the existence check itself failed —
   * i.e. the day must not be marked as done.
   */
  generateIfMissing: (repoPaths: string[], date: string) => Promise<boolean>;
  /**
   * Fired by the App-level minute tick; runs at most once per day, at the
   * schedule time the Report tab configures (there is one schedule setting,
   * shared — see useStandupStore). A failed run is retried by the following
   * ticks, but only up to {@link MAX_SCHEDULED_ATTEMPTS} times a day.
   */
  maybeRunScheduled: (repoPaths: string[]) => Promise<void>;
}

/**
 * Scheduled attempts allowed per day before the plan gives up until tomorrow.
 *
 * The standup store marks the day done even when generation fails; this store
 * retries instead, because one plan covering every project is worth a couple
 * of retries (a transient `claude` failure would otherwise cost the whole
 * day). The cap is what keeps that from turning into a `claude -p` spawn
 * every 60 seconds until midnight when the failure is permanent.
 */
export const MAX_SCHEDULED_ATTEMPTS = 3;

const lazyStore = new LazyStore("plan-settings.json");

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await lazyStore.get<string>(name)) ?? null;
    } catch (err) {
      console.error("Failed to read plan settings:", err);
      return null;
    }
  },
  setItem: async (name, value) => {
    await lazyStore.set(name, value);
    await lazyStore.save();
  },
  removeItem: async (name) => {
    await lazyStore.delete(name);
    await lazyStore.save();
  },
};

export const usePlanStore = create<PlanState>()(
  persist(
    (set, get) => ({
      status: "idle",
      plan: null,
      error: null,
      concerns: "",
      lastRunDate: null,
      runInProgress: false,
      failedRuns: 0,
      failedRunsDate: null,

      setConcerns: (concerns) => set({ concerns }),

      loadLatest: async () => {
        const before = get().status;
        // A plan already on screen, or one being written, must not be
        // replaced by a disk read; an "error" state may be, so reopening the
        // tab can recover from a failed read instead of staying broken.
        if (before === "ready" || before === "generating") return;
        try {
          // `date: null` makes the backend serve the newest saved plan.
          const plan = await invoke<DailyPlan | null>("load_daily_plan", { date: null });
          // Re-check after the await: a run may have taken over while we read
          // from disk — its state must win over this now-stale read.
          if (get().status !== before) return;
          if (plan) set({ status: "ready", plan, error: null });
        } catch (err) {
          console.error("Failed to load daily plan:", err);
        }
      },

      generate: async (repoPaths) => {
        if (get().status === "generating") return;
        set({ status: "generating", error: null });
        try {
          const plan = await invoke<DailyPlan>("generate_daily_plan", {
            projectPaths: repoPaths,
            concerns: get().concerns,
          });
          set({ status: "ready", plan, error: null });
        } catch (err) {
          set({ status: "error", error: String(err) });
        }
      },

      generateIfMissing: async (repoPaths, date) => {
        try {
          const existing = await invoke<DailyPlan | null>("load_daily_plan", { date });
          if (existing) {
            // Adopt it — unless a manual regeneration started while we were
            // reading; its spinner (and eventual result) must not be clobbered.
            if (get().status !== "generating") {
              set({ status: "ready", plan: existing, error: null });
            }
            return true;
          }
        } catch (err) {
          // If we can't tell whether the plan exists, don't risk overwriting
          // it: surface the failure and leave the day open for a retry.
          if (get().status !== "generating") {
            set({
              status: "error",
              error: `Failed to check for an existing plan: ${String(err)}`,
            });
          }
          return false;
        }
        await get().generate(repoPaths);
        return get().status === "ready";
      },

      maybeRunScheduled: async (repoPaths) => {
        // The schedule (on/off + time of day) is the Report tab's — the plan
        // deliberately has no second setting, it rides the same daily slot.
        const { scheduleEnabled, scheduleTime } = useStandupStore.getState();
        const { lastRunDate, runInProgress, failedRunsDate } = get();
        if (!scheduleEnabled || repoPaths.length === 0) return;
        if (runInProgress) return;
        const now = new Date();
        const today = localDateString(now);
        if (lastRunDate === today) return;
        // A new day resets the retry budget.
        const failedRuns = failedRunsDate === today ? get().failedRuns : 0;
        if (failedRuns >= MAX_SCHEDULED_ATTEMPTS) return;
        const [hours, minutes] = scheduleTime.split(":").map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return;
        const due =
          now.getHours() > hours || (now.getHours() === hours && now.getMinutes() >= minutes);
        if (!due) return;
        // Gate re-entry with the in-memory flag (set synchronously, before the
        // first await) so the catch-up ticks fired at startup can't race the
        // regular minute tick. lastRunDate is only persisted AFTER the run
        // settles: quitting mid-run must not consume the day on disk.
        set({ runInProgress: true });
        try {
          // Skip days whose plan already exists on disk (generated manually,
          // or by a previous app run before a restart) — that on-disk check is
          // also what makes the startup catch-up safe to fire repeatedly.
          if (await get().generateIfMissing(repoPaths, today)) {
            set({ lastRunDate: today, failedRuns: 0, failedRunsDate: today });
          } else {
            const attempts = failedRuns + 1;
            set({ failedRuns: attempts, failedRunsDate: today });
            // Budget spent: consume the day so the minute tick stops respawning
            // `claude -p` until midnight. The Generate button still works.
            if (attempts >= MAX_SCHEDULED_ATTEMPTS) set({ lastRunDate: today });
          }
        } finally {
          set({ runInProgress: false });
        }
      },
    }),
    {
      name: "maestro-plan",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        concerns: state.concerns,
        lastRunDate: state.lastRunDate,
      }),
    },
  ),
);
