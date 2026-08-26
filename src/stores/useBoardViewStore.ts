import { create } from "zustand";

/**
 * Open/closed state of the Board layer, the same shape as
 * `useHomeViewStore`/`useFactoryViewStore` and for the same reason: the
 * Board/Grid toggle lives in the TopBar while other surfaces may want to open
 * the Board without prop-drilling.
 *
 * The Board is a layer over the permanently mounted grid, never a
 * replacement: unmounting the grid tears down every live terminal. "Default
 * shell" therefore means "this layer starts open".
 */

/**
 * Whether the Board layer starts open. One exported constant because
 * Board-as-default is still a working assumption the spec leaves open, so
 * flipping it must be a one-line change with nothing else to hunt down.
 */
export const BOARD_DEFAULT_OPEN = true;

interface BoardViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useBoardViewStore = create<BoardViewState>((set) => ({
  isOpen: BOARD_DEFAULT_OPEN,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
