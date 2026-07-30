import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { AgentGraph } from "../AgentGraph";
import { useAgentStore, type SubagentInfo } from "@/stores/useAgentStore";
import { useSessionStore, type SessionConfig } from "@/stores/useSessionStore";

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
  overrides?: Partial<SubagentInfo>
): SubagentInfo {
  return {
    agentId,
    sessionId,
    agentType: "Explore",
    description: "search for auth code",
    spawnedAt: "2026-07-30T10:00:00.000Z",
    completedAt: null,
    success: null,
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
      screen.getByText("No subagents running — agents spawned via the Task tool will appear here.")
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
    expect(container.querySelectorAll("svg path")).toHaveLength(3);
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
    expect(container.querySelectorAll("svg path")).toHaveLength(1);
  });
});
