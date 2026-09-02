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

  it("renders the More menu closed by default and opens it on click", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByRole("button", { name: "Landscape" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extensions" })).toBeInTheDocument();
  });

  it("dispatches onToggleLandscapeView and closes the menu", () => {
    const handlers = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Landscape" }));

    expect(handlers.onToggleLandscapeView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
  });

  it("dispatches onToggleMemoryPanel", () => {
    const handlers = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));

    expect(handlers.onToggleMemoryPanel).toHaveBeenCalledTimes(1);
  });

  it("dispatches onOpenWorkflows", () => {
    const handlers = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));

    expect(handlers.onOpenWorkflows).toHaveBeenCalledTimes(1);
  });

  it("dispatches onOpenExtensions", () => {
    const handlers = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));

    expect(handlers.onOpenExtensions).toHaveBeenCalledTimes(1);
  });

  it("closes the More menu on an outside click", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Landscape" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
  });

  it("has no Board/Grid toggle when the shell does not offer one", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Board view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grid view" })).not.toBeInTheDocument();
  });

  it("marks the Board segment as the active one while the Board is open", () => {
    const onSetBoardView = vi.fn();
    renderRail({ boardViewOpen: true, onSetBoardView });

    expect(screen.getByRole("button", { name: "Board view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks the Grid segment as the active one while the Board is closed", () => {
    const onSetBoardView = vi.fn();
    renderRail({ boardViewOpen: false, onSetBoardView });

    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("asks for the grid when the Grid segment is clicked", () => {
    const onSetBoardView = vi.fn();
    renderRail({ boardViewOpen: true, onSetBoardView });

    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    expect(onSetBoardView).toHaveBeenCalledWith(false);
  });

  it("asks for the board when the Board segment is clicked", () => {
    const onSetBoardView = vi.fn();
    renderRail({ boardViewOpen: false, onSetBoardView });

    fireEvent.click(screen.getByRole("button", { name: "Board view" }));

    expect(onSetBoardView).toHaveBeenCalledWith(true);
  });

  it("shows an aggregated dot on the More button when Memory has a health flag", () => {
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

    const moreButton = screen.getByRole("button", { name: "More" });
    expect(moreButton.querySelector("span[aria-hidden]")).toBeInTheDocument();
  });

  it("shows the per-item health badge on the Memory row inside the menu", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByLabelText("1 health item need a look")).toBeInTheDocument();
  });
});
