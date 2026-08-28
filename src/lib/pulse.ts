/**
 * Pulse: today's timeline, the flow score behind it, and the metrics both are
 * read off. A port of rohcna's `computeMetrics` / `computeFlowScore` /
 * `computeActivity` (server.js), kept pure so the numbers are unit-testable
 * and the view never has to explain a score it cannot show the basis for.
 *
 * Faithful to rohcna's windowing and weighting: 30/30/20/20 across Focus,
 * Shipping, Responsiveness and Momentum; a 14-day heatmap with a 7-day trend
 * inside it; days with no persisted score backfilled at 15 points a commit.
 *
 * Two things changed in the port, both deliberate:
 * - Colours are tiers, not hexes. Rohcna baked `#ff5230` into its payload;
 *   Maestro is themed via `maestro-*` tokens, so the score bands come out as
 *   {@link FlowTier} and the components pick the token.
 * - Backfill reads `commitsByDate`, collected in one `git log` per repo, where
 *   rohcna re-scanned every repo once per missing day (the slowest thing in
 *   its server, by its own comment). Same output, one pass.
 *
 * Inputs are collected by `usePulseStore`; nothing here touches Tauri, the
 * clock (beyond an injected `now`) or a store.
 */

import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { SessionConfig } from "@/stores/useSessionStore";

/** One commit made today, as `pulse_git_activity` reports it. */
export interface PulseCommit {
  hash: string;
  /** 24-hour local `HH:MM` — the commit's own timestamp, not a parse of it. */
  time: string;
  /** Branch the commit is decorated with; empty when it carries no ref. */
  branch: string;
}

/** Today's git position for one repo, plus its recent commit counts. */
export interface PulseRepoActivity {
  /** Directory name, the way rohcna keyed repos. */
  repo: string;
  path: string;
  commits: PulseCommit[];
  added: number;
  removed: number;
  /** Repo-relative paths touched today; deduped per repo, not globally. */
  files: string[];
  /** Lines of `git status --porcelain` — 0 means a clean tree. */
  dirty: number;
  /** `YYYY-MM-DD` → commits landed that day, over the backfill window. */
  commitsByDate: Record<string, number>;
}

/** A timeline-worthy line found in today's transcripts. */
export interface PulseTranscriptEvent {
  /** Epoch ms. */
  ts: number;
  kind: "stopHook" | "autopilot";
  text: string;
}

/** Counters from today's Claude transcripts (`pulse_transcript_stats`). */
export interface PulseTranscriptStats {
  edits: number;
  toolCalls: number;
  testRuns: number;
  testsPass: number;
  testsFail: number;
  /** Hour of day (0-23) → tool calls logged in it. */
  hourly: Record<number, number>;
  /** Repo directory names the transcripts worked in. */
  repos: string[];
  /** Times the working repo changed between consecutive transcript entries. */
  switches: number;
  events: PulseTranscriptEvent[];
}

/**
 * A live session, flattened to what the scoring needs.
 *
 * Rohcna derived these from handoff files and tmux panes; Maestro reads them
 * off `useSessionStore` (see `usePulseStore.sessionsForPulse`).
 */
export interface PulseSession {
  id: number;
  repo: string;
  /** Blocked on the user — Maestro's `NeedsInput`. */
  waiting: boolean;
  /** Not live any more. Kept so the port's `!s.stale` filters read literally. */
  stale: boolean;
  /** Epoch ms of the last status update. */
  lastActive: number;
  lastAction: string;
}

/** Pull requests you opened and merged today. */
export interface PulsePrCounts {
  opened: number;
  merged: number;
}

/** Everything the three computations read. */
export interface PulseInputs {
  repos: PulseRepoActivity[];
  transcript: PulseTranscriptStats;
  sessions: PulseSession[];
  prs: PulsePrCounts;
  now: Date;
}

export interface PulseSpark {
  /** 12-hour labels, e.g. `9a`, `1p`. */
  hours: string[];
  activity: number[];
  commits: number[];
}

export interface PulseMetrics {
  date: string;
  headline: { commits: number; prs: number; repos: number; waiting: number };
  shipped: { commits: number; prsOpened: number; prsMerged: number };
  touched: { files: number; added: number; removed: number };
  activity: {
    edits: number;
    testRuns: number;
    testsPass: number;
    testsFail: number;
    toolCalls: number;
  };
  focus: { active: number; repos: number; switches: number };
  attention: { waiting: number; dirtyTrees: number };
  spark: PulseSpark;
  /** Shown instead of the numbers when the day has not started. */
  empty: string;
}

/** Score band. Same four cuts rohcna used for both its word and its colour. */
export type FlowTier = "scattered" | "steady" | "flow" | "deep";

export interface FlowFactor {
  label: string;
  /** Share of the final score, 0-1. */
  weight: number;
  /** The factor's own 0-100 score, before weighting. */
  raw: number;
  /** `raw`, rounded — what the bar is drawn to. */
  pct: number;
  /** The numbers behind `raw`, in words. */
  detail: string;
  sign: "↑" | "·" | "↓";
  tier: FlowTier;
}

export interface FlowDay {
  date: string;
  score: number;
}

export interface FlowTrendBar {
  date: string;
  score: number;
  /** Height against the best day in the window, 0-100. */
  heightPct: number;
  tier: FlowTier;
}

export interface FlowHeatCell {
  date: string;
  score: number;
  /** null on a day with no score at all — an empty cell, not a bad one. */
  tier: FlowTier | null;
  /** Marks a standout day (70+). */
  ring: boolean;
  title: string;
}

export interface FlowScore {
  score: number;
  word: string;
  tier: FlowTier;
  delta: string;
  deltaDirection: "up" | "down" | "none";
  streak: number;
  trend: FlowTrendBar[];
  heat: FlowHeatCell[];
  factors: FlowFactor[];
  insight: string;
  wkActive: number;
  wkAvg: number;
  wkBest: number;
  explain: string;
}

export type ActivityKind = "commit" | "question" | "stopHook" | "autopilot";

export interface ActivityEvent {
  kind: ActivityKind;
  /** 12-hour local time, e.g. `9:15a`. */
  time: string;
  text: string;
}

/** Days of history kept, and the hard ceiling once backfill has added to it. */
const HISTORY_SOFT_CAP = 30;
const HISTORY_HARD_CAP = 40;

/** Timeline rows the view will show. */
const ACTIVITY_LIMIT = 40;

const FLOW_WORDS: { min: number; word: string; tier: FlowTier }[] = [
  { min: 0, word: "Scattered", tier: "scattered" },
  { min: 30, word: "Steady", tier: "steady" },
  { min: 60, word: "In flow", tier: "flow" },
  { min: 80, word: "Deep", tier: "deep" },
];

/** Last path segment, the way rohcna keyed a repo. */
function basename(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * Live Maestro sessions, flattened for the scoring.
 *
 * Rohcna derived its sessions from handoff files, so it could call one stale
 * when the file aged past a fortnight. A session in this store is a terminal
 * that exists right now, so none of them are stale — the field stays so the
 * ported `!s.stale` filters read the way rohcna's did.
 */
export function toPulseSessions(sessions: SessionConfig[], nowMs: number): PulseSession[] {
  return sessions.map((session) => ({
    id: session.id,
    repo: basename(session.working_directory ?? session.worktree_path ?? session.project_path),
    waiting: session.status === "NeedsInput",
    stale: false,
    /* A session that has never reported through MCP still happened; dating it
       now keeps it on today's timeline instead of at the epoch. */
    lastActive: session.lastMcpUpdateTime ?? nowMs,
    lastAction: session.needsInputPrompt ?? session.statusMessage ?? "",
  }));
}

/**
 * Pull requests opened and merged on `date` (local).
 *
 * Rohcna asked `gh search prs --author @me` once, across every repo at once.
 * The fork has no cross-repo search command, so `usePulseStore` lists each
 * open project's PRs with the same `author:@me` filter and counts them here.
 */
export function countPrsOn(prs: PullRequestInfo[], date: string): PulsePrCounts {
  let opened = 0;
  let merged = 0;
  for (const pr of prs) {
    if (fallsOn(pr.createdAt, date)) opened++;
    if (pr.mergedAt && fallsOn(pr.mergedAt, date)) merged++;
  }
  return { opened, merged };
}

/** Whether an ISO timestamp lands on `date` in the local calendar. */
function fallsOn(iso: string, date: string): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && pulseDateString(new Date(at)) === date;
}

/** Local calendar date as `YYYY-MM-DD` — never `toISOString`, which is UTC. */
export function pulseDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function flowTier(score: number): FlowTier {
  let tier = FLOW_WORDS[0];
  for (const entry of FLOW_WORDS) if (score >= entry.min) tier = entry;
  return tier.tier;
}

export function flowWord(score: number): string {
  let word = FLOW_WORDS[0];
  for (const entry of FLOW_WORDS) if (score >= entry.min) word = entry;
  return word.word;
}

/** A day with no transcript history is scored off its commits alone. */
export function scoreFromCommits(commits: number): number {
  return Math.min(100, commits * 15);
}

function plural(count: number, noun: string, suffix = "s"): string {
  return `${count} ${noun}${count === 1 ? "" : suffix}`;
}

/** 12-hour clock with a bare a/p suffix, the way the rohcna timeline read. */
function formatTime(date: Date): string {
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}${date.getHours() < 12 ? "a" : "p"}`;
}

/**
 * Hour-by-hour tool calls and commits, from the first logged hour to the last.
 *
 * A day with no transcript activity falls back to a 7-11 window rather than
 * collapsing to a single empty column.
 */
export function buildSpark(
  commitHoursByRepo: number[][],
  hourly: Record<number, number>,
): PulseSpark {
  const hours = Object.keys(hourly)
    .map(Number)
    .sort((a, b) => a - b);
  const lo = hours.length ? hours[0] : 7;
  const hi = hours.length ? hours[hours.length - 1] : 11;

  const commitCount: Record<number, number> = {};
  for (const hour of commitHoursByRepo.flat()) {
    commitCount[hour] = (commitCount[hour] ?? 0) + 1;
  }

  const labels: string[] = [];
  const activity: number[] = [];
  const commits: number[] = [];
  for (let h = lo; h <= hi && labels.length < 8; h++) {
    labels.push(`${h % 12 || 12}${h < 12 ? "a" : "p"}`);
    activity.push(hourly[h] ?? 0);
    commits.push(commitCount[h] ?? 0);
  }
  return { hours: labels, activity, commits };
}

/** Hour-of-day of each commit in a repo, for the sparkline. */
function commitHours(repo: PulseRepoActivity): number[] {
  return repo.commits.map((c) => Number(c.time.split(":")[0]));
}

export function computeMetrics(inputs: PulseInputs): PulseMetrics {
  const { repos, transcript, sessions, prs, now } = inputs;

  let commits = 0;
  let added = 0;
  let removed = 0;
  let dirtyTrees = 0;
  const touched = new Set<string>();
  const commitHoursByRepo: number[][] = [];

  for (const repo of repos) {
    commits += repo.commits.length;
    added += repo.added;
    removed += repo.removed;
    // Keyed by full path: two repos both touching `src/index.ts` is two files.
    for (const file of repo.files) touched.add(`${repo.path}/${file}`);
    if (repo.commits.length > 0) commitHoursByRepo.push(commitHours(repo));
    if (repo.dirty > 0) dirtyTrees++;
  }

  // A repo counts as touched if a transcript worked in it OR something landed
  // there — the two sources overlap, and neither alone is the whole day.
  const reposTouched = new Set(transcript.repos);
  for (const repo of repos) if (repo.commits.length > 0) reposTouched.add(repo.repo);

  const waiting = sessions.filter((s) => s.waiting).length;
  const active = sessions.filter((s) => !s.stale).length;

  return {
    date: now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
    headline: { commits, prs: prs.opened, repos: reposTouched.size, waiting },
    shipped: { commits, prsOpened: prs.opened, prsMerged: prs.merged },
    touched: { files: touched.size, added, removed },
    activity: {
      edits: transcript.edits,
      testRuns: transcript.testRuns,
      testsPass: transcript.testsPass,
      testsFail: transcript.testsFail,
      toolCalls: transcript.toolCalls,
    },
    focus: { active, repos: reposTouched.size, switches: transcript.switches },
    attention: { waiting, dirtyTrees },
    spark: buildSpark(commitHoursByRepo, transcript.hourly),
    empty: `Fresh day. ${plural(sessions.length, "session")} live, ${commits} commits so far — pick one and go.`,
  };
}

/** Commits landed on `date` across every repo, for a day with no history. */
function commitsOnDate(repos: PulseRepoActivity[], date: string): number {
  return repos.reduce((total, repo) => total + (repo.commitsByDate[date] ?? 0), 0);
}

/**
 * Today's flow score, its 14-day context, and the history that produced it.
 *
 * Pure: `history` goes in, a new array comes out. The caller persists it —
 * rohcna wrote a module global to disk on every call, which made the score
 * untestable and the disk write invisible.
 */
export function computeFlowScore(
  inputs: PulseInputs,
  history: FlowDay[],
): { flow: FlowScore; history: FlowDay[] } {
  const { transcript, sessions, now } = inputs;
  const metrics = computeMetrics(inputs);
  const today = pulseDateString(now);

  // Factor 1: Focus — fewer context switches, and fewer repos, score higher.
  const switches = transcript.switches;
  const repoCount = transcript.repos.length || metrics.focus.repos || 1;
  const focusScore = Math.max(0, 100 - switches * 8 - Math.max(0, repoCount - 2) * 5);

  // Factor 2: Shipping — what actually left the building.
  const commits = metrics.shipped.commits;
  const prs = metrics.shipped.prsOpened + metrics.shipped.prsMerged;
  const shippingScore = Math.min(100, commits * 12 + prs * 20);

  // Factor 3: Responsiveness — the share of live sessions stuck on you.
  const waiting = sessions.filter((s) => s.waiting && !s.stale).length;
  const total = sessions.filter((s) => !s.stale).length || 1;
  const responsiveScore = Math.max(0, 100 - (waiting / total) * 60);

  // Factor 4: Momentum — how hard the day is being worked.
  const edits = metrics.activity.edits;
  const toolCalls = metrics.activity.toolCalls;
  const momentumScore = Math.min(100, edits * 4 + toolCalls);

  const weighted: {
    label: string;
    weight: number;
    raw: number;
    detail: string;
    up: number;
    mid: number;
  }[] = [
    {
      label: "Focus",
      weight: 0.3,
      raw: focusScore,
      detail: `${plural(repoCount, "repo")}, ${plural(switches, "switch", "es")}`,
      up: 60,
      mid: 30,
    },
    {
      label: "Shipping",
      weight: 0.3,
      raw: shippingScore,
      detail: `${plural(commits, "commit")}, ${plural(prs, "PR")}`,
      up: 40,
      mid: 1,
    },
    {
      label: "Responsiveness",
      weight: 0.2,
      raw: responsiveScore,
      detail: `${waiting} waiting`,
      up: 70,
      mid: 40,
    },
    {
      label: "Momentum",
      weight: 0.2,
      raw: momentumScore,
      detail: `${edits} edits, ${toolCalls} tool calls`,
      up: 40,
      mid: 1,
    },
  ];

  const score = Math.round(weighted.reduce((acc, f) => acc + f.raw * f.weight, 0));

  /* Whether there is anything to compare today against, read BEFORE backfill
     adds thirteen zero-scored days below. Rohcna checked this after, so its
     "first day" copy could never fire — the only deviation from its output. */
  const hadPriorHistory = history.some((day) => day.date !== today);

  const days = history.map((day) => ({ ...day }));
  const existing = days.findIndex((day) => day.date === today);
  if (existing >= 0) days[existing].score = score;
  else {
    days.push({ date: today, score });
    if (days.length > HISTORY_SOFT_CAP) days.splice(0, days.length - HISTORY_SOFT_CAP);
  }

  /* A day we have never scored is worth what landed on it. Persisted on the
     way past so the same day is never recomputed. */
  function scoreForDate(date: string): number {
    const known = days.find((day) => day.date === date);
    if (known) return known.score;
    const backfilled = scoreFromCommits(commitsOnDate(inputs.repos, date));
    days.push({ date, score: backfilled });
    return backfilled;
  }

  const window: { date: string; score: number; day: Date }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now);
    day.setDate(day.getDate() - i);
    const date = pulseDateString(day);
    window.push({ date, score: i === 0 ? score : scoreForDate(date), day });
  }
  const lastSeven = window.slice(7);

  const maxTrend = Math.max(...lastSeven.map((d) => d.score), 1);
  const trend: FlowTrendBar[] = lastSeven.map((d) => ({
    date: d.date,
    score: d.score,
    heightPct: Math.round((d.score / maxTrend) * 100),
    tier: flowTier(d.score),
  }));
  const heat: FlowHeatCell[] = window.map((d) => ({
    date: d.date,
    score: d.score,
    tier: d.score > 0 ? flowTier(d.score) : null,
    ring: d.score >= 70,
    title: `${d.day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${d.score}`,
  }));

  // Streak: consecutive scoring days ending today.
  let streak = 0;
  for (const [i, entry] of window.entries()) {
    if (entry.score > 0) streak++;
    else if (i < window.length - 1) streak = 0;
  }

  const weekScores = lastSeven.map((d) => d.score);
  const scoringDays = weekScores.filter((s) => s > 0);
  const wkActive = scoringDays.length;
  const wkAvg = wkActive ? Math.round(scoringDays.reduce((a, b) => a + b, 0) / wkActive) : 0;
  const wkBest = Math.max(...weekScores, 0);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayScore = scoreForDate(pulseDateString(yesterday));
  let delta: string;
  let deltaDirection: FlowScore["deltaDirection"];
  if (!hadPriorHistory && yesterdayScore === 0) {
    delta = "first day";
    deltaDirection = "none";
  } else {
    const diff = score - yesterdayScore;
    delta = `${diff >= 0 ? "+" : "−"}${Math.abs(diff)} vs yest.`;
    deltaDirection = diff >= 0 ? "up" : "down";
  }

  if (days.length > HISTORY_HARD_CAP) days.splice(0, days.length - HISTORY_HARD_CAP);

  const insight =
    [
      commits >= 3 ? `Strong shipping day — ${commits} commits landed.` : null,
      waiting >= 3 ? `${waiting} sessions are waiting on you.` : null,
      switches >= 5 ? `High context-switching (${switches}) is fragmenting focus.` : null,
      edits >= 20 ? "Heavy editing session — good momentum." : null,
      score >= 80 ? "Deep work mode — protect this block." : null,
      score < 20 ? "Light day so far — pick a task and dig in." : null,
    ].find(Boolean) ?? "Keep your current pace through the rest of the day.";

  const factors: FlowFactor[] = weighted.map((f) => ({
    label: f.label,
    weight: f.weight,
    raw: f.raw,
    pct: Math.round(f.raw),
    detail: f.detail,
    sign: f.raw >= f.up ? "↑" : f.raw >= f.mid ? "·" : "↓",
    tier: flowTier(f.raw),
  }));

  return {
    flow: {
      score,
      word: flowWord(score),
      tier: flowTier(score),
      delta,
      deltaDirection,
      streak,
      trend,
      heat,
      factors,
      insight,
      wkActive,
      wkAvg,
      wkBest,
      explain: "Weighted blend: Focus 30%, Shipping 30%, Responsiveness 20%, Momentum 20%.",
    },
    history: days,
  };
}

/**
 * Today, newest first: what landed, what asked you a question, and what the
 * hooks did while you were not looking.
 */
export function computeActivity(inputs: PulseInputs): ActivityEvent[] {
  const { repos, sessions, transcript, now } = inputs;
  const dated: { ts: number; event: ActivityEvent }[] = [];

  for (const repo of repos) {
    for (const commit of repo.commits) {
      const [hour, minute] = commit.time.split(":").map(Number);
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      const branch = commit.branch.trim();
      dated.push({
        ts: at.getTime(),
        event: {
          kind: "commit",
          time: formatTime(at),
          text: `${repo.repo} — committed ${commit.hash.slice(0, 7)}${branch ? ` on ${branch}` : ""}`,
        },
      });
    }
  }

  for (const session of sessions) {
    if (!session.waiting || session.stale) continue;
    const at = new Date(session.lastActive);
    dated.push({
      ts: at.getTime(),
      event: {
        kind: "question",
        time: formatTime(at),
        text: `${session.repo} raised a question — ${session.lastAction.slice(0, 80)}`,
      },
    });
  }

  for (const event of transcript.events) {
    dated.push({
      ts: event.ts,
      event: { kind: event.kind, time: formatTime(new Date(event.ts)), text: event.text },
    });
  }

  return dated
    .sort((a, b) => b.ts - a.ts)
    .slice(0, ACTIVITY_LIMIT)
    .map((d) => d.event);
}
