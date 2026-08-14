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
  /** Back to "never edited" — the backend default governs again. */
  resetGraph: () => void;
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

/**
 * Hydration gate: the LazyStore read is async, so for a brief startup window
 * the store still holds `graph: null` while a persisted edit is on its way
 * in. Two hazards, both closed here:
 *  - an edit made inside that window would be clobbered when rehydration
 *    lands (persist merges storage OVER current state) → the edit is
 *    remembered and re-applied the moment hydration finishes;
 *  - a launch reading inside that window would wrongly send
 *    `workflow: null` → {@link workflowGraphForLaunch} awaits hydration.
 */
let pendingEdit: { graph: SamuraiWorkflowGraph | null } | null = null;

export const useSamuraiWorkflowStore = create<SamuraiWorkflowState>()(
  persist(
    (set) => ({
      graph: null,
      setGraph: (graph) => {
        if (!useSamuraiWorkflowStore.persist.hasHydrated()) pendingEdit = { graph };
        set({ graph });
      },
      resetGraph: () => {
        if (!useSamuraiWorkflowStore.persist.hasHydrated()) pendingEdit = { graph: null };
        set({ graph: null });
      },
    }),
    {
      name: "maestro-samurai-workflow",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ graph: state.graph }),
    },
  ),
);

// Re-apply an edit that raced rehydration — registered before any launch
// waiter, so a concurrently-gated launch read resolves AFTER the re-apply.
useSamuraiWorkflowStore.persist.onFinishHydration(() => {
  if (pendingEdit === null) return;
  const { graph } = pendingEdit;
  pendingEdit = null;
  // setState goes through the persist middleware, so the re-apply is also
  // written back to disk.
  useSamuraiWorkflowStore.setState({ graph });
});

/**
 * The graph a launch should snapshot: waits for the persisted edit (if any)
 * to finish loading, so a launch fired right after app start cannot send
 * `workflow: null` while an edit exists on disk.
 */
export async function workflowGraphForLaunch(): Promise<SamuraiWorkflowGraph | null> {
  const { persist: persistApi } = useSamuraiWorkflowStore;
  if (!persistApi.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = persistApi.onFinishHydration(() => {
        unsubscribe();
        resolve();
      });
      // Hydration may have finished between the check and the subscribe.
      if (persistApi.hasHydrated()) {
        unsubscribe();
        resolve();
      }
    });
  }
  return useSamuraiWorkflowStore.getState().graph;
}
