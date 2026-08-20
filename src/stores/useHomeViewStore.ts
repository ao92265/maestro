import { create } from "zustand";

/**
 * Open/closed state of the full-screen Home (decision queue) overlay — the
 * same shape as `useWorkflowsViewStore`, and for the same reason: the toggle
 * lives in the TopBar while band rows elsewhere (toasts, sidebar) may want to
 * open Home without prop-drilling.
 *
 * Starts CLOSED: the Board is the landing surface now (see
 * `BOARD_DEFAULT_OPEN` in `useBoardViewStore`), and two full-screen surfaces
 * cannot both greet you. Home stays one keystroke away on Cmd/Ctrl+1 until
 * Phase 3 folds its bands into the Board's rail.
 */
interface HomeViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useHomeViewStore = create<HomeViewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
