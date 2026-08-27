import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useWorkspaceStore hydrates through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out (same idiom as PrActionsMenu.test.tsx).
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

const { mockLaunchCardInWorktree } = vi.hoisted(() => ({
  mockLaunchCardInWorktree: vi.fn(),
}));

// Keep issueBranchName real (the panel derives the branch from it) and only
// stub the async launch itself.
vi.mock("../../../../lib/cardWorktreeLaunch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/cardWorktreeLaunch")>();
  return {
    ...actual,
    launchCardInWorktree: mockLaunchCardInWorktree,
  };
});

import type { IssueDetail } from "../../../../stores/useGitHubStore";
import { useGitHubStore } from "../../../../stores/useGitHubStore";
import { useWorkspaceStore, type WorkspaceTab } from "../../../../stores/useWorkspaceStore";
import { IssueDetailPanel } from "../IssueDetailPanel";

const REPO_PATH = "C:\\git\\maestro";

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: REPO_PATH,
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function buildIssue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: 42,
    title: "Fix the login loop",
    state: "OPEN",
    author: { login: "octocat" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    url: "https://github.com/o/r/issues/42",
    labels: [],
    closedAt: null,
    body: "Issue body",
    comments: [],
    ...overrides,
  };
}

describe("IssueDetailPanel Start in worktree", () => {
  beforeEach(() => {
    useGitHubStore.getState().reset();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    mockLaunchCardInWorktree.mockReset();
  });

  it("is enabled for an open issue", () => {
    useGitHubStore.setState({ selectedIssue: buildIssue() });
    render(<IssueDetailPanel repoPath={REPO_PATH} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Start in worktree/ })).toBeEnabled();
  });

  it("is disabled for a closed issue", () => {
    useGitHubStore.setState({
      selectedIssue: buildIssue({ state: "CLOSED", closedAt: "2026-01-03T00:00:00Z" }),
    });
    render(<IssueDetailPanel repoPath={REPO_PATH} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Start in worktree/ })).toBeDisabled();
  });

  it("launches the issue into its own worktree, named and branched from the issue", async () => {
    mockLaunchCardInWorktree.mockResolvedValue({
      working_directory: "/worktrees/issue-42",
      worktree_path: "/worktrees/issue-42",
      branch: "issue-42-fix-the-login-loop",
      created: true,
      warning: null,
    });
    useGitHubStore.setState({ selectedIssue: buildIssue() });
    render(<IssueDetailPanel repoPath={REPO_PATH} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Start in worktree/ }));

    await waitFor(() => expect(mockLaunchCardInWorktree).toHaveBeenCalledTimes(1));
    const args = mockLaunchCardInWorktree.mock.calls[0][0];
    expect(args.tabId).toBe("tab-1");
    expect(args.repoPath).toBe(REPO_PATH);
    expect(args.branch).toBe("issue-42-fix-the-login-loop");
    expect(args.customName).toBe("issue-42-worktree");
    expect(args.briefStem).toBe("issue-42-worktree");
    expect(args.initialPrompt).toContain("#42 Fix the login loop");
  });

  it("alerts instead of launching when no project tab is active", async () => {
    useWorkspaceStore.setState({ tabs: [buildTab({ active: false })] });
    useGitHubStore.setState({ selectedIssue: buildIssue() });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<IssueDetailPanel repoPath={REPO_PATH} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Start in worktree/ }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockLaunchCardInWorktree).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("surfaces a launch warning", async () => {
    mockLaunchCardInWorktree.mockResolvedValue({
      working_directory: "/worktrees/issue-42",
      worktree_path: "/worktrees/issue-42",
      branch: "issue-42-fix-the-login-loop",
      created: false,
      warning: "Worktree already existed; reused it.",
    });
    useGitHubStore.setState({ selectedIssue: buildIssue() });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<IssueDetailPanel repoPath={REPO_PATH} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Start in worktree/ }));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Worktree already existed; reused it."),
    );
    alertSpy.mockRestore();
  });
});
