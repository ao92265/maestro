import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * Default tech watchlist for the sidebar Processes section.
 *
 * Matching rules (enforced backend-side, `commands/processes.rs`):
 * - Every entry matches the executable name exactly (minus `.exe`).
 * - Entries of 4+ chars additionally match anywhere in the command line,
 *   which is how a `node.exe` running vite gets labelled "vite".
 */
export const DEFAULT_WATCHLIST: string[] = [
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "vite",
  "webpack",
  "esbuild",
  "next",
  "tsc",
  "python",
  "uvicorn",
  "gunicorn",
  "django",
  "manage.py",
  "flask",
  "fastapi",
  "claude",
  "ollama",
  "cargo",
  "java",
  "gradle",
  "dotnet",
  "go",
  "php",
  "ruby",
  "rails",
];

type ProcessWatchlistState = {
  watchlist: string[];
  setWatchlist: (entries: string[]) => void;
  resetWatchlist: () => void;
};

const lazyStore = new LazyStore("process-watchlist.json");

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await lazyStore.get<string>(name)) ?? null;
    } catch {
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

/** Normalize user input: trim, lowercase, drop empties and duplicates. */
export function normalizeWatchlist(entries: string[]): string[] {
  return [...new Set(entries.map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

export const useProcessWatchlistStore = create<ProcessWatchlistState>()(
  persist(
    (set) => ({
      watchlist: DEFAULT_WATCHLIST,
      setWatchlist: (entries) => set({ watchlist: normalizeWatchlist(entries) }),
      resetWatchlist: () => set({ watchlist: DEFAULT_WATCHLIST }),
    }),
    {
      name: "maestro-process-watchlist",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ watchlist: state.watchlist }),
    }
  )
);
