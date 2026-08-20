import { type ActRun, isTerminal } from "@/lib/act";
import type { BandTab, HandoffInfo, RepoPrs } from "@/lib/bands";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/**
 * Pure assembly of the Board view's columns — the kanban read of the same
 * live state the Home bands read (`bands.ts`). Board answers a different
 * question than bands: not "what needs you first" but "what stage is each
 * piece of work in, honestly." Everything here is a pure function of
 * already-fetched state so the view stays a dumb renderer and the column
 * routing rules are unit-testable (`__tests__/board.test.ts`).
 *
 * Column contract: see the plan's "Column model (the kanban contract)"
 * table. A fallback must always show the truth — an unmapped ACT stage
 * lands in Building carrying its own raw stage text, never a fabricated
 * label.
 */

export type BoardColumnKey = "suggested" | "planning" | "building" | "checking" | "review" | "done";

/** Display order, left to right — the spec's column list. */
export const BOARD_COLUMN_ORDER: BoardColumnKey[] = [
  "suggested",
  "planning",
  "building",
  "checking",
  "review",
  "done",
];

export type BoardCardItem =
  | {
      kind: "session";
      session: SessionConfig;
      /** Tab owning the session's project, when one is open. */
      tabId: string | null;
      projectName: string;
      objective: string;
      /** Raw status truth shown on the card (badge formatting is the view's job). */
      stageLabel: string;
      needsYou: boolean;
      /** ISO timestamp the view computes elapsed time from, or null if unknown. */
      since: string | null;
    }
  | {
      kind: "handoff";
      handoff: HandoffInfo;
      projectName: string;
      objective: string;
      stageLabel: string;
      needsYou: boolean;
      since: string | null;
    }
  | {
      kind: "run";
      run: ActRun;
      projectName: string;
      objective: string;
      stageLabel: string;
      needsYou: boolean;
      since: string | null;
    }
  | {
      kind: "pr";
      pr: PullRequestInfo;
      repoPath: string;
      projectName: string;
      objective: string;
      stageLabel: string;
      needsYou: boolean;
      since: string | null;
    };

export interface BoardColumns {
  suggested: BoardCardItem[];
  planning: BoardCardItem[];
  building: BoardCardItem[];
  checking: BoardCardItem[];
  review: BoardCardItem[];
  done: BoardCardItem[];
  /** Fleet strip: live count per session status, zero-filled (mirrors Bands.counts). */
  counts: Record<BackendSessionStatus, number>;
  /** Handoffs on disk hidden by the display cap ("+N more on disk"). */
  moreHandoffs: number;
}

/** The slice of a watchdog project poll the board needs (issues are out of scope). */
export interface BoardReviewRequests {
  repoPath: string;
  projectName: string;
  /** Open PRs where the user's review is requested (watchdog's reviewRequests list). */
  reviewRequests: PullRequestInfo[];
}

interface AssembleBoardInput {
  sessions: SessionConfig[];
  tabs: BandTab[];
  handoffs: HandoffInfo[];
  repoPrs: RepoPrs[];
  /** Every ACT run the factory currently knows about (not just gated ones). */
  runs: ActRun[];
  /** ACT runs stopped at a confidence gate — waiting on the user. */
  gatedRuns?: ActRun[];
  /** Watchdog "review requested" PRs, per repo. */
  reviewRequests?: BoardReviewRequests[];
  /** "Since you looked": merged PRs / completed runs at or before this instant are old news. */
  watermarkMs: number;
  /**
   * External claude process cwds (WP2's process-scan detection). WP1 merges
   * this by exact path match only; the ancestor/prefix matching promised by
   * the plan (a session running in a subdirectory of a handoff's path) is
   * WP2's job, once `staleProcess.ts`'s matcher is wired in.
   */
  activeDirs?: Set<string>;
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

/**
 * Display cap on handoffs shown in Suggested, mirroring bands.ts's
 * MAX_HANDOFF_ROWS (not exported there, so duplicated here — same value,
 * same rationale: surface the newest few, not archive them).
 */
const MAX_HANDOFF_ROWS = 10;

/** Session status -> board column. Idle produces no card (fleet-strip only). */
export function inferSessionColumn(status: BackendSessionStatus): BoardColumnKey | null {
  switch (status) {
    case "Starting":
      return "planning";
    case "Working":
    case "NeedsInput":
    case "Error":
    case "Timeout":
      return "building";
    case "Done":
      return "done";
    case "Idle":
      return null;
  }
}

/**
 * ACT stage-name keyword table, as data (spec risk #2's "start coarse"
 * instruction made concrete). First matching bucket wins; order is
 * significant for stage names that could match more than one row — accepted
 * spec risk, not fixed here. Keywords are lowercase substrings matched
 * against the lowercased stage name.
 */
export const ACT_STAGE_KEYWORDS: ReadonlyArray<{ column: BoardColumnKey; keywords: string[] }> = [
  { column: "planning", keywords: ["plan", "spec", "architect"] },
  { column: "building", keywords: ["build", "implement", "execut"] },
  { column: "checking", keywords: ["test", "qa", "check", "verif"] },
  { column: "review", keywords: ["review", "pr", "merge"] },
];

/**
 * Maps a raw ACT stage name to a board column. A null or unrecognized stage
 * falls back to Building — the fallback must show the truth (the raw stage
 * text stays on the card via `stageLabel`), never fake a stage.
 */
export function inferActColumn(stage: string | null): BoardColumnKey {
  if (!stage) return "building";
  const lower = stage.toLowerCase();
  for (const { column, keywords } of ACT_STAGE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return column;
  }
  return "building";
}

/**
 * "Needs you" flag predicate, one rule per card kind (spec's needs-you
 * column notes). Handoffs never need you — they are suggestions, not
 * blockers, until a session picks one up.
 */
export function needsYou(
  item:
    | { kind: "session"; status: BackendSessionStatus }
    | { kind: "run"; gated: boolean }
    | { kind: "pr"; changesRequested: boolean }
    | { kind: "handoff" },
): boolean {
  switch (item.kind) {
    case "session":
      return item.status === "NeedsInput" || item.status === "Error" || item.status === "Timeout";
    case "run":
      return item.gated;
    case "pr":
      return item.changesRequested;
    case "handoff":
      return false;
  }
}

function sessionDir(s: SessionConfig): string {
  return s.working_directory ?? s.worktree_path ?? s.project_path;
}

function prObjective(pr: PullRequestInfo): string {
  return `#${pr.number} ${pr.title}`;
}

export function assembleBoard({
  sessions,
  tabs,
  handoffs,
  repoPrs,
  runs,
  gatedRuns = [],
  reviewRequests = [],
  watermarkMs,
  activeDirs,
}: AssembleBoardInput): BoardColumns {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    BackendSessionStatus,
    number
  >;
  for (const s of sessions) {
    if (counts[s.status] !== undefined) counts[s.status] += 1;
  }

  const columns: BoardColumns = {
    suggested: [],
    planning: [],
    building: [],
    checking: [],
    review: [],
    done: [],
    counts,
    moreHandoffs: 0,
  };

  /* Sessions -> Planning/Building/Done. Idle already counted above; it gets
     no card (an idle terminal is not "work in a stage"). */
  const tabByPath = new Map(tabs.map((t) => [t.projectPath, t]));
  for (const session of sessions) {
    const column = inferSessionColumn(session.status);
    if (!column) continue;
    const tab = tabByPath.get(session.project_path) ?? null;
    const projectName = tab?.name ?? session.project_path.split("/").pop() ?? session.project_path;
    columns[column].push({
      kind: "session",
      session,
      tabId: tab?.id ?? null,
      projectName,
      objective: session.needsInputPrompt ?? session.statusMessage ?? session.name ?? projectName,
      stageLabel: session.status,
      needsYou: needsYou({ kind: "session", status: session.status }),
      since: session.lastMcpUpdateTime ? new Date(session.lastMcpUpdateTime).toISOString() : null,
    });
  }

  /* Suggested -> handoffs on disk. Dedupe/cap mirrors bands.ts exactly; a
     handoff covered by a live session (or, per activeDirs, an externally
     running claude) is not "on disk waiting" — the running work IS it. */
  const liveDirs = new Set(sessions.map(sessionDir));
  if (activeDirs) {
    for (const dir of activeDirs) liveDirs.add(dir);
  }
  const sortedHandoffs = handoffs
    .filter((h) => !h.stale && !h.orphan && !liveDirs.has(h.path))
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  const seenPaths = new Set<string>();
  const dedupedHandoffs = sortedHandoffs.filter((h) => {
    if (seenPaths.has(h.path)) return false;
    seenPaths.add(h.path);
    return true;
  });
  columns.moreHandoffs = Math.max(0, dedupedHandoffs.length - MAX_HANDOFF_ROWS);
  for (const h of dedupedHandoffs.slice(0, MAX_HANDOFF_ROWS)) {
    const lastAsk = h.asks[h.asks.length - 1];
    columns.suggested.push({
      kind: "handoff",
      handoff: h,
      projectName: h.repo,
      objective: h.waiting && lastAsk ? lastAsk : h.lastAction,
      stageLabel: "On disk",
      needsYou: false,
      since: h.lastActive,
    });
  }

  /* ACT runs -> stage-keyword column, or Done once terminal-success crosses
     the watermark. Terminal non-success runs (failed/cancelled) and
     terminal-success runs older than the watermark get no card — the same
     "old news" treatment merged PRs get below. */
  const gatedIds = new Set(gatedRuns.map((r) => r.id));
  for (const run of runs) {
    if (isTerminal(run.status)) {
      if (run.status !== "completed") continue;
      const updatedMs = run.updatedAt ? Date.parse(run.updatedAt) : 0;
      if (updatedMs <= watermarkMs) continue;
      columns.done.push({
        kind: "run",
        run,
        projectName: run.repoUrl ?? "Factory run",
        objective: run.title,
        stageLabel: run.stage ?? run.status,
        needsYou: false,
        since: run.updatedAt,
      });
      continue;
    }
    const gated = gatedIds.has(run.id);
    const column = inferActColumn(run.stage);
    columns[column].push({
      kind: "run",
      run,
      projectName: run.repoUrl ?? "Factory run",
      objective: run.title,
      stageLabel: run.stage ?? run.status,
      needsYou: needsYou({ kind: "run", gated }),
      since: run.updatedAt ?? run.createdAt,
    });
  }

  /* Review -> PRs with changes requested (needs-you) or a review requested
     of the user (watchdog, no flag — a request is not yet a block). */
  for (const repo of repoPrs) {
    for (const pr of repo.changesRequested) {
      columns.review.push({
        kind: "pr",
        pr,
        repoPath: repo.repoPath,
        projectName: repo.projectName,
        objective: prObjective(pr),
        stageLabel: "Changes requested",
        needsYou: needsYou({ kind: "pr", changesRequested: true }),
        since: pr.updatedAt,
      });
    }
    /* Done -> merged PRs since the watermark ("mark seen" bounds this). */
    for (const pr of repo.merged) {
      const mergedMs = pr.mergedAt ? Date.parse(pr.mergedAt) : 0;
      if (mergedMs <= watermarkMs) continue;
      columns.done.push({
        kind: "pr",
        pr,
        repoPath: repo.repoPath,
        projectName: repo.projectName,
        objective: prObjective(pr),
        stageLabel: "Merged",
        needsYou: false,
        since: pr.mergedAt,
      });
    }
  }
  for (const w of reviewRequests) {
    for (const pr of w.reviewRequests) {
      columns.review.push({
        kind: "pr",
        pr,
        repoPath: w.repoPath,
        projectName: w.projectName,
        objective: prObjective(pr),
        stageLabel: "Review requested",
        needsYou: needsYou({ kind: "pr", changesRequested: false }),
        since: pr.updatedAt,
      });
    }
  }

  return columns;
}
