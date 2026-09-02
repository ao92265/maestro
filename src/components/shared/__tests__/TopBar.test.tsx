import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// TopBar reads the real Tauri window unconditionally on mount (the
// minimize/maximize/close handlers close over it even though
// hideWindowControls keeps those buttons out of these tests).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

import { useBandStore } from "@/stores/useBandStore";
import { useHealthStore } from "@/stores/useHealthStore";
import type { SessionConfig } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { TopBar } from "../TopBar";

function renderTopBar(overrides: Partial<ComponentProps<typeof TopBar>> = {}) {
  const handlers = {
    onToggleSidebar: vi.fn(),
    onToggleLandscapeView: vi.fn(),
    onToggleMemoryPanel: vi.fn(),
    onOpenWorkflows: vi.fn(),
    onOpenExtensions: vi.fn(),
  };
  render(<TopBar sidebarOpen hideWindowControls {...handlers} {...overrides} />);
  return handlers;
}

describe("TopBar", () => {
  beforeEach(() => {
    useHealthStore.setState({ flags: [] });
    useSessionStore.setState({ sessions: [] });
    useBandStore.setState({ handoffs: [] });
  });

  /**
   * Quiet Deck's crumb: the one line the chrome keeps. It names the surface
   * you are on and the two counts worth a glance.
   *
   * "Parked" is banned here on purpose. The pivot's data-honesty rule was
   * written against exactly this string: handoff files on disk were being
   * reported as parked sessions while Alex was typing in that directory in
   * iTerm. The count is real, the noun has to be too.
   */
  describe("the crumb", () => {
    function withCounts(live: number, handoffs: number) {
      useSessionStore.setState({
        sessions: Array.from({ length: live }, (_, i) => ({
          id: i + 1,
          status: "Working",
          project_path: `/tmp/p${i}`,
        })) as SessionConfig[],
      });
      useBandStore.setState({
        handoffs: Array.from({ length: handoffs }, (_, i) => ({
          slug: `h${i}`,
          path: `/tmp/h${i}`,
          repo: `h${i}`,
        })) as ReturnType<typeof useBandStore.getState>["handoffs"],
      });
    }

    it("names the surface you are actually on", () => {
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      expect(screen.getByTestId("topbar-crumb")).toHaveTextContent("Board");
    });

    it("names the grid when the Board layer is closed", () => {
      renderTopBar({ boardViewOpen: false, onSetBoardView: vi.fn() });
      expect(screen.getByTestId("topbar-crumb")).toHaveTextContent("Grid");
    });

    it("counts handoffs as files on disk, never as parked sessions", () => {
      withCounts(2, 10);
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      const crumb = screen.getByTestId("topbar-crumb");
      expect(crumb).toHaveTextContent("10 handoffs on disk");
      expect(crumb.textContent).not.toMatch(/parked/i);
    });

    it("counts only live sessions as live", () => {
      withCounts(3, 0);
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      expect(screen.getByTestId("topbar-crumb")).toHaveTextContent("3 live");
    });

    it("says nothing rather than zero when there is nothing to count", () => {
      withCounts(0, 0);
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      const crumb = screen.getByTestId("topbar-crumb");
      expect(crumb).not.toHaveTextContent("0 live");
      expect(crumb).not.toHaveTextContent("0 handoffs");
    });

    it("does not count a finished session as live", () => {
      useSessionStore.setState({
        sessions: [
          { id: 1, status: "Working", project_path: "/tmp/a" },
          { id: 2, status: "Done", project_path: "/tmp/b" },
          { id: 3, status: "Error", project_path: "/tmp/c" },
        ] as SessionConfig[],
      });
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      expect(screen.getByTestId("topbar-crumb")).toHaveTextContent("1 live");
    });
  });

  /**
   * The "+" is the only route to a first terminal on a cold start, and it used
   * to appear ONLY once a session was already running. These cases exist
   * because a green suite happily shipped both a missing button and, briefly,
   * a present-but-inert one.
   */
  describe("the add-terminal button", () => {
    it("is offered before any session has been launched", () => {
      renderTopBar({ hasProject: true, slotCount: 0, maxSessions: 4 });
      expect(screen.getByRole("button", { name: "Add session" })).toBeEnabled();
    });

    it("is absent with no project open, rather than present and inert", () => {
      renderTopBar({ hasProject: false, slotCount: 0, maxSessions: 4 });
      expect(screen.queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
    });

    it("is absent in eagle view, which offers a project picker instead", () => {
      renderTopBar({ hasProject: true, eagleView: true, slotCount: 0, maxSessions: 4 });
      expect(screen.queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
    });

    it("says why it is disabled at the terminal cap", () => {
      renderTopBar({ hasProject: true, slotCount: 4, maxSessions: 4 });
      const button = screen.getByRole("button", { name: "Add session" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Maximum of 4 terminals in this project");
    });

    it("calls back when clicked below the cap", () => {
      const onAddSession = vi.fn();
      renderTopBar({ hasProject: true, slotCount: 1, maxSessions: 4, onAddSession });
      fireEvent.click(screen.getByRole("button", { name: "Add session" }));
      expect(onAddSession).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * From an overlay, both segments used to look dead: one opened the Board
   * underneath what you were reading, the other closed a Board you could not
   * see. The TopBar's job is to name the surface it wants; App decides how.
   */
  describe("the Board/Grid selector", () => {
    it("asks for the Board, not for a blind toggle", () => {
      const onSetBoardView = vi.fn();
      renderTopBar({ onSetBoardView, boardViewOpen: false });
      fireEvent.click(screen.getByRole("button", { name: "Board view" }));
      expect(onSetBoardView).toHaveBeenCalledWith(true);
    });

    it("asks for the grid even when the Board is already the base surface", () => {
      const onSetBoardView = vi.fn();
      renderTopBar({ onSetBoardView, boardViewOpen: true });
      fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
      expect(onSetBoardView).toHaveBeenCalledWith(false);
    });
  });

  it("does not render the buttons cut by the declutter (Notes, Second Brain, Launch)", () => {
    renderTopBar();
    for (const label of ["Notes", "Second Brain", "Launch"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    // Landscape and Memory also lose their standalone buttons — only the
    // "Landscape view" aria-label is unique to the old button, so check that.
    expect(screen.queryByRole("button", { name: "Landscape view" })).not.toBeInTheDocument();
  });

  it("renders the More menu closed by default and opens it on click", () => {
    renderTopBar();
    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByRole("button", { name: "Landscape" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extensions" })).toBeInTheDocument();
  });

  it("dispatches onToggleLandscapeView and closes the menu", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Landscape" }));

    expect(handlers.onToggleLandscapeView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
  });

  it("dispatches onToggleMemoryPanel", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));

    expect(handlers.onToggleMemoryPanel).toHaveBeenCalledTimes(1);
  });

  it("dispatches onOpenWorkflows", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));

    expect(handlers.onOpenWorkflows).toHaveBeenCalledTimes(1);
  });

  it("dispatches onOpenExtensions", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));

    expect(handlers.onOpenExtensions).toHaveBeenCalledTimes(1);
  });

  it("closes the More menu on an outside click", () => {
    renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Landscape" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
  });

  it("has no Board/Grid toggle when the shell does not offer one", () => {
    renderTopBar();
    expect(screen.queryByRole("button", { name: "Board view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grid view" })).not.toBeInTheDocument();
  });

  it("marks the Board segment as the active one while the Board is open", () => {
    const onSetBoardView = vi.fn();
    renderTopBar({ boardViewOpen: true, onSetBoardView });

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
    renderTopBar({ boardViewOpen: false, onSetBoardView });

    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("asks for the grid when the Grid segment is clicked", () => {
    const onSetBoardView = vi.fn();
    renderTopBar({ boardViewOpen: true, onSetBoardView });

    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    expect(onSetBoardView).toHaveBeenCalledWith(false);
  });

  it("asks for the board when the Board segment is clicked", () => {
    const onSetBoardView = vi.fn();
    renderTopBar({ boardViewOpen: false, onSetBoardView });

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
    renderTopBar();

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
    renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByLabelText("1 health item need a look")).toBeInTheDocument();
  });
});
