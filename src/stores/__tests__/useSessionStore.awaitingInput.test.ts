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

/**
 * A subagent of `sessionId`. `spawnedAt` defaults to "just now" because the
 * running-subagent heuristic ages agents out (see SUBAGENT_STALE_MS): a
 * hardcoded date would read as stale the day after it was written.
 */
function agent(
  sessionId: number,
  agentId: string,
  completedAt: number | null,
  spawnedAt: string = new Date().toISOString(),
): SubagentInfo {
  return {
    agentId,
    sessionId,
    agentType: "Explore",
    description: "look around",
    prompt: "go",
    runInBackground: true,
    spawnedAt,
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

/** A status the agent reported itself over MCP. */
function mcpStatus(sessionId: number, status: BackendSessionStatus, message: string) {
  return {
    session_id: sessionId,
    project_path: PROJECT,
    status,
    message,
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
    // removeSession is what drops the per-session turn bookkeeping (pending
    // subagent re-checks, "already reported done" marks) that lives outside the
    // store state, so one test cannot leak into the next.
    for (const id of [1, 2, 9]) useSessionStore.getState().removeSession(id);
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

  it("keeps a terminal state the agent reported during this same turn", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emit(mcpStatus(1, "Done", "all finished"));
    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("Done");
  });

  /**
   * Issue #77 cause 1. The old rule read the session's *current* status, so a
   * session that had ever reported `Done` swallowed every later turn end — it
   * kept saying "done" while the agent sat waiting for an answer.
   */
  it("flags NeedsInput when the stop closes a later turn than the Done", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emit(mcpStatus(1, "Done", "all finished"));
    emit(awaitingInput(1)); // end of the turn that reported Done
    emit(awaitingInput(1)); // a later turn, with no fresh report

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("flags NeedsInput on a stop for a session sitting at a stale Done", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("flags NeedsInput on a stop for a session that timed out starting", () => {
    useSessionStore.setState({ sessions: [session(1, "Timeout")] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  /**
   * Issue #77 cause 3: the backend buffers a turn end for a session it has not
   * registered yet, and the frontend does the same — the status must survive
   * until the session shows up rather than being dropped on the floor.
   */
  it("keeps a stop that beats its session into the store", () => {
    emit(awaitingInput(9));

    useSessionStore.getState().addSession(session(9, "Starting"));

    const added = useSessionStore.getState().sessions.find((s) => s.id === 9);
    expect(added?.status).toBe("NeedsInput");
  });

  /** Issue #77 cause 4: a completion event that never arrived. */
  it("does not trust a subagent that has been running implausibly long", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    useAgentStore.setState({ agents: [agent(1, "a1", null, anHourAgo)] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("stops holding Working once its subagents age out without completing", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [session(1)] });
      useAgentStore.setState({ agents: [agent(1, "a1", null)] });

      emit(awaitingInput(1));
      expect(useSessionStore.getState().sessions[0].status).toBe("Working");

      // Nothing ever reports the subagent finished.
      vi.advanceTimersByTime(31 * 60 * 1000);

      const updated = useSessionStore.getState().sessions[0];
      expect(updated.status).toBe("NeedsInput");
      expect(updated.statusMessage).toContain("Subagents stopped reporting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the session alone when the subagents are still fresh", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [session(1)] });
      useAgentStore.setState({ agents: [agent(1, "a1", null)] });

      emit(awaitingInput(1));
      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(useSessionStore.getState().sessions[0].status).toBe("Working");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Issue #77 cause 5: the event and the session can spell the same directory
   * differently (Windows canonical `\\?\` prefix, drive-letter case, trailing
   * separator). Matching on the raw string dropped the update entirely.
   */
  it("applies a status whose project path is only spelled differently", () => {
    useSessionStore.setState({ sessions: [session(1, "Idle")] });

    emit({
      session_id: 1,
      project_path: "\\\\?\\c:\\PROJ\\",
      status: "Working",
      message: "building",
    });

    expect(useSessionStore.getState().sessions[0].status).toBe("Working");
  });

  it("applies a stop whose project path is only spelled differently", () => {
    useSessionStore.setState({ sessions: [session(1, "Idle")] });

    emit({
      session_id: 1,
      project_path: "\\\\?\\c:\\PROJ\\",
      status: "AwaitingInput",
      message: "Waiting for your input",
    });

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });
});
