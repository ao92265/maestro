import { describe, expect, it } from "vitest";
import { buildIssueActionPrompt, type IssueActionPromptInput } from "../issueActionPrompt";

const REPO_PATH = "C:\\git\\maestro";

function input(overrides: Partial<IssueActionPromptInput> = {}): IssueActionPromptInput {
  return {
    issue: {
      number: 42,
      title: "Fix the login loop",
    },
    repoPath: REPO_PATH,
    branch: "issue-42-fix-the-login-loop",
    ...overrides,
  };
}

describe("buildIssueActionPrompt", () => {
  it("names the issue identity: number and title", () => {
    const prompt = buildIssueActionPrompt(input());
    expect(prompt).toContain("#42 Fix the login loop");
  });

  it("instructs reading the issue fully first via gh issue view", () => {
    const prompt = buildIssueActionPrompt(input());
    expect(prompt).toContain("gh issue view 42 --comments");
  });

  it("states the worktree rule: work only in this worktree on the given branch, never touch the main checkout", () => {
    const prompt = buildIssueActionPrompt(input({ branch: "issue-42-fix-the-login-loop" }));
    expect(prompt).toContain("issue-42-fix-the-login-loop");
    expect(prompt).toContain("Work only in this worktree");
    expect(prompt).toContain("never touch the main checkout");
  });

  it("states the delivery contract: test-first, conventional commits referencing the issue, push, draft PR", () => {
    const prompt = buildIssueActionPrompt(input());
    expect(prompt).toContain("write tests first");
    expect(prompt).toContain("commits that reference #42");
    expect(prompt).toContain("push the branch");
    expect(prompt).toContain("gh pr create --draft");
  });

  it("is collapse-safe: a single line with no newlines", () => {
    const prompt = buildIssueActionPrompt(input());
    expect(prompt).not.toContain("\n");
  });
});
