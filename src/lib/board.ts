import { type ActRun, isTerminal } from "@/lib/act";
import {
  type BandTab,
  type HandoffInfo,
  isCoveredByActiveDir,
  MAX_HANDOFF_ROWS,
  type RepoPrs,
} from "@/lib/bands";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/**
 * Pure assembly of the Board view's columns: the kanban read of the same
 * live state the Home bands read (`bands.ts`). Board answers a different
 * question than bands: not "what needs you first" but "what stage is each
 * piece of work in, honestly." Everything here is a pure function of
 * already-fetched state so the view stays a dumb renderer and the column
 * routing rules are unit-testable (`__tests__/board.test.ts`).
 *
 * Column contract: see the plan's "Column model (the kanban contract)"
 * table. A fallback must always show the truth: an unmapped ACT stage
 * lands in Building carrying its own raw stage text, never a fabricated
 * label.
 */

export type BoardColumnKey = "suggested" | "planning" | "building" | "checking" | "review" | "done";

/** Display order, left to right: the spec's column list. */
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
    }
  | {
      kind: "external";
      /** Directory the live outside-Maestro claude process is working in. */
      dir: string;
      /**
       * The live cwds this card stands for (several processes in one
       * project collapse to one card). Scopes the peek's transcript list to
       * the outside work rather than the whole repo's history.
       */
      cwds: string[];
      /** Freshest handoff for that directory, when one exists on disk. */
      handoff: HandoffInfo | null;
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
  /** ACT runs stopped at a confidence gate: waiting on the user. */
  gatedRuns?: ActRun[];
  /** Watchdog "review requested" PRs, per repo. */
  reviewRequests?: BoardReviewRequests[];
  /** "Since you looked": merged PRs / completed runs at or before this instant are old news. */
  watermarkMs: number;
  /**
   * Cwds of claude processes seen running outside a live Maestro session
   * (WP2's process-scan liveness detection). Additive-only: a handoff whose
   * path equals, or is an ancestor of, one of these cwds is not shown in
   * Suggested, since the running work IS it.
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
 * significant for stage names that could match more than one row (accepted
 * spec risk, not fixed here). Keywords of three letters or more are lowercase
 * substrings matched against the lowercased stage name; two-letter keywords
 * ("pr", "qa") match whole tokens only, so "prepare" or "process" does not
 * land in Review just for containing the letters.
 */
export const ACT_STAGE_KEYWORDS: ReadonlyArray<{ column: BoardColumnKey; keywords: string[] }> = [
  { column: "planning", keywords: ["plan", "spec", "architect"] },
  { column: "building", keywords: ["build", "implement", "execut"] },
  { column: "checking", keywords: ["test", "qa", "check", "verif"] },
  { column: "review", keywords: ["review", "pr", "merge"] },
];

/**
 * Maps a raw ACT stage name to a board column. A null or unrecognized stage
 * falls back to Building: the fallback must show the truth (the raw stage
 * text stays on the card via `stageLabel`), never fake a stage.
 */
export function inferActColumn(stage: string | null): BoardColumnKey {
  if (!stage) return "building";
  const lower = stage.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const { column, keywords } of ACT_STAGE_KEYWORDS) {
    const hit = keywords.some((k) => (k.length <= 2 ? tokens.includes(k) : lower.includes(k)));
    if (hit) return column;
  }
  return "building";
}

/**
 * "Needs you" flag predicate, one rule per card kind (spec's needs-you
 * column notes). Handoffs never need you: they are suggestions, not
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
     handoff covered by a live session is dropped, and one covered by an
     externally running claude (activeDirs) is not "on disk waiting" either:
     the running work IS it, so it shows in Building below instead. */
  const liveDirs = new Set(sessions.map(sessionDir));
  const sortedHandoffs = handoffs
    .filter((h) => !h.stale && !h.orphan && !liveDirs.has(h.path))
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  const seenPaths = new Set<string>();
  const dedupedHandoffs = sortedHandoffs.filter((h) => {
    if (seenPaths.has(h.path)) return false;
    seenPaths.add(h.path);
    return true;
  });
  const waitingHandoffs = dedupedHandoffs.filter((h) => !isCoveredByActiveDir(h.path, activeDirs));
  const liveOutsideHandoffs = dedupedHandoffs.filter((h) =>
    isCoveredByActiveDir(h.path, activeDirs),
  );
  columns.moreHandoffs = Math.max(0, waitingHandoffs.length - MAX_HANDOFF_ROWS);
  for (const h of waitingHandoffs.slice(0, MAX_HANDOFF_ROWS)) {
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

  /* Building -> live claude work outside Maestro, one card per live piece
     of work: when handoff paths nest, the deepest covered one speaks for
     the cwd (a shallower covered handoff stays off Suggested too; it is
     still not waiting), and several cwds under one handoff collapse to
     that handoff's card (a session and its subagent are one piece of
     work; the Suggested header note still counts directories). A
     covered handoff card carries its own last words (the stop hook rewrites
     the handoff file every turn, so lastAction is near-live). A live cwd
     with no handoff still shows: directory name only, nothing invented.
     Maestro cannot see an outside session asking for input, so needsYou
     stays false; claiming otherwise would lie. */
  if (activeDirs) {
    const liveCards = new Map<string, BoardCardItem>();
    for (const cwd of [...activeDirs].sort()) {
      if (!cwd) continue;
      const single = new Set([cwd]);
      let deepest: HandoffInfo | null = null;
      for (const h of liveOutsideHandoffs) {
        if (!isCoveredByActiveDir(h.path, single)) continue;
        if (!deepest || h.path.length > deepest.path.length) deepest = h;
      }
      if (deepest) {
        const existing = liveCards.get(deepest.path);
        if (existing && existing.kind === "external") {
          existing.cwds.push(cwd);
          continue;
        }
        const lastAsk = deepest.asks[deepest.asks.length - 1];
        liveCards.set(deepest.path, {
          kind: "external",
          dir: deepest.path,
          cwds: [cwd],
          handoff: deepest,
          projectName: deepest.repo,
          objective: deepest.waiting && lastAsk ? lastAsk : deepest.lastAction,
          stageLabel: "Live outside Vanguard",
          needsYou: false,
          since: deepest.lastActive,
        });
      } else {
        liveCards.set(cwd, {
          kind: "external",
          dir: cwd,
          cwds: [cwd],
          handoff: null,
          /* filter(Boolean) so a root cwd names itself rather than "". */
          projectName: cwd.split("/").filter(Boolean).pop() ?? cwd,
          objective: "Working outside Vanguard",
          stageLabel: "Live outside Vanguard",
          needsYou: false,
          since: null,
        });
      }
    }
    columns.building.push(...liveCards.values());
  }

  /* ACT runs -> stage-keyword column, or Done once terminal-success crosses
     the watermark. Terminal non-success runs (failed/cancelled) and
     terminal-success runs older than the watermark get no card: the same
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
     of the user (watchdog, no flag: a request is not yet a block). The two
     polls can surface the same PR (changesRequested is not author-filtered),
     so changes-requested wins and the watchdog copy is skipped by key. */
  const reviewCardKeys = new Set<string>();
  for (const repo of repoPrs) {
    for (const pr of repo.changesRequested) {
      reviewCardKeys.add(`${repo.repoPath}#${pr.number}`);
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
      if (reviewCardKeys.has(`${w.repoPath}#${pr.number}`)) continue;
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

/**
 * Every card waiting on Alex, across all six columns, oldest first.
 *
 * Sorted by how long it has been waiting rather than by column, because the
 * column a blocked card sits in is an accident of what kind of work it is.
 * A card with no timestamp sorts last: an unknown wait cannot outrank a
 * measured one.
 */
export function blockedOldestFirst(columns: BoardColumns): BoardCardItem[] {
  const all = [
    ...columns.suggested,
    ...columns.planning,
    ...columns.building,
    ...columns.checking,
    ...columns.review,
    ...columns.done,
  ].filter((card) => card.needsYou);

  return all.sort((a, b) => {
    if (!a.since && !b.since) return 0;
    if (!a.since) return 1;
    if (!b.since) return -1;
    return Date.parse(a.since) - Date.parse(b.since);
  });
}

/**
 * Is the board looking at a machine with nothing running on it?
 *
 * True only when every lane except Suggested is empty. Suggested holds
 * handoff files, which are not work in flight, so a board carrying nothing
 * but handoffs has nothing running by definition. Anything at all in the
 * other five lanes makes this false: a cold-start panel that hid a live
 * session would be exactly the silent under-reporting the pivot bans.
 */
export function isColdStart(columns: BoardColumns): boolean {
  return (
    columns.planning.length === 0 &&
    columns.building.length === 0 &&
    columns.checking.length === 0 &&
    columns.review.length === 0 &&
    columns.done.length === 0
  );
}
