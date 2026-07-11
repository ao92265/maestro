import { create } from "zustand";

/**
 * Toggle state for the unified "All Terminals" view.
 *
 * When enabled, the main content area overlays a single grid containing every
 * running terminal across all open projects (each color-coded by its project)
 * instead of showing only the active project's terminals.
 *
 * State is intentionally ephemeral (not persisted): the view is a transient
 * "monitor everything" mode rather than a saved workspace layout.
 */
interface UnifiedViewState {
  enabled: boolean;
  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
}

export const useUnifiedViewStore = create<UnifiedViewState>((set) => ({
  enabled: false,
  toggle: () => set((s) => ({ enabled: !s.enabled })),
  setEnabled: (enabled: boolean) => set({ enabled }),
}));
