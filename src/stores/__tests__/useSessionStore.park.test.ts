import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";

import { useSessionStore, type SessionConfig } from "../useSessionStore";

const invokeMock = vi.mocked(invoke);

function session(id: number, projectPath = "C:/proj"): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Idle",
    worktree_path: null,
    project_path: projectPath,
  };
}

describe("useSessionStore parking", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], parkedSessionIds: [] });
    invokeMock.mockReset();
  });

  it("parkSession adds the id once (idempotent)", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(1);

    expect(useSessionStore.getState().parkedSessionIds).toEqual([1]);
  });

  it("unparkSession removes the id", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(2);

    useSessionStore.getState().unparkSession(1);

    expect(useSessionStore.getState().parkedSessionIds).toEqual([2]);
  });

  it("removeSession prunes the parked id", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(2);

    useSessionStore.getState().removeSession(1);

    expect(useSessionStore.getState().parkedSessionIds).toEqual([2]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([2]);
  });

  it("fetchSessions prunes parked ids absent from the fetched list", async () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(2);

    // Backend now only knows about session 2.
    invokeMock.mockResolvedValueOnce([session(2)]);
    await useSessionStore.getState().fetchSessions();

    expect(useSessionStore.getState().parkedSessionIds).toEqual([2]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([2]);
  });

  it("fetchSessionsForProject prunes parked ids absent from the fetched list", async () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().parkSession(1);

    invokeMock.mockResolvedValueOnce([session(2)]);
    await useSessionStore.getState().fetchSessionsForProject("C:/proj");

    expect(useSessionStore.getState().parkedSessionIds).toEqual([]);
  });
});
