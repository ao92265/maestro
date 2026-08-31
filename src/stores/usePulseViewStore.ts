import { create } from "zustand";

/**
 * Open/closed state of the full-screen Pulse overlay (today's timeline, flow
 * score and metrics) — the same shape as `useHomeViewStore`/
 * `useFactoryViewStore`, so the same exclusivity dance in `App.tsx` applies.
 *
 * Closed by default: Pulse is where you go to ask how the day is going, not
 * the surface you land on.
 */
interface PulseViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const usePulseViewStore = create<PulseViewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
