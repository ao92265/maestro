import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { type SubagentInfo, useAgentStore } from "@/stores/useAgentStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { AgentGraph, buildExportMarkdown } from "../AgentGraph";

function session(id: number, overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: "C:/proj",
    ...overrides,
  };
}

function agent(
  sessionId: number,
  agentId: string,
  overrides?: Partial<SubagentInfo>,
): SubagentInfo {
  return {
    agentId,
    sessionId,
    agentType: "Explore",
    description: "search for auth code",
    prompt: "Find every call site of authenticate()",
    runInBackground: false,
    parentAgentId: null,
    spawnedAt: "2026-07-30T10:00:00.000Z",
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

describe("AgentGraph", () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: [] });
    useSessionStore.setState({ sessions: [] });
  });

  it("shows the empty state when the session does not exist", () => {
    render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("No active agent session")).toBeInTheDocument();
  });

  it("renders the root node with the session name and a hint when no agents run", () => {
    useSessionStore.setState({ sessions: [session(1, { name: "My Session" })] });
    render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("My Session")).toBeInTheDocument();
    expect(
      screen.getByText("No subagents running — agents spawned via the Task tool will appear here."),
    ).toBeInTheDocument();
  });

  it("renders one node per agent with RUNNING/DONE/FAILED badges and one edge each", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_run", { agentType: "Explore" }),
        agent(1, "toolu_done", {
          agentType: "Plan",
          spawnedAt: "2026-07-30T10:01:00.000Z",
          completedAt: Date.now(),
          success: true,
        }),
        agent(1, "toolu_fail", {
          agentType: "Bash",
          spawnedAt: "2026-07-30T10:02:00.000Z",
          completedAt: Date.now(),
          success: false,
        }),
      ],
    });
    const { container } = render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText("DONE")).toBeInTheDocument();
    expect(screen.getByText("FAILED")).toBeInTheDocument();
    // Scoped to the edge overlay: the toolbar's icons are <svg><path> too.
    expect(container.querySelectorAll("svg.absolute > path")).toHaveLength(3);
  });

  it("renders a nested agent one column right of its parent, with its own edge", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_parent", { agentType: "Orchestrator" }),
        agent(1, "toolu_child", {
          agentType: "NestedExplore",
          parentAgentId: "toolu_parent",
          spawnedAt: "2026-07-30T10:01:00.000Z",
        }),
      ],
    });
    const { container } = render(<AgentGraph sessionId={1} />);
    const parentNode = screen.getByText("Orchestrator").closest("button")!;
    const childNode = screen.getByText("NestedExplore").closest("button")!;
    const left = (el: HTMLElement) => Number.parseFloat(el.style.left);
    expect(left(childNode)).toBeGreaterThan(left(parentNode));
    // One edge per agent, nested or not.
    expect(container.querySelectorAll("svg.absolute > path")).toHaveLength(2);
  });

  it("parks an agent whose parent is unknown at the root instead of hiding it", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [agent(1, "toolu_lost", { agentType: "Lost", parentAgentId: "toolu_gone" })],
    });
    render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("Lost")).toBeInTheDocument();
  });

  it("updates live when a new agent lands in the store", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    render(<AgentGraph sessionId={1} />);
    expect(screen.queryByText("Explore")).not.toBeInTheDocument();

    act(() => {
      useAgentStore.setState({ agents: [agent(1, "toolu_new")] });
    });
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
  });

  it("excludes agents belonging to other sessions", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_mine", { agentType: "Mine" }),
        agent(2, "toolu_other", { agentType: "Other" }),
      ],
    });
    const { container } = render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(container.querySelectorAll("svg.absolute > path")).toHaveLength(1);
  });

  it("shows the model, duration, tokens and tool counts on a finished node", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_done", {
          completedAt: Date.now(),
          success: true,
          model: "claude-fable-5",
          durationMs: 1_659_000,
          totalTokens: 231_047,
          toolUseCount: 57,
          toolStats: {
            read_count: 10,
            search_count: 3,
            bash_count: 0,
            edit_file_count: 1,
            lines_added: 137,
            lines_removed: 0,
            other_tool_count: 4,
          },
        }),
      ],
    });
    render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("fable-5 · 27m 39s · 231k tok · 57 tools")).toBeInTheDocument();
    expect(screen.getByTitle("10 files read")).toBeInTheDocument();
    expect(screen.getByTitle("137 lines added, 0 removed")).toBeInTheDocument();
  });

  it("clicking a node opens the drawer with the brief and the report", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_done", {
          completedAt: Date.now(),
          success: true,
          prompt: "You are the DEV agent. Ship issue 64.",
          report: "agent-status: done, 12 tests pass",
        }),
      ],
    });
    render(<AgentGraph sessionId={1} />);
    expect(screen.queryByText("Brief sent ↓")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Show the brief sent and the report returned"));

    expect(screen.getByText("Brief sent ↓")).toBeInTheDocument();
    expect(screen.getByText("You are the DEV agent. Ship issue 64.")).toBeInTheDocument();
    expect(screen.getByText("Report back ↑")).toBeInTheDocument();
    expect(screen.getByText("agent-status: done, 12 tests pass")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close agent detail"));
    expect(screen.queryByText("Brief sent ↓")).not.toBeInTheDocument();
  });

  it("a running agent's drawer says the report is still to come", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({ agents: [agent(1, "toolu_run")] });
    render(<AgentGraph sessionId={1} />);

    fireEvent.click(screen.getByTitle("Show the brief sent and the report returned"));
    expect(
      screen.getByText("Still running — the report arrives when it finishes."),
    ).toBeInTheDocument();
  });

  it("dismissing a node removes it without opening the drawer", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_a", { agentType: "Keep" }),
        agent(1, "toolu_b", {
          agentType: "Drop",
          spawnedAt: "2026-07-30T10:05:00.000Z",
          completedAt: Date.now(),
          success: true,
        }),
      ],
    });
    render(<AgentGraph sessionId={1} />);

    fireEvent.click(screen.getByLabelText("Dismiss Drop"));

    expect(screen.queryByText("Drop")).not.toBeInTheDocument();
    expect(screen.getByText("Keep")).toBeInTheDocument();
    expect(screen.queryByText("Brief sent ↓")).not.toBeInTheDocument();
  });

  it("Clear finished removes only the completed agents", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_run", { agentType: "StillGoing" }),
        agent(1, "toolu_done", {
          agentType: "Finished",
          spawnedAt: "2026-07-30T10:05:00.000Z",
          completedAt: Date.now(),
          success: true,
        }),
      ],
    });
    render(<AgentGraph sessionId={1} />);

    fireEvent.click(screen.getByText("Clear finished (1)"));

    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
    expect(screen.getByText("StillGoing")).toBeInTheDocument();
  });

  it("an unrecognised status is shown verbatim rather than as DONE", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({
      agents: [
        agent(1, "toolu_odd", {
          completedAt: Date.now(),
          success: true,
          status: "some_new_status",
        }),
      ],
    });
    render(<AgentGraph sessionId={1} />);
    expect(screen.getByText("SOME NEW STATUS")).toBeInTheDocument();
    expect(screen.queryByText("DONE")).not.toBeInTheDocument();
  });
});

describe("buildExportMarkdown", () => {
  it("writes the brief, the report and the counters for every agent", () => {
    const md = buildExportMarkdown(
      [
        agent(1, "toolu_a", {
          agentType: "general-purpose",
          description: "TDD-implement #64",
          prompt: "You are the DEV agent.",
          report: "agent-status: done",
          completedAt: Date.parse("2026-07-30T10:30:00.000Z"),
          success: true,
          model: "claude-fable-5",
          durationMs: 1_659_000,
          totalTokens: 231_047,
          toolUseCount: 57,
          agentRunId: "a4967701",
          toolStats: {
            read_count: 10,
            search_count: 3,
            bash_count: 0,
            edit_file_count: 1,
            lines_added: 137,
            lines_removed: 0,
            other_tool_count: 4,
          },
        }),
      ],
      "My Session",
    );

    expect(md).toContain("# Agent run — My Session");
    expect(md).toContain("## 1. general-purpose — TDD-implement #64");
    expect(md).toContain("- Model: claude-fable-5");
    expect(md).toContain("- Agent run id: a4967701");
    expect(md).toContain("- Duration: 27m 39s");
    expect(md).toContain("- Tokens: 231047");
    expect(md).toContain("10 read, 3 search, 0 bash, 1 edit (+137/-0 lines), 4 other");
    expect(md).toContain("### Brief sent");
    expect(md).toContain("You are the DEV agent.");
    expect(md).toContain("### Report back");
    expect(md).toContain("agent-status: done");
  });

  it("says so plainly when a brief or report was never recorded", () => {
    const md = buildExportMarkdown([agent(1, "toolu_a", { prompt: "", report: "" })], "S");
    expect(md.match(/_\(none recorded\)_/g)).toHaveLength(2);
  });
});
