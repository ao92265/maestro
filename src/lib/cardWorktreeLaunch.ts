import { prepareSessionWorktree, type WorktreePreparationResult } from "@/lib/worktreeManager";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** Everything needed to launch a card (PR or issue) into a session worktree. */
export interface CardWorktreeLaunchArgs {
  tabId: string;
  /** The repo the card belongs to. */
  repoPath: string;
  /** Existing (PR head) or new (issue) branch. */
  branch: string;
  /** Session header name, e.g. "pr-123-worktree". */
  customName: string;
  initialPrompt: string;
  /** File stem for the staged brief. */
  briefStem: string;
}

/**
 * Prepares a worktree for a card launch, queues the terminal launch, and
 * marks the tab's sessions as launched so the grid mounts to consume it —
 * the same three-step sequence PrActionsMenu's handleLaunch follows, shared
 * here so both PR and issue cards launch identically.
 */
export async function launchCardInWorktree(
  args: CardWorktreeLaunchArgs,
): Promise<WorktreePreparationResult> {
  const { tabId, repoPath, branch, customName, initialPrompt, briefStem } = args;
  const result = await prepareSessionWorktree(repoPath, branch);
  usePendingLaunchStore.getState().request({
    tabId,
    mode: "Claude",
    resumeSessionId: null,
    workingDirOverride: result.working_directory,
    branch: result.branch,
    customName,
    initialPrompt,
    briefDir: result.working_directory,
    briefStem,
  });
  useWorkspaceStore.getState().setSessionsLaunched(tabId, true);
  return result;
}

/**
 * Derives a branch name for a new issue worktree, e.g.
 * `issueBranchName(123, "Fix: the login  LOOP!!")` === `"issue-123-fix-the-login-loop"`.
 * The title is lowercased, non-alphanumeric runs collapse to a single "-",
 * and the whole name is capped at 40 chars — trimming trailing "-" left by
 * truncation — so it stays safe for filesystem worktree paths.
 */
export function issueBranchName(issueNumber: number, title: string): string {
  const prefix = `issue-${issueNumber}-`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const maxTotal = 40;
  const available = Math.max(0, maxTotal - prefix.length);
  const truncatedSlug = slug.slice(0, available).replace(/-+$/g, "");
  return `${prefix}${truncatedSlug}`.replace(/-+$/g, "");
}
