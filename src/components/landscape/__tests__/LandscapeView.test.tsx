import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The persisted workspace store hydrates through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { LandscapeView } from "../LandscapeView";
import { useAgentStore, type SubagentInfo } from "@/stores/useAgentStore";
import { useLandscapeLayoutStore } from "@/stores/useLandscapeLayoutStore";
import { useSessionStore, type SessionConfig } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

/**
 * React Flow measures its container and nodes through browser APIs happy-dom
 * doesn't implement. These are the stubs React Flow's own docs prescribe for
 * a jsdom/happy-dom test environment.
 */
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
      constructor(_transform?: string) {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => {},
    }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
});

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [1],
    sessionsLaunched: true,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function buildSession(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 1,
    mode: "Claude",
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: "C:\\git\\maestro",
    name: "backend",
    ...overrides,
  };
}

function buildAgent(agentId: string, overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId,
    sessionId: 1,
    agentType: "Explore",
    description: "search for auth code",
    prompt: "Find every call site of authenticate()",
    runInBackground: false,
    spawnedAt: "2026-08-04T10:00:00.000Z",
    completedAt: null,
    success: null,
    report: "",
    status: null,
    model: null,
    durationMs: null,
    totalTokens: null,
    toolUseCount: null,
    toolStats: null,
    agentRunId: null,
    ...overrides,
  };
}

function renderLandscape(onNavigate = vi.fn(), onClose = vi.fn()) {
  const result = render(<LandscapeView onNavigate={onNavigate} onClose={onClose} />);
  return { ...result, onNavigate, onClose };
}

describe("LandscapeView", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    useSessionStore.setState({ sessions: [buildSession()] });
    useAgentStore.setState({ agents: [buildAgent("a1")] });
    useLandscapeLayoutStore.setState({ positions: {} });
    localStorage.clear();
  });

  it("shows a node for the project, the terminal and each subagent", () => {
    renderLandscape();
    expect(screen.getByText("maestro")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("search for auth code")).toBeInTheDocument();
  });

  it("counts the landscape in its header", () => {
    renderLandscape();
    expect(screen.getByText(/1 project · 1 terminal · 1 agent running/)).toBeInTheDocument();
  });

  it("opens the brief/report drawer when a subagent is clicked", () => {
    renderLandscape();
    fireEvent.click(screen.getByText("Explore"));
    expect(screen.getByText("Brief sent ↓")).toBeInTheDocument();
    expect(screen.getByText("Find every call site of authenticate()")).toBeInTheDocument();
    // The drawer names where the agent lives, which the node itself can't show.
    expect(screen.getByText(/maestro · backend/)).toBeInTheDocument();
  });

  it("navigates to a terminal and leaves the landscape", () => {
    const { onNavigate, onClose } = renderLandscape();
    fireEvent.click(screen.getByLabelText("Go to terminal backend"));
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 1);
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates to a project without a session id", () => {
    const { onNavigate } = renderLandscape();
    fireEvent.click(screen.getByLabelText("Open project maestro"));
    expect(onNavigate).toHaveBeenCalledWith("tab-1", undefined);
  });

  it("dismisses one agent from the graph", () => {
    renderLandscape();
    fireEvent.click(screen.getByLabelText("Dismiss Explore"));
    expect(useAgentStore.getState().agents).toHaveLength(0);
  });

  it("dims what the filter doesn't match instead of hiding it", () => {
    useAgentStore.setState({
      agents: [buildAgent("a1"), buildAgent("a2", { description: "review the migration" })],
    });
    const { container } = renderLandscape();
    fireEvent.change(screen.getByLabelText("Filter the landscape"), {
      target: { value: "migration" },
    });
    const kept = container.querySelector('[data-id="agent:1:a2"]')?.firstElementChild;
    const faded = container.querySelector('[data-id="agent:1:a1"]')?.firstElementChild;
    expect(kept).toHaveClass("opacity-100");
    expect(faded).toHaveClass("opacity-25");
  });

  it("'Active only' fades finished agents", () => {
    useAgentStore.setState({
      agents: [
        buildAgent("a1"),
        buildAgent("a2", { completedAt: Date.parse("2026-08-04T10:05:00Z"), success: true }),
      ],
    });
    const { container } = renderLandscape();
    fireEvent.click(screen.getByText("Active only"));
    expect(container.querySelector('[data-id="agent:1:a1"]')?.firstElementChild).toHaveClass(
      "opacity-100",
    );
    expect(container.querySelector('[data-id="agent:1:a2"]')?.firstElementChild).toHaveClass(
      "opacity-25",
    );
  });

  it("clears every finished agent across all terminals", () => {
    useAgentStore.setState({
      agents: [
        buildAgent("a1"),
        buildAgent("a2", { completedAt: Date.parse("2026-08-04T10:05:00Z"), success: true }),
      ],
    });
    renderLandscape();
    fireEvent.click(screen.getByText(/Clear done \(1\)/));
    expect(useAgentStore.getState().agents.map((a) => a.agentId)).toEqual(["a1"]);
  });

  it("clears dead agents — still 'running' but their terminal ended", () => {
    // Session 1 is Done: its running agent can never complete.
    useSessionStore.setState({ sessions: [buildSession({ status: "Done" })] });
    useAgentStore.setState({ agents: [buildAgent("a1")] });
    renderLandscape();
    fireEvent.click(screen.getByText(/Clear done \(1\)/));
    expect(useAgentStore.getState().agents).toHaveLength(0);
  });

  it("'Reorganize' throws away every manual position", () => {
    useLandscapeLayoutStore.setState({ positions: { "project:tab-1": { x: 999, y: 999 } } });
    renderLandscape();
    fireEvent.click(screen.getByText("Reorganize"));
    expect(useLandscapeLayoutStore.getState().positions).toEqual({});
  });

  it("counts the terminals waiting for input", () => {
    useSessionStore.setState({ sessions: [buildSession({ status: "NeedsInput" })] });
    renderLandscape();
    expect(screen.getByText(/Needs input \(1\)/)).toBeInTheDocument();
  });

  it("Escape closes the drawer first, then the landscape", () => {
    const { onClose } = renderLandscape();
    fireEvent.click(screen.getByText("Explore"));
    expect(screen.getByText("Brief sent ↓")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Brief sent ↓")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("tells you when there is nothing to show", () => {
    useWorkspaceStore.setState({ tabs: [] });
    renderLandscape();
    expect(screen.getByText(/No projects open/)).toBeInTheDocument();
  });
});
