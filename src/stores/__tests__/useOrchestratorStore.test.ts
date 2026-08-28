import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Proposal } from "@/lib/orchestrator";
import { useOrchestratorStore } from "../useOrchestratorStore";

const invokeMock = vi.mocked(invoke);

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    targetSessionId: 7,
    text: "run the tests",
    key: null,
    note: "its suite is red",
    status: "pending",
    at: new Date().toISOString(),
    error: null,
    ...over,
  };
}

/**
 * Routes each backend command to a canned reply. Anything unstubbed rejects,
 * so a test can never accidentally pass on a silently-succeeding invoke.
 */
function stubBackend(replies: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd in replies) {
      const reply = replies[cmd];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    }
    return Promise.reject(new Error(`unstubbed command: ${cmd}`));
  });
}

const writes = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "write_stdin");

beforeEach(() => {
  invokeMock.mockReset();
  useOrchestratorStore.setState({
    proposals: [],
    safeMode: true,
    scope: [],
    sessionId: null,
    error: null,
  });
});

describe("safe mode", () => {
  it("is on by default — the queue holds everything until it is turned off", () => {
    expect(useOrchestratorStore.getState().safeMode).toBe(true);
  });

  it("takes the backend's answer as the truth, not the operator's click", async () => {
    // The persisted flag lives in Rust; a failed write must not leave the
    // toggle showing "free run" while the queue is still gating.
    stubBackend({ orchestrator_set_safe_mode: false });
    await useOrchestratorStore.getState().setSafeMode(false);
    expect(invokeMock).toHaveBeenCalledWith("orchestrator_set_safe_mode", { on: false });
    expect(useOrchestratorStore.getState().safeMode).toBe(false);
  });

  it("leaves safe mode ON when the backend refuses the change", async () => {
    stubBackend({ orchestrator_set_safe_mode: new Error("disk full") });
    await useOrchestratorStore.getState().setSafeMode(false);
    expect(useOrchestratorStore.getState().safeMode).toBe(true);
  });
});

describe("refresh", () => {
  it("ingests dropped proposals and adopts the backend queue", async () => {
    stubBackend({
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [proposal()] },
    });
    await useOrchestratorStore.getState().refresh();
    expect(useOrchestratorStore.getState().proposals).toHaveLength(1);
    expect(useOrchestratorStore.getState().error).toBeNull();
  });

  it("keeps the last good queue on a failed poll and records the error", async () => {
    useOrchestratorStore.setState({ proposals: [proposal()] });
    stubBackend({ orchestrator_ingest: new Error("unreadable") });
    await useOrchestratorStore.getState().refresh();
    expect(useOrchestratorStore.getState().proposals).toHaveLength(1);
    expect(useOrchestratorStore.getState().error).toContain("unreadable");
  });

  it("never dispatches anything on a refresh, even in free-run mode", async () => {
    // Auto-approval happens in Rust at ingest; delivery is still an explicit
    // approve() call. A poll that could send is a poll that can double-send.
    stubBackend({
      orchestrator_ingest: {
        safeMode: false,
        scope: [],
        proposals: [proposal({ status: "approved" })],
      },
    });
    await useOrchestratorStore.getState().refresh();
    expect(writes()).toHaveLength(0);
  });
});

describe("decide", () => {
  it("types an approved message into the target session and submits it", async () => {
    stubBackend({
      orchestrator_decide: { proposal: proposal({ status: "approved" }), dispatch: true },
      write_stdin: null,
      orchestrator_mark: null,
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, true);
    expect(invokeMock).toHaveBeenCalledWith("orchestrator_decide", { id: 1, approve: true });
    const payloads = writes().map(([, args]) => (args as { data: string }).data);
    expect(payloads.join("")).toContain("run the tests");
    expect(payloads.join("")).toContain("\r");
    expect(writes()[0]?.[1]).toMatchObject({ sessionId: 7 });
  });

  it("sends nothing when the operator rejects", async () => {
    stubBackend({
      orchestrator_decide: { proposal: proposal({ status: "rejected" }), dispatch: false },
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, false);
    expect(writes()).toHaveLength(0);
  });

  it("sends nothing when the backend refuses the approval", async () => {
    // Expired, already-decided, or out-of-scope all come back dispatch:false.
    // The frontend must trust that flag rather than re-deriving it.
    stubBackend({
      orchestrator_decide: { proposal: proposal({ status: "expired" }), dispatch: false },
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, true);
    expect(writes()).toHaveLength(0);
  });

  it("reports a failed delivery back to the queue instead of marking it sent", async () => {
    stubBackend({
      orchestrator_decide: { proposal: proposal({ status: "approved" }), dispatch: true },
      write_stdin: new Error("session is gone"),
      orchestrator_mark: null,
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, true);
    const mark = invokeMock.mock.calls.find(([cmd]) => cmd === "orchestrator_mark");
    expect(mark?.[1]).toMatchObject({ id: 1, status: "error" });
    expect((mark?.[1] as { error: string }).error).toContain("session is gone");
  });

  it("marks a delivered proposal sent", async () => {
    stubBackend({
      orchestrator_decide: { proposal: proposal({ status: "approved" }), dispatch: true },
      write_stdin: null,
      orchestrator_mark: null,
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, true);
    expect(invokeMock).toHaveBeenCalledWith("orchestrator_mark", {
      id: 1,
      status: "sent",
      error: null,
    });
  });

  it("delivers a control key as its escape sequence, never as its name", async () => {
    stubBackend({
      orchestrator_decide: {
        proposal: proposal({ status: "approved", text: "", key: "Escape" }),
        dispatch: true,
      },
      write_stdin: null,
      orchestrator_mark: null,
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, true);
    const payloads = writes().map(([, args]) => (args as { data: string }).data);
    expect(payloads).toContain("\x1b");
    expect(payloads.join("")).not.toContain("Escape");
  });
});

describe("self-targeting", () => {
  it("refuses to deliver a proposal aimed at the orchestrator's own session", async () => {
    // A self-nudge is a loop: the orchestrator wakes itself, proposes again,
    // and the operator's queue fills with its own echo.
    useOrchestratorStore.setState({ sessionId: 7 });
    stubBackend({
      orchestrator_decide: { proposal: proposal({ status: "approved" }), dispatch: true },
      orchestrator_mark: null,
      orchestrator_ingest: { safeMode: true, scope: [], proposals: [] },
    });
    await useOrchestratorStore.getState().decide(1, true);
    expect(writes()).toHaveLength(0);
    const mark = invokeMock.mock.calls.find(([cmd]) => cmd === "orchestrator_mark");
    expect(mark?.[1]).toMatchObject({ id: 1, status: "error" });
  });
});

describe("launch", () => {
  it("carries the first goal in with the brief so one click starts the run", async () => {
    stubBackend({ orchestrator_drop_dir: "/tmp/drop" });
    const { usePendingLaunchStore } = await import("../usePendingLaunchStore");
    usePendingLaunchStore.setState({ pending: [] });
    await useOrchestratorStore.getState().launch("tab-1", "/repo", "get PR 12 merged");
    const queued = usePendingLaunchStore.getState().pending[0];
    expect(queued?.tabId).toBe("tab-1");
    expect(queued?.initialPrompt).toContain("/tmp/drop");
    expect(queued?.initialPrompt).toContain("get PR 12 merged");
    // Staged as a brief FILE, not typed: the inline path collapses whitespace
    // and would flatten the JSON examples in the brief.
    expect(queued?.briefDir).toBe("/repo");
    expect(queued?.briefStem).toBeTruthy();
  });

  it("starts without a goal when the operator only wants the session up", async () => {
    stubBackend({ orchestrator_drop_dir: "/tmp/drop" });
    const { usePendingLaunchStore } = await import("../usePendingLaunchStore");
    usePendingLaunchStore.setState({ pending: [] });
    await useOrchestratorStore.getState().launch("tab-1", "/repo");
    expect(usePendingLaunchStore.getState().pending).toHaveLength(1);
  });
});

describe("scope", () => {
  it("persists the operator's tick list so ingest can enforce it", async () => {
    stubBackend({
      orchestrator_set_scope: null,
      orchestrator_ingest: { safeMode: true, scope: [{ sessionId: 7, label: "a" }], proposals: [] },
    });
    await useOrchestratorStore.getState().setScope([{ sessionId: 7, label: "a" }]);
    expect(invokeMock).toHaveBeenCalledWith("orchestrator_set_scope", {
      scope: [{ sessionId: 7, label: "a" }],
    });
    expect(useOrchestratorStore.getState().scope).toHaveLength(1);
  });
});
