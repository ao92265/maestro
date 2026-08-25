import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionConfig } from "@/stores/useSessionStore";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";
import { useQuickOpenItems } from "../useQuickOpenItems";

const { listWorktrees } = vi.hoisted(() => ({ listWorktrees: vi.fn() }));

vi.mock("@/lib/worktreeManager", () => ({ listWorktrees }));

function session(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 1,
    mode: "Claude",
    name: "alpha session",
    branch: null,
    worktree_path: null,
    project_path: "/repo/alpha",
    status: "Idle",
    ...over,
  };
}

function tab(over: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-alpha",
    name: "alpha",
    projectPath: "/repo/alpha",
    active: true,
    sessionIds: [],
    sessionsLaunched: true,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...over,
  };
}

beforeEach(() => {
  listWorktrees.mockReset();
  listWorktrees.mockResolvedValue([]);
});

describe("useQuickOpenItems", () => {
  it("returns session rows without touching git while the palette is closed", () => {
    const { result } = renderHook(() => useQuickOpenItems(false, [session()], [tab()]));

    expect(result.current.map((i) => i.kind)).toEqual(["session"]);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it("appends worktree rows once the palette opens", async () => {
    listWorktrees.mockResolvedValue([
      {
        path: "/repo/alpha-wt",
        head: "abc",
        branch: "feat/x",
        is_bare: false,
        is_main_worktree: false,
      },
    ]);

    const { result } = renderHook(() => useQuickOpenItems(true, [session()], [tab()]));

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((i) => i.kind)).toEqual(["session", "worktree"]);
    expect(listWorktrees).toHaveBeenCalledWith("/repo/alpha");
  });

  it("skips projects that are not git repos", async () => {
    const { result } = renderHook(() =>
      useQuickOpenItems(true, [session()], [tab({ workspaceType: "non-git" })]),
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it("keeps session rows when the worktree lookup fails", async () => {
    listWorktrees.mockRejectedValue(new Error("not a git repository"));

    const { result } = renderHook(() => useQuickOpenItems(true, [session()], [tab()]));

    await waitFor(() => expect(listWorktrees).toHaveBeenCalled());
    expect(result.current.map((i) => i.kind)).toEqual(["session"]);
  });

  it("does not refetch when the caller rebuilds an equal tabs array", async () => {
    // Regression guard: keying the fetch on array identity looped forever —
    // each fetch set state, which re-rendered, which produced a new array.
    const { rerender } = renderHook(({ t }) => useQuickOpenItems(true, [], t), {
      initialProps: { t: [tab()] },
    });

    await waitFor(() => expect(listWorktrees).toHaveBeenCalledTimes(1));

    rerender({ t: [tab()] }); // same content, fresh identity
    await act(async () => {
      await Promise.resolve();
    });

    expect(listWorktrees).toHaveBeenCalledTimes(1);
  });

  it("prefers the selected repo in a multi-repo workspace", async () => {
    const { result } = renderHook(() =>
      useQuickOpenItems(
        true,
        [],
        [tab({ workspaceType: "multi-repo", selectedRepoPath: "/repo/alpha/packages/api" })],
      ),
    );

    await waitFor(() => expect(listWorktrees).toHaveBeenCalledWith("/repo/alpha/packages/api"));
    expect(result.current).toEqual([]);
  });
});
