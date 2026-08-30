import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSED_BATCH_RETENTION_MS, MAX_CLOSED_BATCHES } from "@/lib/sessionActions";
import type { BackendSessionRow } from "@/stores/useSessionStore";
import { useClosedSessionsStore } from "../useClosedSessionsStore";

const NOW = 1_700_000_000_000;

function row(id: number, overrides: Partial<BackendSessionRow> = {}): BackendSessionRow {
  return {
    id,
    mode: "Claude",
    name: null,
    branch: null,
    worktree_path: null,
    project_path: "/repo",
    ...overrides,
  };
}

describe("useClosedSessionsStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useClosedSessionsStore.setState({ batches: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a closed batch with the fields a relaunch needs", () => {
    useClosedSessionsStore.getState().record({
      projectPath: "/repo",
      projectName: "repo",
      sessions: [
        row(1, {
          name: "api",
          branch: "feat/x",
          worktree_path: "/wt/x",
          working_directory: "/wt/x",
        }),
      ],
    });

    const [batch] = useClosedSessionsStore.getState().batches;
    expect(batch.closedAtMs).toBe(NOW);
    expect(batch.projectName).toBe("repo");
    expect(batch.sessions).toEqual([
      {
        id: 1,
        name: "api",
        mode: "Claude",
        projectPath: "/repo",
        workingDirectory: "/wt/x",
        branch: "feat/x",
      },
    ]);
  });

  /* `working_directory` is optional on the backend row; the worktree path and
     then the project root are the same fallbacks `bands.ts` uses. */
  it("falls back to the worktree path, then the project path, for the working directory", () => {
    useClosedSessionsStore.getState().record({
      projectPath: "/repo",
      projectName: "repo",
      sessions: [row(1, { worktree_path: "/wt/x" }), row(2)],
    });

    const [batch] = useClosedSessionsStore.getState().batches;
    expect(batch.sessions.map((s) => s.workingDirectory)).toEqual(["/wt/x", "/repo"]);
  });

  it("ignores a close that removed no sessions", () => {
    useClosedSessionsStore
      .getState()
      .record({ projectPath: "/repo", projectName: "repo", sessions: [] });

    expect(useClosedSessionsStore.getState().batches).toEqual([]);
  });

  it("gives each batch a distinct id even when two close in the same millisecond", () => {
    const record = () =>
      useClosedSessionsStore
        .getState()
        .record({ projectPath: "/repo", projectName: "repo", sessions: [row(1)] });
    record();
    record();

    const ids = useClosedSessionsStore.getState().batches.map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps the newest batch first and caps the shelf", () => {
    for (let i = 0; i < MAX_CLOSED_BATCHES + 2; i++) {
      useClosedSessionsStore
        .getState()
        .record({ projectPath: `/repo${i}`, projectName: `repo${i}`, sessions: [row(1)] });
    }

    const batches = useClosedSessionsStore.getState().batches;
    expect(batches).toHaveLength(MAX_CLOSED_BATCHES);
    expect(batches[0].projectName).toBe(`repo${MAX_CLOSED_BATCHES + 1}`);
  });

  it("forget drops one batch (the shelf entry is dismissed, not restored)", () => {
    useClosedSessionsStore
      .getState()
      .record({ projectPath: "/repo", projectName: "repo", sessions: [row(1)] });
    const [batch] = useClosedSessionsStore.getState().batches;

    useClosedSessionsStore.getState().forget(batch.id);

    expect(useClosedSessionsStore.getState().batches).toEqual([]);
  });

  it("prune drops batches past the retention window", () => {
    useClosedSessionsStore
      .getState()
      .record({ projectPath: "/repo", projectName: "repo", sessions: [row(1)] });

    vi.setSystemTime(NOW + CLOSED_BATCH_RETENTION_MS + 1);
    useClosedSessionsStore.getState().prune();

    expect(useClosedSessionsStore.getState().batches).toEqual([]);
  });

  it("prune keeps a batch still inside the window", () => {
    useClosedSessionsStore
      .getState()
      .record({ projectPath: "/repo", projectName: "repo", sessions: [row(1)] });

    vi.setSystemTime(NOW + CLOSED_BATCH_RETENTION_MS - 1);
    useClosedSessionsStore.getState().prune();

    expect(useClosedSessionsStore.getState().batches).toHaveLength(1);
  });
});
