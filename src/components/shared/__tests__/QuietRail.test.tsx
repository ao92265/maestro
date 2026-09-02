import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHealthStore } from "@/stores/useHealthStore";
import { QuietRail } from "../QuietRail";

/**
 * These cases came across from TopBar's suite unchanged when the navigation
 * moved into the Quiet Deck rail. They are kept together rather than rewritten
 * because each one was written against a real defect: segments that looked
 * dead from an overlay, a More menu that swallowed its own health dot, and a
 * declutter that had to be provably a removal rather than a rename.
 */
function renderRail(overrides: Partial<ComponentProps<typeof QuietRail>> = {}) {
  const handlers = {
    onToggleGitPanel: vi.fn(),
    onToggleLandscapeView: vi.fn(),
    onToggleMemoryPanel: vi.fn(),
    onOpenWorkflows: vi.fn(),
    onOpenExtensions: vi.fn(),
  };
  render(<QuietRail {...handlers} {...overrides} />);
  return handlers;
}

describe("QuietRail", () => {
  beforeEach(() => {
    useHealthStore.setState({ flags: [] });
  });

  /**
   * From an overlay, both segments used to look dead: one opened the Board
   * underneath what you were reading, the other closed a Board you could not
   * see. The TopBar's job is to name the surface it wants; App decides how.
   */
  describe("the Board/Grid selector", () => {
    it("asks for the Board, not for a blind toggle", () => {
      const onSetBoardView = vi.fn();
      renderRail({ onSetBoardView, boardViewOpen: false });
      fireEvent.click(screen.getByRole("button", { name: "Board view" }));
      expect(onSetBoardView).toHaveBeenCalledWith(true);
    });

    it("asks for the grid even when the Board is already the base surface", () => {
      const onSetBoardView = vi.fn();
      renderRail({ onSetBoardView, boardViewOpen: true });
      fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
      expect(onSetBoardView).toHaveBeenCalledWith(false);
    });
  });

  it("does not render the buttons cut by the declutter (Notes, Second Brain, Launch)", () => {
    renderRail();
    for (const label of ["Notes", "Second Brain", "Launch"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    // Landscape and Memory also lose their standalone buttons — only the
    // "Landscape view" aria-label is unique to the old button, so check that.
    expect(screen.queryByRole("button", { name: "Landscape view" })).not.toBeInTheDocument();
  });

  /**
   * The four surfaces that used to hide behind an ellipsis are on the rail
   * itself now. The rail runs down the window, so it has the room the old
   * horizontal strip did not, and a menu you have to open first is one more
   * thing to remember about an app Alex already said he could not read.
   */
  describe("the surfaces that used to be buried", () => {
    it("draws all four on the rail, with no menu to open first", () => {
      renderRail();
      for (const label of ["Landscape", "Memory", "Workflows", "Extensions"]) {
        expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
      }
      expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    });

    it("dispatches onToggleLandscapeView", () => {
      const handlers = renderRail();
      fireEvent.click(screen.getByRole("button", { name: "Landscape" }));
      expect(handlers.onToggleLandscapeView).toHaveBeenCalledTimes(1);
    });

    it("dispatches onToggleMemoryPanel", () => {
      const handlers = renderRail();
      fireEvent.click(screen.getByRole("button", { name: "Memory" }));
      expect(handlers.onToggleMemoryPanel).toHaveBeenCalledTimes(1);
    });

    it("dispatches onOpenWorkflows", () => {
      const handlers = renderRail();
      fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
      expect(handlers.onOpenWorkflows).toHaveBeenCalledTimes(1);
    });

    it("dispatches onOpenExtensions", () => {
      const handlers = renderRail();
      fireEvent.click(screen.getByRole("button", { name: "Extensions" }));
      expect(handlers.onOpenExtensions).toHaveBeenCalledTimes(1);
    });

    it("leaves out a surface the shell does not offer, rather than drawing a dead one", () => {
      render(<QuietRail onToggleGitPanel={vi.fn()} onToggleMemoryPanel={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Workflows" })).not.toBeInTheDocument();
    });

    /* The health flag used to be aggregated onto the More button because the
       thing it described was hidden inside the menu. It goes back on Memory. */
    it("marks Memory itself when Memory has a health flag", () => {
      useHealthStore.setState({
        flags: [
          {
            key: "memory:maestro",
            area: "memory",
            scope: "maestro",
            target: "maestro",
            reason: "12 stale files",
          },
        ],
      });
      renderRail();
      expect(screen.getByRole("button", { name: "Memory" })).toContainElement(
        screen.getByLabelText("1 health item need a look"),
      );
    });

    it("marks Landscape when a terminal somewhere is waiting for input", () => {
      renderRail({ landscapeAttention: true, landscapeView: false });
      expect(
        screen.getByRole("button", { name: "Landscape" }).querySelector("span[aria-hidden]"),
      ).toBeInTheDocument();
    });
  });
});
