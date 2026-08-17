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

/**
 * A failed WRITE of the edited graph. Deliberately its own store rather than
 * a field on the persisted one: writing the error back into that store would
 * trigger another persist write on every failure.
 */
type WorkflowSaveErrorState = {
  saveError: string | null;
  setSaveError: (message: string | null) => void;
};

export const useSamuraiWorkflowSaveError = create<WorkflowSaveErrorState>()((set) => ({
  saveError: null,
  setSaveError: (saveError) => set({ saveError }),
}));

function reportSaveError(message: string | null): void {
  if (useSamuraiWorkflowSaveError.getState().saveError !== message) {
    useSamuraiWorkflowSaveError.getState().setSaveError(message);
  }
}

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const raw = (await lazyStore.get<string>(name)) ?? null;
      if (raw === null) return null;
      // The persist middleware parses this with an unguarded `JSON.parse`,
      // and zustand never marks a FAILED hydration as finished — a corrupt
      // file would leave `hasHydrated()` false forever and hang every
      // launch gated on it. Degrade to "never edited" instead.
      JSON.parse(raw);
      return raw;
    } catch (error) {
      console.error("Failed to read the persisted Samurai workflow:", error);
      return null;
    }
  },
  setItem: async (name, value) => {
    // An unhandled rejection here left the canvas showing an edit that was
    // never written: the next app start would silently launch the OLD graph.
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
      reportSaveError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to save the Samurai workflow:", error);
      reportSaveError(message);
    }
  },
  removeItem: async (name) => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
      reportSaveError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to clear the Samurai workflow:", error);
      reportSaveError(message);
    }
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

/**
 * Hydration-FAILURE latch. zustand only marks a successful hydration as
 * finished — its `hydrate()` catch path leaves `hasHydrated` false and fires
 * no finish listener — so a gate waiting on `onFinishHydration` alone never
 * resolved after a failed read, and the launch it gated hung forever.
 * Cleared at the start of every hydration attempt.
 */
let hydrationFailed = false;
const hydrationFailureWaiters = new Set<() => void>();

function markHydrationFailed(): void {
  hydrationFailed = true;
  for (const waiter of [...hydrationFailureWaiters]) waiter();
}

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
      onRehydrateStorage: () => {
        // Called when an attempt STARTS; the returned callback when it ends.
        hydrationFailed = false;
        return (_state, error) => {
          if (error === undefined) return;
          console.error("Failed to load the persisted Samurai workflow:", error);
          markHydrationFailed();
        };
      },
    },
  ),
);

// Re-apply an edit that raced rehydration — registered before any launch
// waiter, so a concurrently-gated launch read resolves AFTER the re-apply.
useSamuraiWorkflowStore.persist.onFinishHydration(() => {
  if (pendingEdit !== null) {
    const { graph } = pendingEdit;
    pendingEdit = null;
    // setState goes through the persist middleware, so the re-apply is also
    // written back to disk.
    useSamuraiWorkflowStore.setState({ graph });
  }
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
      let unsubscribe: () => void = () => {};
      const settle = () => {
        unsubscribe();
        hydrationFailureWaiters.delete(settle);
        resolve();
      };
      unsubscribe = persistApi.onFinishHydration(settle);
      // Hydration may have finished between the check and the subscribe —
      // and a FAILED one fires no finish listener at all, so the failure
      // latch has to settle the gate or the launch waits forever.
      if (persistApi.hasHydrated() || hydrationFailed) settle();
      else hydrationFailureWaiters.add(settle);
    });
  }
  return useSamuraiWorkflowStore.getState().graph;
}
