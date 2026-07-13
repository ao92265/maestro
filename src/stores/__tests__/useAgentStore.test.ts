import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { AGENT_DONE_LINGER_MS, useAgentStore, type SubagentInfo } from "../useAgentStore";
import { useSessionStore, type SessionConfig } from "../useSessionStore";

function spawned(sessionId: number, agentId: string) {
  return {
    event_type: "SubagentSpawned" as const,
    session_id: sessionId,
    agent_type: "Explore",
    agent_id: agentId,
    description: "search for auth code",
    timestamp: "2026-07-13T10:00:00.000Z",
  };
}

function completed(sessionId: number, agentId: string, success = true, timestamp?: string) {
  return {
    event_type: "SubagentCompleted" as const,
    session_id: sessionId,
    agent_id: agentId,
    success,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

function session(id: number): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: "C:/proj",
  };
}

describe("useAgentStore", () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: [] });
    useSessionStore.setState({ sessions: [] });
  });

  it("SubagentSpawned adds a running agent", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    const agents = useAgentStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: "toolu_a",
      sessionId: 1,
      agentType: "Explore",
      completedAt: null,
      success: null,
    });
  });

  it("duplicate SubagentSpawned is ignored", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    expect(useAgentStore.getState().agents).toHaveLength(1);
  });

  it("SubagentCompleted marks the agent done with the event's success flag", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", false));
    const agent = useAgentStore.getState().agents[0];
    expect(agent.completedAt).not.toBeNull();
    expect(agent.success).toBe(false);
  });

  it("completedAt comes from the event timestamp, not the wall clock", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    const oldTs = "2026-07-01T00:00:00.000Z";
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", true, oldTs));
    expect(useAgentStore.getState().agents[0].completedAt).toBe(Date.parse(oldTs));
  });

  it("SubagentCompleted for an unknown id changes nothing", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    const before = useAgentStore.getState().agents;
    useAgentStore.getState().handleEvent(completed(1, "toolu_other"));
    expect(useAgentStore.getState().agents).toBe(before);
  });

  it("completion does not overwrite an already-completed agent", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", false));
    const completedAt = useAgentStore.getState().agents[0].completedAt;
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", true));
    expect(useAgentStore.getState().agents[0].success).toBe(false);
    expect(useAgentStore.getState().agents[0].completedAt).toBe(completedAt);
  });

  it("prune drops agents past the linger window but keeps recent ones", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    const now = Date.now();
    const base: Omit<SubagentInfo, "agentId" | "completedAt"> = {
      sessionId: 1,
      agentType: "Explore",
      description: "",
      spawnedAt: "",
      success: true,
    };
    useAgentStore.setState({
      agents: [
        { ...base, agentId: "old", completedAt: now - AGENT_DONE_LINGER_MS - 1000 },
        { ...base, agentId: "recent", completedAt: now - 1000 },
        { ...base, agentId: "running", completedAt: null, success: null },
      ],
    });
    useAgentStore.getState().prune();
    const ids = useAgentStore.getState().agents.map((a) => a.agentId);
    expect(ids).toEqual(["recent", "running"]);
  });

  it("prune drops agents whose session no longer exists", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.getState().handleEvent(spawned(1, "toolu_live"));
    useAgentStore.getState().handleEvent(spawned(99, "toolu_orphan"));
    useAgentStore.getState().prune();
    const ids = useAgentStore.getState().agents.map((a) => a.agentId);
    expect(ids).toEqual(["toolu_live"]);
  });
});
