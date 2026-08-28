import { describe, expect, it } from "vitest";

import type { SessionConfig } from "@/stores/useSessionStore";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";
import { buildSessionItems, buildWorktreeItems, filterItems } from "../quickOpen";
import type { WorktreeInfo } from "../worktreeManager";

function session(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 1,
    mode: "Claude",
    name: null,
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

function worktree(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: "/repo/alpha",
    head: "abc1234",
    branch: "main",
    is_bare: false,
    is_main_worktree: true,
    ...over,
  };
}

describe("buildSessionItems", () => {
  it("labels a named session and points it at its project tab", () => {
    const items = buildSessionItems([session({ id: 7, name: "refactor auth" })], [tab()]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "session",
      label: "refactor auth",
      tabId: "tab-alpha",
      sessionId: 7,
    });
  });

  it("falls back to the AI mode when the session is unnamed", () => {
    const items = buildSessionItems([session({ mode: "Codex", name: null })], [tab()]);

    expect(items[0].label).toBe("Codex");
  });

  it("skips sessions whose project has no open tab", () => {
    const items = buildSessionItems([session({ project_path: "/repo/ghost" })], [tab()]);

    expect(items).toEqual([]);
  });

  it("matches the project tab despite Windows extended-length path prefixes", () => {
    // Rust canonicalize returns \\?\C:\repo\alpha; the tab stores C:\repo\alpha.
    const items = buildSessionItems(
      [session({ project_path: "\\\\?\\C:\\repo\\alpha" })],
      [tab({ projectPath: "C:\\repo\\alpha" })],
    );

    expect(items).toHaveLength(1);
    expect(items[0].tabId).toBe("tab-alpha");
  });

  it("mentions the branch in the sublabel when the session has one", () => {
    const items = buildSessionItems([session({ branch: "feat/login" })], [tab()]);

    expect(items[0].sublabel).toContain("feat/login");
  });
});

describe("buildWorktreeItems", () => {
  it("links a worktree to the session running in it", () => {
    const items = buildWorktreeItems(
      [worktree({ path: "/repo/alpha-wt", branch: "feat/x", is_main_worktree: false })],
      [session({ id: 42, worktree_path: "/repo/alpha-wt" })],
      tab(),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "worktree", label: "feat/x", sessionId: 42 });
  });

  it("keeps a worktree with no live session, with a null sessionId", () => {
    const items = buildWorktreeItems(
      [worktree({ path: "/repo/alpha-wt", branch: "feat/x", is_main_worktree: false })],
      [session({ id: 42, worktree_path: "/other" })],
      tab(),
    );

    expect(items[0].sessionId).toBeNull();
    expect(items[0].tabId).toBe("tab-alpha");
  });

  it("falls back to the directory name when the worktree is detached", () => {
    const items = buildWorktreeItems(
      [worktree({ path: "/repo/alpha-wt", branch: null, is_main_worktree: false })],
      [],
      tab(),
    );

    expect(items[0].label).toBe("alpha-wt");
  });

  it("scopes the row id to the tab, so one repo open twice does not collide", () => {
    const wt = [worktree({ path: "/repo/alpha" })];
    const first = buildWorktreeItems(wt, [], tab({ id: "tab-1" }));
    const second = buildWorktreeItems(wt, [], tab({ id: "tab-2" }));

    expect(first[0].id).not.toBe(second[0].id);
  });

  it("drops bare worktrees, which have no checkout to open", () => {
    const items = buildWorktreeItems([worktree({ is_bare: true })], [], tab());

    expect(items).toEqual([]);
  });
});

describe("filterItems", () => {
  const items = buildSessionItems(
    [
      session({ id: 1, name: "alpha bravo" }),
      session({ id: 2, name: "charlie" }),
      session({ id: 3, name: "alabaster" }),
    ],
    [tab()],
  );

  it("returns every item for an empty query", () => {
    expect(filterItems(items, "")).toHaveLength(3);
  });

  it("ignores surrounding whitespace", () => {
    expect(filterItems(items, "  charlie  ")).toHaveLength(1);
  });

  it("matches non-contiguous subsequences", () => {
    const labels = filterItems(items, "ab").map((i) => i.label);

    expect(labels).toContain("alpha bravo");
    expect(labels).toContain("alabaster");
    expect(labels).not.toContain("charlie");
  });

  it("is case-insensitive", () => {
    expect(filterItems(items, "CHAR").map((i) => i.label)).toEqual(["charlie"]);
  });

  it("returns nothing when no item matches", () => {
    expect(filterItems(items, "zzzz")).toEqual([]);
  });

  it("ranks a contiguous prefix above a scattered subsequence", () => {
    // "alab" is a literal prefix of "alabaster" but only scattered in "alpha bravo".
    expect(filterItems(items, "alab")[0].label).toBe("alabaster");
  });

  it("matches against the sublabel as well as the label", () => {
    const withBranch = buildSessionItems(
      [session({ id: 9, name: "nameless", branch: "feat/payments" })],
      [tab()],
    );

    expect(filterItems(withBranch, "payments")).toHaveLength(1);
  });
});
