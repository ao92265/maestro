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

    /* The count is defined as "sessions the board draws a card for, outside
       Done", so the crumb and the lanes can never print different totals for
       the same machine. Done drops out; an errored session does not, because
       the board still shows it in Building and it still wants you. */
    it("does not count a finished session as live", () => {
      useSessionStore.setState({
        sessions: [
          { id: 1, status: "Working", project_path: "/tmp/a" },
          { id: 2, status: "Done", project_path: "/tmp/b" },
          { id: 3, status: "Error", project_path: "/tmp/c" },
        ] as SessionConfig[],
      });
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      expect(screen.getByTestId("topbar-crumb")).toHaveTextContent("2 live");
    });

    /* Idle terminals used to count. Three open shells with nothing running
       read as "3 live" in the chrome while the board below them correctly
       said nothing was running: the two disagreed on one screen. */
    it("does not count an idle terminal the board gives no card", () => {
      useSessionStore.setState({
        sessions: [
          { id: 1, status: "Idle", project_path: "/tmp/a" },
          { id: 2, status: "Idle", project_path: "/tmp/b" },
        ] as SessionConfig[],
      });
      renderTopBar({ boardViewOpen: true, onSetBoardView: vi.fn() });
      expect(screen.getByTestId("topbar-crumb")).not.toHaveTextContent("live");
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
});
