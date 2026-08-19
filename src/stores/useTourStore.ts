import { create } from "zustand";

/**
 * First-run tour state. The overlay shows once on a fresh install (no seen
 * marker), then never again on its own; the Home header keeps a button to
 * reopen it on demand. Same store shape as `useHomeViewStore` so the toggle
 * can live anywhere without prop-drilling.
 */
const TOUR_SEEN_KEY = "maestro-tour-seen";

/** Kept in sync with TOUR_STEPS in FirstRunTour — a test asserts the match. */
export const TOUR_STEP_COUNT = 5;

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) !== null;
  } catch {
    // Storage unavailable (fresh webview quirk): treat as seen rather than
    // trapping the user in a tour that will reopen every launch.
    return true;
  }
}

function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, new Date().toISOString());
  } catch {
    // Best effort; worst case the tour offers itself again next launch.
  }
}

interface TourState {
  isOpen: boolean;
  step: number;
  open: () => void;
  close: () => void;
  next: () => void;
  back: () => void;
}

/**
 * Auto-open on first launch only; reopening later is always explicit. Pure
 * and exported so the rule is testable — the store initializer runs once at
 * module load, where a test cannot reach it.
 */
export function initialTourOpen(): boolean {
  return !hasSeenTour();
}

export const useTourStore = create<TourState>((set) => ({
  isOpen: initialTourOpen(),
  step: 0,
  open: () => set({ isOpen: true, step: 0 }),
  close: () => {
    // Closing at any step counts as seen — a skipped tour that keeps coming
    // back is how first-run tours get hated.
    markTourSeen();
    set({ isOpen: false, step: 0 });
  },
  next: () => set((s) => ({ step: Math.min(s.step + 1, TOUR_STEP_COUNT - 1) })),
  back: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
}));
