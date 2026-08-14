import { useEffect, useRef, useState } from "react";

import { type BranchPullRequest, getBranchPullRequest } from "@/lib/github";

/**
 * How often a terminal re-checks whether its branch has a PR yet. The lib-level
 * cache absorbs most of these; this interval only bounds how long after opening
 * a PR the header takes to notice it.
 */
const POLL_INTERVAL_MS = 60_000;

/** Placeholder the header shows while the branch name is still being read. */
const UNKNOWN_BRANCH = "...";

/**
 * The pull request for a terminal's branch, or null when it has none (or the
 * repo isn't on GitHub, or `gh` isn't available — all indistinguishable, and
 * all mean "no link to show").
 *
 * Follows {@link useSessionBranch}: fetch on mount, poll while the terminal is
 * in the active tab and the window has focus, so background projects don't keep
 * spawning `gh` processes.
 */
export function useBranchPullRequest(
  repoPath: string,
  branch: string | null,
  isActive: boolean = true,
): BranchPullRequest | null {
  const [pr, setPr] = useState<BranchPullRequest | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // A branch is needed to ask the question at all; the placeholder means the
    // branch read is still in flight and this effect re-runs when it lands.
    if (!repoPath || !branch || branch === UNKNOWN_BRANCH || branch === "HEAD") {
      setPr(null);
      return () => {
        mountedRef.current = false;
      };
    }

    const fetchPr = (force = false) => {
      if (!isActive || (!force && !document.hasFocus())) return;
      getBranchPullRequest(repoPath, branch).then((found) => {
        if (mountedRef.current) setPr(found);
      });
    };

    fetchPr(true);
    const id = setInterval(() => fetchPr(false), POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
      mountedRef.current = false;
    };
  }, [repoPath, branch, isActive]);

  return pr;
}
