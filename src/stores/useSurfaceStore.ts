import { create } from "zustand";

/**
 * The one piece of state that says what you are looking at.
 *
 * This replaces seven independent booleans (Board, Home, Factory,
 * Orchestrator, Pulse, Workflows and App-local `landscapeView`). Those flags
 * could describe two full-screen surfaces at once, and nothing owned the rule
 * "leave whatever is covering the screen before changing what is underneath",
 * so every call site re-implemented the dismissal by hand and each one forgot a
 * different subset. The result was fifteen controls that did the right thing
 * invisibly: the Board/Grid switch, the "+", eagle view, quick-open, the
 * Landscape arrows and the Home rows all appeared dead.
 *
 * A discriminated shape makes that class of bug unwriteable rather than fixed
 * fifteen times: there is one `overlay` slot, so a second overlay cannot be
 * open, and every action that changes the base surface clears it.
 *
 * Callers should reach for the SEMANTIC actions (`showGrid` before touching a
 * terminal, `openOverlay` to navigate) rather than assembling a state by hand.
 */

/** The permanently mounted terminal grid, or the Board layer sitting over it. */
export type BaseSurface = "board" | "grid";

/**
 * The full-screen surfaces that cover the base. Exactly one, or none.
 * `landscape` is in here rather than in App-local state precisely because it
 * being outside the union is what let it coexist with Workflows.
 */
export const OVERLAYS = [
  "home",
  "factory",
  "orchestrator",
  "pulse",
  "workflows",
  "landscape",
] as const;

export type Overlay = (typeof OVERLAYS)[number];

/**
 * Whether the Board is the landing surface. One exported constant because
 * Board-as-default is still a working assumption, so flipping it must be a
 * one-line change with nothing else to hunt down.
 */
export const BOARD_DEFAULT_OPEN = true;

interface SurfaceState {
  /** What sits underneath any overlay. The grid is always mounted; unmounting
      it would tear down every live terminal. */
  base: BaseSurface;
  /** The aerial view of the grid. Only meaningful when `base` is "grid". */
  eagle: boolean;
  /** The single full-screen surface covering the base, if any. */
  overlay: Overlay | null;

  /** Show the Board, leaving any overlay. */
  showBoard: () => void;
  /**
   * Show the terminals themselves. Leaves the overlay AND the Board, because
   * the Board is a layer over the grid rather than a sibling of it: closing
   * only the overlay would still land the caller behind the Board.
   *
   * This is the call every "go to this terminal" and "add a terminal" route
   * must make before it touches the grid.
   */
  showGrid: () => void;
  /**
   * Reveal the terminals but leave eagle view as the user set it.
   *
   * The difference from `showGrid` matters: a card that names ONE project
   * (a Board card, a Home row, a Landscape node) means "take me to this
   * project", so flattening eagle is right. A route that just jumps between
   * terminals (the footer navigator, the sidebar Agents list) has no business
   * changing the layout the user chose, and eagle has its own zoom overlay
   * that keeps every pane mounted.
   */
  showTerminals: () => void;
  /** Show the aerial view of the grid, leaving any overlay. */
  showEagle: () => void;
  /** Flip the aerial view, surfacing the result rather than hiding it. */
  toggleEagle: () => void;
  /**
   * Cmd/Ctrl+E. Under an overlay the visible meaning of the keystroke is
   * "show me the Board", not "flip a bit I cannot see", so it surfaces the
   * Board instead of toggling blind.
   */
  toggleBoard: () => void;
  /** Navigate to a full-screen surface, replacing whichever one is up. */
  openOverlay: (overlay: Overlay) => void;
  /** Return to the base surface underneath. */
  closeOverlay: () => void;
  /** Open it, or close it if it is the one already showing. */
  toggleOverlay: (overlay: Overlay) => void;
}

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  base: BOARD_DEFAULT_OPEN ? "board" : "grid",
  eagle: false,
  overlay: null,

  showBoard: () => set({ base: "board", eagle: false, overlay: null }),
  showGrid: () => set({ base: "grid", eagle: false, overlay: null }),
  showTerminals: () => set({ base: "grid", overlay: null }),
  showEagle: () => set({ base: "grid", eagle: true, overlay: null }),

  toggleEagle: () => set((s) => ({ base: "grid", eagle: !s.eagle, overlay: null })),

  toggleBoard: () => {
    // Covered: the keystroke means "get me to the Board", so surface it.
    if (get().overlay !== null) {
      set({ base: "board", eagle: false, overlay: null });
      return;
    }
    set((s) => ({ base: s.base === "board" ? "grid" : "board", eagle: false, overlay: null }));
  },

  openOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: null }),
  toggleOverlay: (overlay) => set((s) => ({ overlay: s.overlay === overlay ? null : overlay })),
}));
