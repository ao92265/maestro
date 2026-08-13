import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { listen } from "@tauri-apps/api/event";

import { type SubagentInfo, useAgentStore } from "../useAgentStore";
import { type BackendSessionStatus, type SessionConfig, useSessionStore } from "../useSessionStore";

const listenMock = vi.mocked(listen);

const PROJECT = "C:/proj";

function session(id: number, status: BackendSessionStatus = "Working"): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: PROJECT,
  };
}

function agent(sessionId: number, agentId: string, completedAt: number | null): SubagentInfo {
  return {
    agentId,
    sessionId,
    agentType: "Explore",
    description: "look around",
    prompt: "go",
    runInBackground: true,
    spawnedAt: "2026-08-05T10:00:00.000Z",
    completedAt,
    success: completedAt === null ? null : true,
    report: "",
    status: null,
    model: null,
    durationMs: null,
    totalTokens: null,
    toolUseCount: null,
    toolStats: null,
    agentRunId: null,
  };
}

/**
 * Feeds a payload to the store's `session-status-changed` handler, the way the
 * Tauri event would.
 *
 * The store registers that listener exactly once per module lifetime (it
 * ref-counts subscribers), so the handler is captured once in `beforeAll` and
 * reused — re-running `initListeners` per test would never call `listen` again.
 */
let handler: ((event: { payload: unknown }) => void) | null = null;

function emit(payload: Record<string, unknown>): void {
  if (!handler) throw new Error("session-status-changed listener was never registered");
  handler({ payload });
}

function awaitingInput(sessionId: number) {
  return {
    session_id: sessionId,
    project_path: PROJECT,
    status: "AwaitingInput",
    message: "Waiting for your input",
    needs_input_prompt: null,
  };
}

describe("session status: the Stop hook vs. running subagents", () => {
  beforeAll(async () => {
    listenMock.mockImplementation((async (
      _name: string,
      cb: (event: { payload: unknown }) => void,
    ) => {
      handler = cb;
      return () => {};
    }) as unknown as typeof listen);
    await useSessionStore.getState().initListeners();
  });

  beforeEach(() => {
    useSessionStore.setState({ sessions: [], parkedSessionIds: [], flaggedSessionIds: [] });
    useAgentStore.setState({ agents: [] });
  });

  it("reports NeedsInput when nothing else is running", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("reports Working when the agent handed off to background subagents", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({ agents: [agent(1, "a1", null), agent(1, "a2", null)] });

    emit(awaitingInput(1));

    const updated = useSessionStore.getState().sessions[0];
    expect(updated.status).toBe("Working");
    expect(updated.statusMessage).toBe("2 subagents running");
  });

  it("goes back to NeedsInput once the subagents have finished", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({ agents: [agent(1, "a1", Date.parse("2026-08-05T10:05:00Z"))] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("ignores subagents belonging to a different terminal", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useAgentStore.setState({ agents: [agent(2, "a1", null)] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("still never downgrades a terminal state the agent already reported", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("Done");
  });
});
