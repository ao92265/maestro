import type { IssueInfo } from "@/stores/useGitHubStore";

/** The issue fields the prompt names. An issue detail payload satisfies this too. */
export type IssuePromptSubject = Pick<IssueInfo, "number" | "title">;

export interface IssueActionPromptInput {
  issue: IssuePromptSubject;
  /** The project checkout the issue's repo lives in — never touched directly. */
  repoPath: string;
  /** The worktree branch this issue is being worked on, from `issueBranchName`. */
  branch: string;
}

/**
 * Builds the prompt a "Start in worktree" launch types into its terminal:
 * the issue identity, an instruction to read it fully before acting, the
 * worktree rule, and the delivery contract.
 *
 * A single space-joined string, not `\n`-joined lines — this prompt is
 * brief-staged (written to a file and typed as a one-line pointer), so unlike
 * {@link buildPrActionPrompt} it never needs to survive being flattened by
 * the PTY and can skip the newline layout entirely.
 */
export function buildIssueActionPrompt(input: IssueActionPromptInput): string {
  const { issue, repoPath, branch } = input;
  return [
    `You are working on GitHub issue #${issue.number} ${issue.title}.`,
    `Read it fully first, before doing anything else: run gh issue view ${issue.number} --comments.`,
    `You are in a dedicated git worktree on branch ${branch} for this issue, checked out from ${repoPath}. Work only in this worktree — never touch the main checkout.`,
    `Delivery: write tests first, commit with conventional commits that reference #${issue.number}, push the branch, and once everything is green open a draft pull request with gh pr create --draft.`,
  ].join(" ");
}
