import { create } from "zustand";

/**
 * Open/closed state of the full-screen Orchestrator overlay — the same shape
 * as `useFactoryViewStore`/`useHomeViewStore`. It lives in a store rather than
 * App-local state because a pending proposal is a reason to open the panel
 * from elsewhere (a Home band row, a notification), not only from the TopBar.
 *
 * Closed by default: the orchestrator is somewhere you go to set a goal or
 * clear a queue, not the landing surface.
 */
interface OrchestratorViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useOrchestratorViewStore = create<OrchestratorViewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
