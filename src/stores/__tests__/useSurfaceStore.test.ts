import { beforeEach, describe, expect, it } from "vitest";
import { OVERLAYS, type Overlay, useSurfaceStore } from "../useSurfaceStore";

/** `it.each` wants a row per case, so widen the readonly tuple into rows. */
const EACH_OVERLAY: [Overlay][] = OVERLAYS.map((o) => [o]);

/**
 * The whole point of this store is that "two full-screen things are visible at
 * once" and "I changed the grid underneath something you are still looking at"
 * are unrepresentable. These tests are the transition table for that claim, so
 * they assert the WHOLE state after every action, not just the field it moved.
 */

const reset = () => useSurfaceStore.setState({ base: "board", eagle: false, overlay: null });

const snapshot = () => {
  const { base, eagle, overlay } = useSurfaceStore.getState();
  return { base, eagle, overlay };
};

describe("useSurfaceStore", () => {
  beforeEach(reset);

  it("lands on the Board with no overlay", () => {
    expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: null });
  });

  describe("at most one overlay is representable", () => {
    it("replaces the open overlay rather than stacking a second one", () => {
      const { openOverlay } = useSurfaceStore.getState();
      openOverlay("home");
      openOverlay("landscape");
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: "landscape" });
    });

    // Workflows over Landscape was a real defect: closing the top one revealed
    // the other, which the user never asked for.
    it.each(EACH_OVERLAY)("opening %s from every other overlay leaves only itself", (overlay) => {
      for (const previous of OVERLAYS) {
        reset();
        useSurfaceStore.getState().openOverlay(previous);
        useSurfaceStore.getState().openOverlay(overlay);
        expect(useSurfaceStore.getState().overlay).toBe(overlay);
      }
    });
  });

  describe("showing a base surface always leaves the overlay", () => {
    it.each(EACH_OVERLAY)("showGrid from %s reveals the grid", (overlay) => {
      useSurfaceStore.getState().openOverlay(overlay);
      useSurfaceStore.getState().showGrid();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it.each(EACH_OVERLAY)("showBoard from %s reveals the Board", (overlay) => {
      useSurfaceStore.getState().openOverlay(overlay);
      useSurfaceStore.getState().showBoard();
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: null });
    });

    it.each(EACH_OVERLAY)("showEagle from %s reveals the eagle grid", (overlay) => {
      useSurfaceStore.getState().openOverlay(overlay);
      useSurfaceStore.getState().showEagle();
      expect(snapshot()).toEqual({ base: "grid", eagle: true, overlay: null });
    });
  });

  describe("showGrid also leaves the Board", () => {
    // The Board is a layer over the grid, not a sibling of it. A terminal route
    // that only closed "the overlay" would still land behind the Board: that is
    // the Board/Grid switch and quick-open defect.
    it("drops the Board even with no overlay up", () => {
      useSurfaceStore.getState().showGrid();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it("drops the Board and the overlay together", () => {
      useSurfaceStore.getState().openOverlay("home");
      useSurfaceStore.getState().showGrid();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it("leaves eagle view, because a named terminal is not the aerial view", () => {
      useSurfaceStore.getState().showEagle();
      useSurfaceStore.getState().showGrid();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });
  });

  describe("eagle view", () => {
    it("toggles on from the grid", () => {
      useSurfaceStore.getState().showGrid();
      useSurfaceStore.getState().toggleEagle();
      expect(snapshot()).toEqual({ base: "grid", eagle: true, overlay: null });
    });

    it("toggles back off", () => {
      useSurfaceStore.getState().showEagle();
      useSurfaceStore.getState().toggleEagle();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    // The top-bar eagle button and Cmd+G both used to flip a boolean under
    // whatever was covering the screen, so the click looked dead.
    it.each(
      EACH_OVERLAY,
    )("toggling from %s surfaces the result instead of hiding it", (overlay) => {
      useSurfaceStore.getState().openOverlay(overlay);
      useSurfaceStore.getState().toggleEagle();
      expect(snapshot()).toEqual({ base: "grid", eagle: true, overlay: null });
    });

    it("toggling from the Board surfaces the eagle grid", () => {
      useSurfaceStore.getState().toggleEagle();
      expect(snapshot()).toEqual({ base: "grid", eagle: true, overlay: null });
    });
  });

  describe("toggleOverlay", () => {
    it("opens when closed", () => {
      useSurfaceStore.getState().toggleOverlay("pulse");
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: "pulse" });
    });

    it("closes when it is the one already open", () => {
      useSurfaceStore.getState().openOverlay("pulse");
      useSurfaceStore.getState().toggleOverlay("pulse");
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: null });
    });

    it("switches when a different overlay is open", () => {
      useSurfaceStore.getState().openOverlay("home");
      useSurfaceStore.getState().toggleOverlay("pulse");
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: "pulse" });
    });

    it("keeps the base surface underneath, so closing returns you where you were", () => {
      useSurfaceStore.getState().showGrid();
      useSurfaceStore.getState().toggleOverlay("home");
      useSurfaceStore.getState().closeOverlay();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it("preserves eagle underneath an overlay", () => {
      useSurfaceStore.getState().showEagle();
      useSurfaceStore.getState().openOverlay("factory");
      useSurfaceStore.getState().closeOverlay();
      expect(snapshot()).toEqual({ base: "grid", eagle: true, overlay: null });
    });
  });

  describe("toggleBoard", () => {
    // Cmd+E. Under an overlay the visible meaning of the keystroke is "show me
    // the Board", not "flip a hidden bit".
    it.each(EACH_OVERLAY)("opens the Board from %s rather than toggling blind", (overlay) => {
      useSurfaceStore.getState().showGrid();
      useSurfaceStore.getState().openOverlay(overlay);
      useSurfaceStore.getState().toggleBoard();
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: null });
    });

    it("swaps Board for grid when nothing covers it", () => {
      useSurfaceStore.getState().toggleBoard();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it("swaps grid for Board when nothing covers it", () => {
      useSurfaceStore.getState().showGrid();
      useSurfaceStore.getState().toggleBoard();
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: null });
    });
  });

  describe("handing over from one surface to another", () => {
    /**
     * Opening the Factory on a gated run FROM the Board must also leave the
     * Board, or closing the Factory drops the user back on the Board instead
     * of the terminals. Opening the overlay alone preserves the base, which
     * silently changed where the exit landed.
     */
    it("leaves the Board behind when the Board hands over to an overlay", () => {
      useSurfaceStore.getState().showGrid();
      useSurfaceStore.getState().openOverlay("factory");
      useSurfaceStore.getState().closeOverlay();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it("keeps the Board when an overlay is opened from the Board deliberately", () => {
      useSurfaceStore.getState().openOverlay("home");
      useSurfaceStore.getState().closeOverlay();
      expect(snapshot()).toEqual({ base: "board", eagle: false, overlay: null });
    });
  });

  describe("showTerminals", () => {
    // Jumping between terminals must not rearrange the shell the user chose.
    it("reveals the terminals without flattening eagle view", () => {
      useSurfaceStore.getState().showEagle();
      useSurfaceStore.getState().openOverlay("home");
      useSurfaceStore.getState().showTerminals();
      expect(snapshot()).toEqual({ base: "grid", eagle: true, overlay: null });
    });

    it("drops the Board like showGrid does", () => {
      useSurfaceStore.getState().showTerminals();
      expect(snapshot()).toEqual({ base: "grid", eagle: false, overlay: null });
    });

    it.each(EACH_OVERLAY)("leaves %s", (overlay) => {
      useSurfaceStore.getState().openOverlay(overlay);
      useSurfaceStore.getState().showTerminals();
      expect(useSurfaceStore.getState().overlay).toBeNull();
    });
  });

  describe("isCovered", () => {
    // Hidden keyboard handlers were driving the Board while Pulse covered it.
    it("is false on the bare Board", () => {
      expect(useSurfaceStore.getState().overlay).toBeNull();
    });

    it.each(EACH_OVERLAY)("is true under %s", (overlay) => {
      useSurfaceStore.getState().openOverlay(overlay);
      expect(useSurfaceStore.getState().overlay).not.toBeNull();
    });
  });
});
