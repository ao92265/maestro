import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/**
 * Pure assembly of the Home view's three bands — the decision queue.
 *
 * The bands answer, in order: what is blocked on the user, what landed since
 * they last looked, and what is running right now. Everything here is a pure
 * function of already-fetched state so the view stays a dumb renderer and the
 * routing rules are unit-testable (`__tests__/bands.test.ts`).
 */

/** Mirrors the Rust `HandoffInfo` (commands/handoffs.rs), camelCase over IPC. */
export interface HandoffInfo {
  slug: string;
  /** The working directory the handoff recorded — may be a worktree. */
  path: string;
  /** Display name: last path component of `path`. */
  repo: string;
  branch: string | null;
  uncommitted: number;
  lastCommit: { hash: string; msg: string } | null;
  /** Bullets under `## Recent asks`, oldest first. */
  asks: string[];
  lastAction: string;
  /** The last action ended with a question — the session stopped on an ask. */
  waiting: boolean;
  /** RFC 3339 mtime of the handoff file. */
  lastActive: string;
  stale: boolean;
  /** The recorded directory no longer exists. */
  orphan: boolean;
}

/** The slice of a workspace tab the bands need (full tabs would drag in zustand). */
export interface BandTab {
  id: string;
  name: string;
  projectPath: string;
  selectedRepoPath?: string | null;
}

/** One repo's PR poll result, already split by what the bands ask of it. */
export interface RepoPrs {
  repoPath: string;
  projectName: string;
  /** Open PRs currently carrying a CHANGES_REQUESTED review decision. */
  changesRequested: PullRequestInfo[];
  /** Recently merged PRs, any age — the watermark filters them here. */
  merged: PullRequestInfo[];
  /** This repo's last poll failed; its lists above are the previous data. */
  error?: string | null;
}

export type BandItem =
  | {
      kind: "session";
      session: SessionConfig;
      /** Tab owning the session's project, when one is open. */
      tabId: string | null;
      projectName: string;
    }
  | { kind: "handoff"; handoff: HandoffInfo }
  | { kind: "pr"; pr: PullRequestInfo; repoPath: string; projectName: string };

export interface Bands {
  blocked: BandItem[];
  landed: BandItem[];
  running: BandItem[];
  /** Fleet strip: live count per session status, zero-filled. */
  counts: Record<BackendSessionStatus, number>;
  /** Parked handoffs hidden by the display cap ("+N more"). */
  moreHandoffs: number;
}

interface AssembleInput {
  sessions: SessionConfig[];
  tabs: BandTab[];
  handoffs: HandoffInfo[];
  repoPrs: RepoPrs[];
  /** "Since you looked": merged PRs at or before this instant are old news. */
  watermarkMs: number;
}

const ALL_STATUSES: BackendSessionStatus[] = [
  "Starting",
  "Idle",
  "Working",
  "NeedsInput",
  "Done",
  "Error",
  "Timeout",
];

/** Blocked-band session statuses, in display order: questions first, then failures. */
const BLOCKED_ORDER: BackendSessionStatus[] = ["NeedsInput", "Error", "Timeout"];
const RUNNING_STATUSES: BackendSessionStatus[] = ["Working", "Starting"];

/**
 * Display cap on parked handoffs. The live directory holds hundreds of
 * snapshots (many per repository); the band exists to surface the newest few,
 * not to archive them (review fc0e6b9, HIGH #1).
 */
const MAX_HANDOFF_ROWS = 10;

function sessionDir(s: SessionConfig): string {
  return s.working_directory ?? s.worktree_path ?? s.project_path;
}

export function assembleBands({
  sessions,
  tabs,
  handoffs,
  repoPrs,
  watermarkMs,
}: AssembleInput): Bands {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    BackendSessionStatus,
    number
  >;
  for (const s of sessions) {
    if (counts[s.status] !== undefined) counts[s.status] += 1;
  }

  const tabByPath = new Map(tabs.map((t) => [t.projectPath, t]));
  const toSessionItem = (session: SessionConfig): BandItem => {
    const tab = tabByPath.get(session.project_path) ?? null;
    return {
      kind: "session",
      session,
      tabId: tab?.id ?? null,
      projectName: tab?.name ?? session.project_path.split("/").pop() ?? session.project_path,
    };
  };

  /* Band 1 — blocked on you. Sessions asking or failed, then PRs a reviewer
     bounced, then parked handoffs. A handoff is dropped when any live session
     already sits in its directory: the session row IS that work. */
  const blocked: BandItem[] = [];
  for (const status of BLOCKED_ORDER) {
    for (const s of sessions.filter((x) => x.status === status)) blocked.push(toSessionItem(s));
  }
  for (const repo of repoPrs) {
    for (const pr of repo.changesRequested) {
      blocked.push({ kind: "pr", pr, repoPath: repo.repoPath, projectName: repo.projectName });
    }
  }
  const liveDirs = new Set(sessions.map(sessionDir));
  const sortedHandoffs = handoffs
    .filter((h) => !h.stale && !h.orphan && !liveDirs.has(h.path))
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  // One row per directory (newest snapshot wins), capped — the rest is a count.
  const seenPaths = new Set<string>();
  const dedupedHandoffs = sortedHandoffs.filter((h) => {
    if (seenPaths.has(h.path)) return false;
    seenPaths.add(h.path);
    return true;
  });
  const moreHandoffs = Math.max(0, dedupedHandoffs.length - MAX_HANDOFF_ROWS);
  for (const h of dedupedHandoffs.slice(0, MAX_HANDOFF_ROWS)) {
    blocked.push({ kind: "handoff", handoff: h });
  }

  /* Band 2 — landed since you looked. Done sessions are always shown (they
     clear themselves on the next turn); merged PRs honour the watermark. */
  const landed: BandItem[] = sessions.filter((s) => s.status === "Done").map(toSessionItem);
  for (const repo of repoPrs) {
    for (const pr of repo.merged) {
      const mergedMs = pr.mergedAt ? Date.parse(pr.mergedAt) : 0;
      if (mergedMs > watermarkMs) {
        landed.push({ kind: "pr", pr, repoPath: repo.repoPath, projectName: repo.projectName });
      }
    }
  }

  /* Band 3 — running. */
  const running: BandItem[] = sessions
    .filter((s) => RUNNING_STATUSES.includes(s.status))
    .map(toSessionItem);

  return { blocked, landed, running, counts, moreHandoffs };
}
