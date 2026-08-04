import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** Mirrors the Rust `StandupReport` struct. */
export interface StandupReport {
  project_path: string;
  date: string;
  markdown: string;
  generated_at: string;
}

export type StandupStatus = "idle" | "generating" | "ready" | "error";

interface ProjectStandup {
  status: StandupStatus;
  report: StandupReport | null;
  error: string | null;
}

interface StandupState {
  /** Transient per-project report state, keyed by repo path. Not persisted. */
  reports: Record<string, ProjectStandup>;
  /** Persisted schedule settings. */
  scheduleEnabled: boolean;
  /** Local time of day the daily run fires, "HH:MM". */
  scheduleTime: string;
  /** Local date (YYYY-MM-DD) of the last scheduled run — prevents refiring. */
  lastRunDate: string | null;
  /**
   * Custom prompt template for the headless run (persisted). `null` means
   * "use the built-in default". Placeholders: {project} {date} {since}
   * {commits} {sessions} {overview}.
   */
  promptTemplate: string | null;
  setScheduleEnabled: (enabled: boolean) => void;
  setScheduleTime: (time: string) => void;
  setPromptTemplate: (template: string | null) => void;
  /**
   * Load the newest saved report from disk if the project has none in memory
   * — today's when it exists, otherwise the last generated one, so a report
   * stays readable until the next day's replaces it.
   */
  loadLatest: (repoPath: string) => Promise<void>;
  /** Generate (or regenerate) the report for one project. */
  generate: (repoPath: string) => Promise<void>;
  /**
   * Generate only when no report for `date` is saved yet; an existing one is
   * adopted as-is. The scheduled/catch-up path goes through this so it never
   * overwrites a report that was already generated (manually or by an
   * earlier app run) that day.
   */
  generateIfMissing: (repoPath: string, date: string) => Promise<void>;
  /** Fired by the App-level minute tick; runs at most once per day. */
  maybeRunScheduled: (repoPaths: string[]) => Promise<void>;
}

const lazyStore = new LazyStore("standup-settings.json");

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await lazyStore.get<string>(name)) ?? null;
    } catch (err) {
      console.error("Failed to read standup settings:", err);
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

/** Local calendar date as YYYY-MM-DD (matches the Rust side's Local date). */
export function localDateString(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const useStandupStore = create<StandupState>()(
  persist(
    (set, get) => ({
      reports: {},
      scheduleEnabled: false,
      scheduleTime: "08:30",
      lastRunDate: null,
      promptTemplate: null,

      setScheduleEnabled: (enabled) => set({ scheduleEnabled: enabled }),
      setScheduleTime: (time) => set({ scheduleTime: time }),
      setPromptTemplate: (template) => set({ promptTemplate: template }),

      loadLatest: async (repoPath) => {
        const existing = get().reports[repoPath];
        if (existing && existing.status !== "idle") return;
        try {
          // `date: null` makes the backend serve the newest saved report.
          const report = await invoke<StandupReport | null>("load_standup_report", {
            projectPath: repoPath,
            date: null,
          });
          set((state) => ({
            reports: {
              ...state.reports,
              [repoPath]: report
                ? { status: "ready", report, error: null }
                : { status: "idle", report: null, error: null },
            },
          }));
        } catch (err) {
          console.error("Failed to load standup report:", err);
        }
      },

      generate: async (repoPath) => {
        if (get().reports[repoPath]?.status === "generating") return;
        set((state) => ({
          reports: {
            ...state.reports,
            [repoPath]: {
              status: "generating",
              report: state.reports[repoPath]?.report ?? null,
              error: null,
            },
          },
        }));
        try {
          const report = await invoke<StandupReport>("generate_standup_report", {
            projectPath: repoPath,
            promptTemplate: get().promptTemplate,
          });
          set((state) => ({
            reports: {
              ...state.reports,
              [repoPath]: { status: "ready", report, error: null },
            },
          }));
        } catch (err) {
          set((state) => ({
            reports: {
              ...state.reports,
              [repoPath]: {
                status: "error",
                report: state.reports[repoPath]?.report ?? null,
                error: String(err),
              },
            },
          }));
        }
      },

      generateIfMissing: async (repoPath, date) => {
        try {
          const existing = await invoke<StandupReport | null>("load_standup_report", {
            projectPath: repoPath,
            date,
          });
          if (existing) {
            set((state) => ({
              reports: {
                ...state.reports,
                [repoPath]: { status: "ready", report: existing, error: null },
              },
            }));
            return;
          }
        } catch (err) {
          // If we can't tell whether the report exists, don't risk overwriting
          // it — the user can still hit Generate manually.
          console.error("Failed to check for an existing standup report:", err);
          return;
        }
        await get().generate(repoPath);
      },

      maybeRunScheduled: async (repoPaths) => {
        const { scheduleEnabled, scheduleTime, lastRunDate } = get();
        if (!scheduleEnabled || repoPaths.length === 0) return;
        const now = new Date();
        const today = localDateString(now);
        if (lastRunDate === today) return;
        const [hours, minutes] = scheduleTime.split(":").map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return;
        const due = now.getHours() > hours || (now.getHours() === hours && now.getMinutes() >= minutes);
        if (!due) return;
        // Mark before generating (synchronously, before the first await) so a
        // slow run can't double-fire on the next tick, and so the catch-up
        // ticks fired at startup can't race the regular minute tick.
        set({ lastRunDate: today });
        // Per project: skip days whose report already exists on disk (e.g.
        // generated manually, or by a previous app run before a restart).
        await Promise.all(repoPaths.map((repoPath) => get().generateIfMissing(repoPath, today)));
      },
    }),
    {
      name: "maestro-standup",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        scheduleEnabled: state.scheduleEnabled,
        scheduleTime: state.scheduleTime,
        lastRunDate: state.lastRunDate,
        promptTemplate: state.promptTemplate,
      }),
    }
  )
);
