import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { SamuraiWorkflowGraph } from "@/lib/samurai";

/**
 * The user's edited PR review workflow — the graph whose steps are the
 * checkboxes in the PR monitor's action dropdown. Persisted across app
 * restarts through the Tauri store plugin, mirroring
 * `useSamuraiWorkflowStore` (its own file, so the two workflows never
 * overwrite each other).
 *
 * `null` means "never edited": `DEFAULT_PR_WORKFLOW` (frontend-owned — no
 * Rust command compiles this graph) then governs, and future changes to that
 * default apply. A graph only lands here once the user actually edits.
 */

type PrWorkflowState = {
  /** The edited graph, or null when DEFAULT_PR_WORKFLOW still governs. */
  graph: SamuraiWorkflowGraph | null;
  setGraph: (graph: SamuraiWorkflowGraph) => void;
  /** Back to "never edited" — the default workflow governs again. */
  resetGraph: () => void;
};

const lazyStore = new LazyStore("pr-workflow.json");

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
 *  - a read inside that window would wrongly fall back to the default
 *    workflow → {@link prWorkflowGraphForLaunch} awaits hydration.
 */
let pendingEdit: { graph: SamuraiWorkflowGraph | null } | null = null;

export const usePrWorkflowStore = create<PrWorkflowState>()(
  persist(
    (set) => ({
      graph: null,
      setGraph: (graph) => {
        if (!usePrWorkflowStore.persist.hasHydrated()) pendingEdit = { graph };
        set({ graph });
      },
      resetGraph: () => {
        if (!usePrWorkflowStore.persist.hasHydrated()) pendingEdit = { graph: null };
        set({ graph: null });
      },
    }),
    {
      name: "maestro-pr-workflow",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ graph: state.graph }),
    },
  ),
);

// Re-apply an edit that raced rehydration — registered before any reader's
// waiter, so a concurrently-gated read resolves AFTER the re-apply.
usePrWorkflowStore.persist.onFinishHydration(() => {
  if (pendingEdit === null) return;
  const { graph } = pendingEdit;
  pendingEdit = null;
  // setState goes through the persist middleware, so the re-apply is also
  // written back to disk.
  usePrWorkflowStore.setState({ graph });
});

/**
 * The graph a PR action should compile from: waits for the persisted edit (if
 * any) to finish loading, so an action fired right after app start cannot
 * fall back to the default while an edit exists on disk. `null` still means
 * "never edited" — the caller falls back to `DEFAULT_PR_WORKFLOW`.
 */
export async function prWorkflowGraphForLaunch(): Promise<SamuraiWorkflowGraph | null> {
  const { persist: persistApi } = usePrWorkflowStore;
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
  return usePrWorkflowStore.getState().graph;
}
