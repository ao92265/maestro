import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrepareSessionWorktree, mockRequest, mockSetSessionsLaunched } = vi.hoisted(() => ({
  mockPrepareSessionWorktree: vi.fn(),
  mockRequest: vi.fn(),
  mockSetSessionsLaunched: vi.fn(),
}));

vi.mock("@/lib/worktreeManager", () => ({
  prepareSessionWorktree: mockPrepareSessionWorktree,
}));

vi.mock("@/stores/usePendingLaunchStore", () => ({
  usePendingLaunchStore: { getState: () => ({ request: mockRequest }) },
}));

vi.mock("@/stores/useWorkspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ setSessionsLaunched: mockSetSessionsLaunched }) },
}));

import { issueBranchName, launchCardInWorktree } from "../cardWorktreeLaunch";

type PrepResult = Awaited<ReturnType<typeof launchCardInWorktree>>;

function prepResult(overrides: Partial<PrepResult> = {}): PrepResult {
  return {
    working_directory: "/repo",
    worktree_path: null,
    branch: null,
    created: false,
    warning: null,
    ...overrides,
  };
}

describe("launchCardInWorktree", () => {
  beforeEach(() => {
    mockPrepareSessionWorktree.mockReset();
    mockRequest.mockReset();
    mockSetSessionsLaunched.mockReset();
  });

  it("queues a launch whose workingDirOverride and briefDir both equal the preparation result's working_directory", async () => {
    const result = prepResult({
      working_directory: "/worktrees/pr-123",
      worktree_path: "/worktrees/pr-123",
      branch: "pr-123-branch",
      created: true,
    });
    mockPrepareSessionWorktree.mockResolvedValue(result);

    const returned = await launchCardInWorktree({
      tabId: "tab-1",
      repoPath: "/repo",
      branch: "pr-123-branch",
      customName: "pr-123-worktree",
      initialPrompt: "review this",
      briefStem: "pr-123",
      worktreeBasePath: "/custom/base",
    });

    expect(mockPrepareSessionWorktree).toHaveBeenCalledWith(
      "/repo",
      "pr-123-branch",
      "/custom/base",
    );
    expect(mockRequest).toHaveBeenCalledWith({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: "/worktrees/pr-123",
      branch: "pr-123-branch",
      customName: "pr-123-worktree",
      initialPrompt: "review this",
      briefDir: "/worktrees/pr-123",
      briefStem: "pr-123",
    });
    expect(mockSetSessionsLaunched).toHaveBeenCalledWith("tab-1", true);
    expect(returned).toBe(result);
  });

  it("does not queue a launch or mark sessions launched when preparation falls back to the repo path", async () => {
    const result = prepResult({
      working_directory: "/repo",
      worktree_path: null,
      branch: null,
      warning: "Failed to prepare worktree: some error",
    });
    mockPrepareSessionWorktree.mockResolvedValue(result);

    const returned = await launchCardInWorktree({
      tabId: "tab-2",
      repoPath: "/repo",
      branch: "issue-45-fix",
      customName: "issue-45-worktree",
      initialPrompt: "fix the bug",
      briefStem: "issue-45",
      worktreeBasePath: null,
    });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockSetSessionsLaunched).not.toHaveBeenCalled();
    expect(returned).toBe(result);
  });
});

describe("issueBranchName", () => {
  it('slugifies a title into "issue-123-fix-the-login-loop"', () => {
    expect(issueBranchName(123, "Fix: the login  LOOP!!")).toBe("issue-123-fix-the-login-loop");
  });

  it("caps the whole name at 40 chars and never ends in a dash", () => {
    const name = issueBranchName(
      9999,
      "This is a very long issue title that would otherwise blow way past the cap",
    );
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith("-")).toBe(false);
    expect(name.startsWith("issue-9999-")).toBe(true);
  });
});
