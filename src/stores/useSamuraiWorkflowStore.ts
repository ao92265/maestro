import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { SamuraiWorkflowGraph } from "@/lib/samurai";

/**
 * The user's edited Samurai run workflow (issue #91), persisted across app
 * restarts through the Tauri store plugin — the same mechanism as the other
 * pre-launch settings stores (`useWorktreeSettingsStore` is the template).
 *
 * `null` means "never edited": the workflow editor then displays the
 * backend's default template and the launch sends `workflow: null`, so the
 * backend compiles (and snapshots) its own default. The graph only lands
 * here — and therefore only pins a launch — once the user actually edits.
 */

type SamuraiWorkflowState = {
  /** The edited graph, or null when the backend default still governs. */
  graph: SamuraiWorkflowGraph | null;
  setGraph: (graph: SamuraiWorkflowGraph) => void;
};

const lazyStore = new LazyStore("samurai-workflow.json");

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

export const useSamuraiWorkflowStore = create<SamuraiWorkflowState>()(
  persist(
    (set) => ({
      graph: null,
      setGraph: (graph) => set({ graph }),
    }),
    {
      name: "maestro-samurai-workflow",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ graph: state.graph }),
    },
  ),
);
