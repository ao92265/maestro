import type { PullRequestInfo } from "@/stores/useGitHubStore";

/**
 * The prompt a PR monitor action types into the terminal it opens.
 *
 * Pure and dependency-free on purpose (only a `type` import, which erases):
 * everything the launcher decides — which repo to pin, whether the run may
 * write — is a string decision, so it can be unit-tested without React, a
 * store, or a Tauri backend.
 *
 * The launch path collapses every whitespace run to a single space before
 * typing it into the PTY (a newline would submit a partial message), so the
 * text below is written to survive being flattened onto one line: every rule
 * and step carries its own visible marker rather than relying on layout.
 */

/** The PR fields the prompt names. A detail payload satisfies this too. */
export type PrPromptSubject = Pick<
  PullRequestInfo,
  "number" | "title" | "author" | "headRefName" | "baseRefName" | "url"
>;

export interface PrActionPromptInput {
  pr: PrPromptSubject;
  /** The project checkout the terminal opens in. */
  repoPath: string;
  /** `compilePrWorkflow(...)` output — the ticked steps, already numbered. */
  compiledSteps: string;
  /** `prWorkflowNeedsWorktree(...)` — true when a ticked step writes. */
  needsWorktree: boolean;
}

/**
 * `owner/repo` out of a github.com pull request URL
 * (`https://github.com/owner/repo/pull/123`), or null when the URL is not
 * shaped like one. The host is not pinned to github.com so a GitHub
 * Enterprise URL still yields its slug.
 */
export function githubRepoSlug(url: string): string | null {
  const match = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/.exec(url.trim());
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/** Longest step list spelled out in a session name before it is counted instead. */
const MAX_NAME_STEPS_CHARS = 30;

/**
 * The terminal header name for a launch — short, and identifying the PR:
 * `PR #123 check`, `PR #123 check+review`. A long or user-grown step list
 * collapses to `PR #123 5 steps` so the header stays readable.
 */
export function prActionLaunchName(prNumber: number, stepIds: string[]): string {
  if (stepIds.length === 0) return `PR #${prNumber}`;
  const joined = stepIds.join("+");
  const suffix = joined.length <= MAX_NAME_STEPS_CHARS ? joined : `${stepIds.length} steps`;
  return `PR #${prNumber} ${suffix}`;
}

/** Longest sanitised step chain kept in a brief stem before it is counted instead. */
const MAX_BRIEF_STEM_STEPS_CHARS = 40;

/**
 * The file stem of the brief this launch is staged as (issue #138):
 * `pr-123-check-review`. The backend writes it to
 * `<project>/.maestro/briefs/<stem>.md` and types a pointer at it instead of
 * the multi-KB prompt itself.
 *
 * Step ids are free text from the workflow editor, so everything outside
 * `a-z0-9` collapses to a single dash — a `+`, a space or a `../` can never
 * reach the filesystem — and a long chain becomes a count so the file name
 * stays short (Windows path limits).
 */
export function prActionBriefStem(prNumber: number, stepIds: string[]): string {
  const slug = stepIds
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return `pr-${prNumber}`;
  const suffix = slug.length <= MAX_BRIEF_STEM_STEPS_CHARS ? slug : `${stepIds.length}-steps`;
  return `pr-${prNumber}-${suffix}`;
}

/** How the agent is told to get a repo slug when the URL did not yield one. */
function repoPinRule(slug: string | null, repoPath: string): string {
  if (slug) {
    return `RULE 1 (repo pin): pass --repo ${slug} on EVERY gh command you run, without exception — never rely on the directory you happen to be in to pick the repository.`;
  }
  return `RULE 1 (repo pin): the PR URL did not identify the repository. Run \`gh repo view --json nameWithOwner\` inside ${repoPath} first, then pass --repo <owner/repo> with that value on EVERY gh command you run, without exception — never rely on the directory you happen to be in to pick the repository.`;
}

/** Where the agent is allowed to work, given whether a ticked step writes. */
function workspaceRule(input: PrActionPromptInput): string {
  const { pr, repoPath, needsWorktree } = input;
  if (needsWorktree) {
    return `RULE 4 (workspace): this run makes changes. Create a NEW temporary git worktree from ${repoPath} checked out on the PR head branch ${pr.headRefName} (\`git worktree add\`), do every edit, commit and push inside that worktree, and remove it when you are finished. NEVER switch branches in the main checkout at ${repoPath} — someone else is working there.`;
  }
  return `RULE 4 (workspace): this run is READ-ONLY. Do all of it through gh from ${repoPath}. Do not modify the checkout in any way: no edits, no commits, no pushes, no branch switches, no new worktrees.`;
}

/**
 * Builds the full instruction the launched terminal receives: which PR, how
 * to address its repository, the two standing safety rules the user asked
 * for (read everything already said; never merge a stacked PR), where the
 * work may happen, and the compiled workflow steps verbatim.
 */
export function buildPrActionPrompt(input: PrActionPromptInput): string {
  const { pr, repoPath, compiledSteps } = input;
  const slug = githubRepoSlug(pr.url);
  const pin = slug ?? "<owner/repo>";
  // Step text is written against a placeholder so one workflow serves every
  // PR; the launcher is the only place that knows which PR this run is for.
  const steps = compiledSteps.replace(/<PR>/g, `${pr.number}`);

  const lines = [
    `You are monitoring one GitHub pull request. Work only on this PR — do not touch any other PR, branch or repository.`,
    ``,
    `PR: #${pr.number} "${pr.title}"`,
    `Opened by: @${pr.author.login}`,
    `Branches: ${pr.headRefName} -> ${pr.baseRefName}`,
    `URL: ${pr.url}`,
    `Repository: ${slug ?? "(derive it — see RULE 1)"}`,
    `Local checkout: ${repoPath}`,
    ``,
    repoPinRule(slug, repoPath),
    `RULE 2 (read everything first): before you review, fix or merge anything, read EVERY existing comment and EVERY review thread on this PR — \`gh pr view ${pr.number} --repo ${pin} --json comments,reviews,reviewDecision\` plus \`gh api repos/${pin}/pulls/${pr.number}/comments\` for inline threads — so nothing already raised is missed, contradicted or repeated.`,
    `RULE 3 (stacked PRs): this PR targets ${pr.baseRefName}. Check the repository default branch with \`gh repo view --repo ${pin} --json defaultBranchRef\`. If ${pr.baseRefName} is NOT that default branch the PR is STACKED: review it only against its true base ${pr.baseRefName} (never against the accumulated stack), and NEVER merge it — stop and report why instead.`,
    workspaceRule(input),
    ``,
    `PROCESS — carry out these steps in order, reporting the outcome of each before starting the next, and stopping early if a step's outcome makes the following steps pointless:`,
    steps,
  ];

  return lines.join("\n");
}
