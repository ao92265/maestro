import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The workspace and watchdog stores persist through the Tauri plugin-store,
   which has no window internals under vitest: without this stub every
   setState below throws an unhandled rejection out of the persist middleware
   (useWorkspaceStore.reorder.test.ts sets the same trap the same way). */
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { BoardView } from "@/components/board/BoardView";
import type { ActRun } from "@/lib/act";
import type { HandoffInfo, RepoPrs } from "@/lib/bands";
import { useActStore } from "@/stores/useActStore";
import { useBandStore } from "@/stores/useBandStore";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useTourStore } from "@/stores/useTourStore";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/* Fixtures are fully synthetic: this repo is public, so no real handoff
   slugs, project paths or pull request URLs appear here. */

function session(id: number, status: BackendSessionStatus): SessionConfig {
  return {
    id,
    name: `agent-${id}`,
    status,
    project_path: "/tmp/proj-a",
    statusMessage: `doing step ${id}`,
  } as SessionConfig;
}

function tab(): WorkspaceTab {
  return {
    id: "t1",
    name: "proj-a",
    projectPath: "/tmp/proj-a",
    selectedRepoPath: null,
  } as WorkspaceTab;
}

function handoff(): HandoffInfo {
  return {
    slug: "hand-1",
    path: "/tmp/proj-b",
    repo: "proj-b",
    branch: "main",
    uncommitted: 0,
    lastCommit: null,
    asks: [],
    lastAction: "left the migration half applied",
    waiting: false,
    lastActive: "2026-08-19T08:00:00Z",
    stale: false,
    orphan: false,
  };
}

function run(stage: string): ActRun {
  return {
    id: "run-1",
    title: "Ship the importer",
    status: "running",
    stage,
    stages: [],
    createdAt: "2026-08-19T06:00:00Z",
    updatedAt: "2026-08-19T06:30:00Z",
    repoUrl: null,
    error: null,
  };
}

function pr(): PullRequestInfo {
  return {
    number: 7,
    title: "Fix the importer",
    url: "https://example.test/pr/7",
    updatedAt: "2026-08-19T07:30:00Z",
    mergedAt: null,
  } as PullRequestInfo;
}

function changesRequestedRepo(): RepoPrs {
  return {
    repoPath: "/tmp/proj-a",
    projectName: "proj-a",
    changesRequested: [pr()],
    merged: [],
    error: null,
  };
}

function renderBoard(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onNavigateSession: vi.fn(),
    onOpenRun: vi.fn(),
    onLaunchHandoff: vi.fn(),
    onOpenPr: vi.fn(),
    onShowGrid: vi.fn(),
  };
  render(<BoardView {...handlers} {...overrides} />);
  return handlers;
}

function selectedCard(): Element | null {
  return document.querySelector('[data-selected="true"]');
}

function column(title: string) {
  return within(screen.getByRole("region", { name: title }));
}

describe("BoardView", () => {
  beforeEach(() => {
    /* A fresh environment opens the tour, which would swallow every key this
       suite presses. Board's own handler early-returns while it is open, and
       that behaviour has its own test below. */
    useTourStore.setState({ isOpen: false });
    useSessionStore.setState({ sessions: [] });
    useWorkspaceStore.setState({ tabs: [] });
    useBandStore.setState({
      handoffs: [],
      repoPrs: [],
      handoffsError: null,
      prsError: null,
      isRefreshing: false,
      watermarkMs: 0,
      externallyActiveDirs: new Set<string>(),
      refresh: vi.fn().mockResolvedValue(undefined),
      markSeen: vi.fn(),
    });
    useActStore.setState({
      runs: [],
      gatedRuns: [],
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    useGitHubWatchdogStore.setState({ projects: [] });
  });

  it("renders all six columns, each empty column saying what is empty", () => {
    renderBoard();

    for (const title of ["Suggested", "Planning", "Building", "Checking", "Review", "Done"]) {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText("No handoffs are waiting on disk.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is being built.")).toBeInTheDocument();
  });

  it("routes live work into the column its stage says it is in", () => {
    useSessionStore.setState({ sessions: [session(1, "Working"), session(2, "Starting")] });
    useWorkspaceStore.setState({ tabs: [tab()] });
    useBandStore.setState({ handoffs: [handoff()] });
    useActStore.setState({ runs: [run("qa")] });

    renderBoard();

    expect(column("Building").getByText("doing step 1")).toBeInTheDocument();
    expect(column("Planning").getByText("doing step 2")).toBeInTheDocument();
    expect(column("Suggested").getByText("left the migration half applied")).toBeInTheDocument();
    expect(column("Checking").getByText("Ship the importer")).toBeInTheDocument();
  });

  it("flags only the cards that are blocked on you", () => {
    useSessionStore.setState({ sessions: [session(1, "Working"), session(2, "NeedsInput")] });
    useWorkspaceStore.setState({ tabs: [tab()] });

    renderBoard();

    expect(screen.getAllByText("NEEDS YOU")).toHaveLength(1);
    const flagged = screen.getByText("NEEDS YOU").closest("button");
    expect(flagged?.textContent).toContain("doing step 2");
  });

  it("keeps an idle session off the board but visible in the fleet strip", () => {
    useSessionStore.setState({ sessions: [session(1, "Idle")] });
    useWorkspaceStore.setState({ tabs: [tab()] });

    renderBoard();

    expect(screen.queryByText("doing step 1")).not.toBeInTheDocument();
    expect(screen.getByTitle("IDLE: 1 session")).toBeInTheDocument();
    /* Plain counts, deliberately: a chip that looks clickable and is not is
       a dead control, and filtering by Idle would blank the whole board. */
    expect(screen.queryByRole("button", { name: /IDLE/ })).not.toBeInTheDocument();
  });

  it("moves the selection down with j and wraps to the last card with k", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useWorkspaceStore.setState({ tabs: [tab()] });
    useBandStore.setState({ handoffs: [handoff()] });

    renderBoard();
    expect(selectedCard()).toBeNull();

    // Reading order is column by column: the Suggested handoff comes first.
    fireEvent.keyDown(window, { key: "j" });
    expect(selectedCard()?.textContent).toContain("proj-b");

    fireEvent.keyDown(window, { key: "j" });
    expect(selectedCard()?.textContent).toContain("doing step 1");

    fireEvent.keyDown(window, { key: "j" });
    expect(selectedCard()?.textContent).toContain("proj-b");

    fireEvent.keyDown(window, { key: "k" });
    expect(selectedCard()?.textContent).toContain("doing step 1");
  });

  it("opens the selected session's terminal on Enter", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useWorkspaceStore.setState({ tabs: [tab()] });

    const handlers = renderBoard();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(handlers.onNavigateSession).toHaveBeenCalledWith("t1", 1);
  });

  it("launches the selected handoff on Enter", () => {
    useBandStore.setState({ handoffs: [handoff()] });

    const handlers = renderBoard();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(handlers.onLaunchHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/proj-b" }),
    );
  });

  it("opens the selected ACT run on Enter", () => {
    useActStore.setState({ runs: [run("build")] });

    const handlers = renderBoard();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(handlers.onOpenRun).toHaveBeenCalledWith("run-1");
  });

  it("opens the selected pull request on Enter", () => {
    useBandStore.setState({ repoPrs: [changesRequestedRepo()] });

    const handlers = renderBoard();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(handlers.onOpenPr).toHaveBeenCalledWith("https://example.test/pr/7");
  });

  it("opens a card on click as well as on Enter", () => {
    useBandStore.setState({ repoPrs: [changesRequestedRepo()] });

    const handlers = renderBoard();
    fireEvent.click(column("Review").getByRole("button"));

    expect(handlers.onOpenPr).toHaveBeenCalledWith("https://example.test/pr/7");
  });

  it("ignores j, k and Enter while the tour is open", () => {
    useBandStore.setState({ handoffs: [handoff()] });
    useTourStore.setState({ isOpen: true });

    const handlers = renderBoard();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(selectedCard()).toBeNull();
    expect(handlers.onLaunchHandoff).not.toHaveBeenCalled();
  });

  it("marks the Suggested column stale when the handoff read failed", () => {
    useBandStore.setState({ handoffsError: "get_handoffs: permission denied" });

    renderBoard();

    expect(column("Suggested").getByText("STALE")).toBeInTheDocument();
    expect(column("Building").queryByText("STALE")).not.toBeInTheDocument();
  });

  it("marks Review and Done stale, naming the repo, when a PR poll failed", () => {
    useBandStore.setState({
      repoPrs: [{ ...changesRequestedRepo(), changesRequested: [], error: "gh: not found" }],
    });

    renderBoard();

    expect(column("Review").getByText("STALE")).toBeInTheDocument();
    expect(column("Review").getByTitle("Could not poll: proj-a")).toBeInTheDocument();
    expect(column("Done").getByText("STALE")).toBeInTheDocument();
  });

  it("counts directories running claude outside Maestro on the Suggested header", () => {
    useBandStore.setState({ externallyActiveDirs: new Set(["/tmp/proj-c", "/tmp/proj-d"]) });

    renderBoard();

    expect(column("Suggested").getByText("2 active outside Maestro")).toBeInTheDocument();
  });

  it("says nothing about outside activity when nothing is running outside", () => {
    renderBoard();

    expect(screen.queryByText(/active outside Maestro/)).not.toBeInTheDocument();
  });

  it("refreshes, marks seen and switches to the grid from the header", () => {
    const handlers = renderBoard();
    const refresh = useBandStore.getState().refresh;
    const markSeen = useBandStore.getState().markSeen;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark seen" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    // One call on mount, one from the button.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(handlers.onShowGrid).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while a refresh is in flight", () => {
    useBandStore.setState({ isRefreshing: true });

    renderBoard();

    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("says the Factory is stale rather than showing an empty pipeline as truth", () => {
    useActStore.setState({ error: "connect ECONNREFUSED" });

    renderBoard();

    expect(screen.getByText("FACTORY STALE")).toBeInTheDocument();
  });
});
