import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Terminal sessions running outside Maestro.
 *
 * Maestro's own session store only knows the PTYs it spawned, so a Claude
 * session started in iTerm was invisible to the app that is meant to be the
 * one window. These rows come from iTerm itself, which is why they can only be
 * focused or closed, never driven.
 */

export interface ExternalSession {
  id: string;
  tty: string;
  cwd: string;
  title: string;
  /** Repo the terminal sits in, or null when it is not in one. */
  repo: string | null;
  /** Folder name of that repo, which is what the list groups under. */
  repoName: string | null;
}

type Store = {
  sessions: ExternalSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  focus: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useExternalSessionsStore = create<Store>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,

  /* A read that fails means iTerm is closed or automation is not permitted.
     Both are "there is nothing to show", not something to complain about.
     Note it never touches `error`: a refresh follows a failed action, and
     clearing here would wipe the message one frame after it was set. */
  refresh: async () => {
    set({ loading: true });
    try {
      const sessions = await invoke<ExternalSession[]>("list_external_sessions");
      // A stub or an older backend can answer with nothing at all; an
      // undefined list here used to take the whole panel down with it.
      set({ sessions: Array.isArray(sessions) ? sessions : [], loading: false });
    } catch {
      set({ sessions: [], loading: false });
    }
  },

  /* An action that fails DOES need words: he pressed a button and nothing
     happened, usually because that terminal closed since the last read. */
  focus: async (id: string) => {
    try {
      await invoke("focus_external_session", { id });
      set({ error: null });
    } catch (error) {
      set({ error: reason(error) });
      await get().refresh();
    }
  },

  close: async (id: string) => {
    try {
      await invoke("close_external_session", { id });
      set({ error: null });
    } catch (error) {
      set({ error: reason(error) });
    }
    await get().refresh();
  },
}));
