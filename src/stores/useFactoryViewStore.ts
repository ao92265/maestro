import { create } from "zustand";

/**
 * Open/closed state of the full-screen Factory overlay (the ACT lane) — the
 * same shape as `useHomeViewStore`/`useWorkflowsViewStore`: band rows in Home
 * open the factory on a specific run, so the trigger lives outside App.
 *
 * Closed by default: the factory is a place you go to hand work over or to
 * unblock a gated run, not the landing surface.
 */
interface FactoryViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useFactoryViewStore = create<FactoryViewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
