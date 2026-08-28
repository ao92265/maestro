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
  /** The tab's custom worktree base directory (null = use the default). */
  worktreeBasePath: string | null;
}

/**
 * Prepares a worktree for a card launch, queues the terminal launch, and
 * marks the tab's sessions as launched so the grid mounts to consume it —
 * the same three-step sequence PrActionsMenu's handleLaunch follows, shared
 * here so both PR and issue cards launch identically.
 *
 * If preparation could not produce a worktree (`worktree_path === null`),
 * the launch is NOT queued: a session in the main checkout under a prompt
 * that claims it is isolated in a worktree is exactly the failure this
 * feature exists to prevent. The result is still returned so the caller can
 * surface `result.warning` as a hard failure.
 */
export async function launchCardInWorktree(
  args: CardWorktreeLaunchArgs,
): Promise<WorktreePreparationResult> {
  const { tabId, repoPath, branch, customName, initialPrompt, briefStem, worktreeBasePath } = args;
  const result = await prepareSessionWorktree(repoPath, branch, worktreeBasePath);
  if (result.worktree_path === null) {
    return result;
  }
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
