import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * The ACT process itself, as opposed to `useActStore`, which is the runs
 * inside it. Split deliberately: "is the engine up" and "what is it doing"
 * fail independently, and the Factory lane used to conflate them into one
 * OFFLINE badge with no way forward.
 */

export type ActEngineState = "notRunning" | "starting" | "live";

export interface ActEngineStatus {
  state: ActEngineState;
  /** True only when this Maestro spawned the process that is answering. */
  managed: boolean;
  /** Which checkout the engine was launched from, so the UI can name it. */
  directory: string | null;
  /** Plain-English reason, already written for a human by the Rust side. */
  detail: string | null;
}

const UNREADABLE: ActEngineStatus = {
  state: "notRunning",
  managed: false,
  directory: null,
  detail: "Not running.",
};

type Store = {
  status: ActEngineStatus | null;
  starting: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useActEngineStore = create<Store>((set) => ({
  status: null,
  starting: false,
  error: null,

  /* A status probe that fails means the same thing as one that says nothing
     is there, so it never raises an error banner. Only a start he asked for
     and did not get is worth words on screen. */
  refresh: async () => {
    try {
      const status = await invoke<ActEngineStatus>("act_engine_status");
      set({ status });
    } catch {
      set({ status: UNREADABLE });
    }
  },

  start: async () => {
    set({ starting: true, error: null });
    try {
      const status = await invoke<ActEngineStatus>("act_engine_start");
      set({ status, starting: false, error: null });
    } catch (error) {
      set({ starting: false, error: reason(error) });
    }
  },

  stop: async () => {
    try {
      const status = await invoke<ActEngineStatus>("act_engine_stop");
      set({ status, error: null });
    } catch (error) {
      set({ error: reason(error) });
    }
  },
}));
