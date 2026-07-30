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

describe("useSessionStore warning flag", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], flaggedSessionIds: [] });
    invokeMock.mockReset();
  });

  it("toggleSessionFlag adds the id, then removes it on the second toggle", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    useSessionStore.getState().toggleSessionFlag(1);
    expect(useSessionStore.getState().flaggedSessionIds).toEqual([1]);

    useSessionStore.getState().toggleSessionFlag(1);
    expect(useSessionStore.getState().flaggedSessionIds).toEqual([]);
  });

  it("tracks multiple flagged sessions independently", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });

    useSessionStore.getState().toggleSessionFlag(1);
    useSessionStore.getState().toggleSessionFlag(2);
    useSessionStore.getState().toggleSessionFlag(1);

    expect(useSessionStore.getState().flaggedSessionIds).toEqual([2]);
  });

  it("removeSession prunes the flagged id", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().toggleSessionFlag(1);
    useSessionStore.getState().toggleSessionFlag(2);

    useSessionStore.getState().removeSession(1);

    expect(useSessionStore.getState().flaggedSessionIds).toEqual([2]);
  });

  it("fetchSessions prunes flagged ids absent from the fetched list", async () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().toggleSessionFlag(1);
    useSessionStore.getState().toggleSessionFlag(2);

    // Backend now only knows about session 2.
    invokeMock.mockResolvedValueOnce([session(2)]);
    await useSessionStore.getState().fetchSessions();

    expect(useSessionStore.getState().flaggedSessionIds).toEqual([2]);
  });

  it("fetchSessionsForProject prunes flagged ids absent from the fetched list", async () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useSessionStore.getState().toggleSessionFlag(1);

    invokeMock.mockResolvedValueOnce([session(2)]);
    await useSessionStore.getState().fetchSessionsForProject("C:/proj");

    expect(useSessionStore.getState().flaggedSessionIds).toEqual([]);
  });
});
