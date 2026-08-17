import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";

import type { BackendSessionRow, SessionConfig } from "../useSessionStore";
import { useSessionStore } from "../useSessionStore";

const invokeMock = vi.mocked(invoke);

const PROJECT = "C:/proj";

/** A backend row exactly as the Rust `SessionConfig` serializes it: no status. */
function row(id: number, projectPath = PROJECT): BackendSessionRow {
  return {
    id,
    mode: "Claude",
    name: null,
    branch: null,
    worktree_path: null,
    project_path: projectPath,
  };
}

/** A store session, i.e. a backend row plus the frontend-owned status fields. */
function stored(id: number, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { ...row(id), status: "Idle", ...overrides };
}

/**
 * Session status is frontend-owned (issue #134): the Rust `SessionManager` is
 * an in-memory `DashMap` that carries no status at all, so a fetch has nothing
 * authoritative to say about it and must never overwrite what the live MCP
 * `session-status-changed` stream already applied.
 */
describe("useSessionStore fetch merges frontend-owned status (issue #134)", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      flaggedSessionIds: [],
      attentionSessionIds: [],
    });
    invokeMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fetchSessions keeps the live status of a session already in the store", async () => {
    useSessionStore.setState({
      sessions: [
        stored(1, {
          status: "NeedsInput",
          statusMessage: "waiting on you",
          needsInputPrompt: "Which branch?",
        }),
      ],
    });
    invokeMock.mockResolvedValue([row(1)]);

    await useSessionStore.getState().fetchSessions();

    const [session] = useSessionStore.getState().sessions;
    expect(session.status).toBe("NeedsInput");
    expect(session.statusMessage).toBe("waiting on you");
    expect(session.needsInputPrompt).toBe("Which branch?");
  });

  it("fetchSessions lands a session new to the store as Idle", async () => {
    invokeMock.mockResolvedValue([row(7)]);

    await useSessionStore.getState().fetchSessions();

    expect(useSessionStore.getState().sessions.map((s) => [s.id, s.status])).toEqual([[7, "Idle"]]);
  });

  it("fetchSessions still prunes sessions the backend no longer reports", async () => {
    useSessionStore.setState({
      sessions: [stored(1, { status: "Working" }), stored(2)],
      parkedSessionIds: [2],
      flaggedSessionIds: [2],
      attentionSessionIds: [2],
    });
    invokeMock.mockResolvedValue([row(1)]);

    await useSessionStore.getState().fetchSessions();

    const state = useSessionStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual([1]);
    expect(state.sessions[0].status).toBe("Working");
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.flaggedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("fetchSessions still applies backend-owned fields (branch, worktree, name)", async () => {
    useSessionStore.setState({ sessions: [stored(1, { status: "Working" })] });
    invokeMock.mockResolvedValue([
      { ...row(1), name: "renamed", branch: "feat/x", worktree_path: "C:/wt" },
    ]);

    await useSessionStore.getState().fetchSessions();

    const [session] = useSessionStore.getState().sessions;
    expect(session.status).toBe("Working");
    expect(session.name).toBe("renamed");
    expect(session.branch).toBe("feat/x");
    expect(session.worktree_path).toBe("C:/wt");
  });

  it("fetchSessionsForProject keeps live status and defaults new sessions to Idle", async () => {
    useSessionStore.setState({
      sessions: [stored(1, { status: "Done", statusMessage: "all green" })],
    });
    invokeMock.mockResolvedValue([row(1), row(2)]);

    await useSessionStore.getState().fetchSessionsForProject(PROJECT);

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.map((s) => [s.id, s.status])).toEqual([
      [1, "Done"],
      [2, "Idle"],
    ]);
    expect(sessions[0].statusMessage).toBe("all green");
  });
});
