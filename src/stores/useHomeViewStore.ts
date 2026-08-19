import { create } from "zustand";

/**
 * Open/closed state of the full-screen Home (decision queue) overlay — the
 * same shape as `useWorkflowsViewStore`, and for the same reason: the toggle
 * lives in the TopBar while band rows elsewhere (toasts, sidebar) may want to
 * open Home without prop-drilling.
 *
 * Starts OPEN: Home is the app's landing surface. The first thing the user
 * sees is what is blocked on them, not an empty grid.
 */
interface HomeViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useHomeViewStore = create<HomeViewState>((set) => ({
  isOpen: true,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
