import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  DEFAULT_NIGHT_RUN_SETTINGS,
  type NightRunSettings,
  type NightRunView,
} from "@/lib/nightRun";

/**
 * Night-run state: one read (`night_run_status`) and three writes.
 *
 * The schedule ticks in Rust, so this store never owns a clock — it polls the
 * view while the panel is on screen and sends what the user pressed. The
 * rohcna ACT-client contract still holds: a failed read keeps the last known
 * view and records the error, because the window, its settings and last
 * night's outcomes are local facts that stay true while ACT is unreachable.
 *
 * `draft` holds unsaved edits. Null means the panel is showing the engine's
 * own copy, which is what a fresh read restores.
 */
interface NightRunState {
  view: NightRunView | null;
  draft: NightRunSettings | null;
  error: string | null;
  isBusy: boolean;
  refresh: () => Promise<void>;
  setDraft: (patch: Partial<NightRunSettings>) => void;
  discardDraft: () => void;
  save: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export const useNightRunStore = create<NightRunState>((set, get) => {
  async function read(): Promise<void> {
    try {
      const view = await invoke<NightRunView>("night_run_status");
      set({ view, error: null });
    } catch (err) {
      // Keep `view`: the schedule is worth showing behind a stale badge.
      set({ error: String(err) });
    }
  }

  /** Run one write, then re-read so the panel shows what ACT actually did. */
  async function write(action: () => Promise<unknown>): Promise<void> {
    if (get().isBusy) return;
    set({ isBusy: true });
    try {
      await action();
      set({ error: null });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ isBusy: false });
    }
    await read();
  }

  return {
    view: null,
    draft: null,
    error: null,
    isBusy: false,

    refresh: read,

    setDraft: (patch) => {
      const base = get().draft ?? get().view?.settings;
      if (!base) return;
      set({ draft: { ...base, ...patch } });
    },

    discardDraft: () => set({ draft: null }),

    save: async () => {
      const settings = get().draft;
      if (!settings) return;
      await write(() => invoke("night_run_save_settings", { settings }));
      // Follow the engine's copy again: it clamps what it stores, and a draft
      // left in place would keep showing the value the user typed instead.
      set({ draft: null });
    },

    start: async () => {
      // What is on screen is what runs tonight, saved as part of starting.
      const settings = get().draft ?? get().view?.settings ?? DEFAULT_NIGHT_RUN_SETTINGS;
      await write(() => invoke("night_run_start", { settings }));
      set({ draft: null });
    },

    stop: async () => {
      await write(() => invoke("night_run_stop"));
    },
  };
});
