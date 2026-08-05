import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  useSessionStore,
  type BackendSessionStatus,
  type SessionConfig,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

function session(
  id: number,
  status: BackendSessionStatus = "Idle",
  projectPath = "C:/proj"
): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: projectPath,
  };
}

/** Captured `session-status-changed` handler, so tests can emit events. */
let emitStatus: (
  sessionId: number,
  status: BackendSessionStatus | "AwaitingInput",
  projectPath?: string
) => void;

beforeAll(async () => {
  listenMock.mockImplementation(((_event: string, handler: (e: unknown) => void) => {
    emitStatus = (sessionId, status, projectPath = "C:/proj") => {
      handler({
        payload: { session_id: sessionId, project_path: projectPath, status },
      });
    };
    return Promise.resolve(() => {});
  }) as typeof listen);
  await useSessionStore.getState().initListeners();
});

describe("useSessionStore auto-unpark attention", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      attentionSessionIds: [],
    });
  });

  it("auto-unparks a parked session on the transition into NeedsInput and marks attention", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "NeedsInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  it("auto-unparks on the normalized Stop-hook AwaitingInput signal too", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "AwaitingInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  it("does not mark attention for a NeedsInput transition on an unparked session", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    emitStatus(1, "NeedsInput");

    const state = useSessionStore.getState();
    expect(state.attentionSessionIds).toEqual([]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  it("edge-triggered: a manual re-park is not undone by repeated NeedsInput events", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "NeedsInput"); // auto-unparked

    useSessionStore.getState().parkSession(1); // user re-parks it
    emitStatus(1, "NeedsInput"); // same state, not a new transition

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("a NEW transition into NeedsInput after a manual re-park auto-unparks again", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "NeedsInput"); // auto-unparked
    useSessionStore.getState().parkSession(1); // user re-parks it

    emitStatus(1, "Working"); // agent resumes...
    expect(useSessionStore.getState().parkedSessionIds).toEqual([1]);

    emitStatus(1, "NeedsInput"); // ...and stops again: a new edge

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("parkSession clears a stale attention highlight", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "NeedsInput");
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1]);

    useSessionStore.getState().parkSession(1);

    expect(useSessionStore.getState().attentionSessionIds).toEqual([]);
  });

  it("clearSessionAttention removes only the given id and ignores unknown ids", () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    useSessionStore.getState().clearSessionAttention(3); // no-op
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1, 2]);

    useSessionStore.getState().clearSessionAttention(1);
    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
  });

  it("removeSession prunes the attention id", () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    useSessionStore.getState().removeSession(1);

    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
  });

  it("does not auto-unpark a parked Done/Error session on the Stop-hook AwaitingInput signal", () => {
    // The listener never downgrades an explicit terminal state — the guarded
    // early-return must also mean: no unpark, no attention.
    useSessionStore.setState({
      sessions: [session(1, "Done"), session(2, "Error")],
    });
    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(2);

    emitStatus(1, "AwaitingInput");
    emitStatus(2, "AwaitingInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1, 2]);
    expect(state.attentionSessionIds).toEqual([]);
    expect(state.sessions.map((s) => s.status)).toEqual(["Done", "Error"]);
  });

  it("fetchSessions prunes attention ids absent from the fetched list", async () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    // Backend now only knows about session 2.
    invokeMock.mockResolvedValueOnce([session(2, "NeedsInput")]);
    await useSessionStore.getState().fetchSessions();

    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
  });

  it("fetchSessionsForProject prunes attention ids absent from the fetched list", async () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1],
    });

    invokeMock.mockResolvedValueOnce([session(2, "NeedsInput")]);
    await useSessionStore.getState().fetchSessionsForProject("C:/proj");

    expect(useSessionStore.getState().attentionSessionIds).toEqual([]);
  });

  it("removeSessionsForProject prunes attention ids of removed sessions", async () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    invokeMock.mockResolvedValueOnce([session(1, "NeedsInput")]);
    await useSessionStore.getState().removeSessionsForProject("C:/proj");

    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([2]);
  });
});
