import { CircleDot, GitPullRequest } from "lucide-react";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";

interface GitHubWatchdogBadgeProps {
  /** Navigate to the git panel: PRs tab (review-requested) or Issues tab
   *  (assignee) with the watchdog search filter applied. */
  onNavigate: (kind: "prs" | "issues") => void;
}

/**
 * Compact top-bar badge with the watchdog totals across all projects,
 * e.g. "2 PRs · 3 issues". Hidden when both totals are zero. Each segment
 * is clickable and routes to the matching git-panel tab + filter.
 */
export function GitHubWatchdogBadge({ onNavigate }: GitHubWatchdogBadgeProps) {
  const projects = useGitHubWatchdogStore((s) => s.projects);

  const prCount = projects.reduce((sum, p) => sum + p.reviewRequests.length, 0);
  const issueCount = projects.reduce((sum, p) => sum + p.assignedIssues.length, 0);

  if (prCount === 0 && issueCount === 0) return null;

  const projectNames = (pick: "reviewRequests" | "assignedIssues") =>
    projects
      .filter((p) => p[pick].length > 0)
      .map((p) => `${p.name} (${p[pick].length})`)
      .join(", ");

  return (
    <div className="mr-1 flex items-center gap-1 rounded-full border border-maestro-border bg-maestro-card px-1.5 py-0.5">
      {prCount > 0 && (
        <button
          type="button"
          onClick={() => onNavigate("prs")}
          className="flex items-center gap-1 rounded-full px-1 text-[10px] font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/10"
          title={`Review requested: ${projectNames("reviewRequests")}`}
        >
          <GitPullRequest size={11} />
          <span>
            {prCount} PR{prCount === 1 ? "" : "s"}
          </span>
        </button>
      )}
      {prCount > 0 && issueCount > 0 && <span className="text-[10px] text-maestro-muted">·</span>}
      {issueCount > 0 && (
        <button
          type="button"
          onClick={() => onNavigate("issues")}
          className="flex items-center gap-1 rounded-full px-1 text-[10px] font-medium text-maestro-green transition-colors hover:bg-maestro-green/10"
          title={`Assigned issues: ${projectNames("assignedIssues")}`}
        >
          <CircleDot size={11} />
          <span>
            {issueCount} issue{issueCount === 1 ? "" : "s"}
          </span>
        </button>
      )}
    </div>
  );
}
