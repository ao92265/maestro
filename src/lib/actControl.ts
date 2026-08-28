/**
 * Types and pure predicates for the ACT control panel — the read/write
 * surface behind the Factory's run list: the autonomy ladder, the guardrail
 * rules and their intervention feed, token spend, the intake ledger and the
 * session replay index.
 *
 * As with `act.ts`, the wire shapes mirror the Rust relay in
 * `src-tauri/src/commands/act_control.rs` (the webview's CSP blocks direct
 * local HTTP). ACT's own routes answer in a mix of camelCase and the task
 * store's snake_case; normalization happens in Rust so the frontend only ever
 * sees the typed rows below.
 */

/** ACT's autonomy ladder (its `src/policy/autonomy.ts`). */
export type AutonomyLevel = "L0" | "L1" | "L2";
export type TaskClass = "docs" | "labels" | "copy" | "dependencies" | "code";

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["L0", "L1", "L2"];
export const TASK_CLASSES: readonly TaskClass[] = [
  "docs",
  "labels",
  "copy",
  "dependencies",
  "code",
];

/** What each rung means at the delivery boundary, for the panel's own labels. */
export const AUTONOMY_LEVEL_BLURB: Record<AutonomyLevel, string> = {
  L0: "Draft PR, you commit",
  L1: "Normal PR, you merge",
  L2: "Auto-merge a sample",
};

/**
 * The only classes ACT will ever auto-merge unless full-auto is on — mirrors
 * `L2_WHITELISTED_CLASSES` in its autonomy.ts. Kept here so the panel can warn
 * before a setting silently behaves as one rung lower.
 */
export const L2_WHITELISTED_CLASSES: ReadonlySet<TaskClass> = new Set(["docs", "labels", "copy"]);

export interface ActAutonomyPolicy {
  default: AutonomyLevel;
  classes: Partial<Record<TaskClass, AutonomyLevel>>;
  /** Fraction of L2-eligible deliveries that actually auto-merge. */
  l2SampleRate: number;
  /** Fraction of auto-merged PRs flagged for human post-merge review. */
  humanSampleRate: number;
  /** Full-auto: let any class reach L2, bypassing the whitelist. */
  allowAllClasses: boolean;
  /** Merge on review-approve rather than waiting for GitHub CI. */
  directMerge: boolean;
}

export interface ActPolicySnapshot {
  autonomy: ActAutonomyPolicy;
  /** ACT's global write switch; false means the ladder is advisory today. */
  writesEnabled: boolean;
}

/** A patch sent to ACT's `PUT /api/policy`; absent keys are left alone. */
export type ActAutonomyPatch = Partial<ActAutonomyPolicy>;

export type InterventionRuleType =
  | "stale_agent"
  | "cost_overrun"
  | "context_exhaustion"
  | "error_loop"
  | "runtime_overrun";

export interface ActInterventionRule {
  type: string;
  /** Units depend on the rule type — see `describeThreshold`. */
  threshold: number;
  action: string;
  enabled: boolean;
}

export interface ActInterventionEvent {
  ruleType: string;
  agentId: string;
  action: string;
  reason: string;
  timestamp: string | null;
}

export interface ActBudget {
  dailyTokensUsed: number;
  dailyTokensRemaining: number;
  dailyCostUsed: number;
  dailyCostRemaining: number;
  isOverBudget: boolean;
  lastResetDate: string | null;
  weeklyTokensUsed: number;
  weeklyTokensLimit: number;
  /** 0-100, straight from ACT. */
  weeklyUsagePercent: number;
  /** Tracked separately by ACT and excluded from its token-limit checks. */
  cacheTokensUsed: number | null;
}

/**
 * One row of the intake ledger: an ACT task with what it cost in attempts and
 * what it delivered. `retryCount`/`failoverCount` are two separate columns in
 * ACT's task store (transient-failure retries vs runtime failovers).
 */
export interface ActLedgerEntry {
  id: string;
  title: string;
  status: string;
  retryCount: number;
  failoverCount: number;
  prUrl: string | null;
  branchName: string | null;
  blockReason: string | null;
  lastFailoverReason: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

/** Ledger rows plus the untruncated task count from the relay. */
export interface ActLedger {
  entries: ActLedgerEntry[];
  total: number;
}

export interface ActReplay {
  sessionId: string;
  agentId: string;
  taskId: string;
  runtime: string;
  startedAt: string | null;
  eventCount: number;
}

/** A replay's events plus how many the stored session actually has. */
export interface ActReplayTimeline {
  events: ActReplayEvent[];
  total: number;
}

export interface ActReplayEvent {
  timestamp: string | null;
  type: string;
  agentId: string;
  /** One-line rendering of the event's payload, flattened in Rust. */
  summary: string;
}

/** The per-subsystem read record the panel keeps for every ACT endpoint. */
export interface SubsystemRead {
  /** Last successful read; 0 = never. */
  fetchedAt: number;
  /** Last failure, cleared on the next success. */
  error: string | null;
}

export type SubsystemKey = "policy" | "rules" | "events" | "budget" | "ledger" | "replays";

export const ACT_SUBSYSTEMS: readonly { key: SubsystemKey; label: string }[] = [
  { key: "policy", label: "Autonomy policy" },
  { key: "rules", label: "Guardrail rules" },
  { key: "events", label: "Intervention feed" },
  { key: "budget", label: "Token spend" },
  { key: "ledger", label: "Intake ledger" },
  { key: "replays", label: "Session replays" },
];

export type SubsystemReads = Record<SubsystemKey, SubsystemRead>;

/** The rung that actually applies to a class: override, else the default. */
export function effectiveLevel(policy: ActAutonomyPolicy, taskClass: TaskClass): AutonomyLevel {
  return policy.classes[taskClass] ?? policy.default ?? "L1";
}

/**
 * The gap between what the ladder is set to and what ACT will do. Setting
 * `code` to L2 is accepted and then hard-downgraded at the delivery boundary
 * unless full-auto is on — without this note the panel would show a rung the
 * engine never honours.
 */
export function l2Caveat(policy: ActAutonomyPolicy, taskClass: TaskClass): string | null {
  if (effectiveLevel(policy, taskClass) !== "L2") return null;
  if (policy.allowAllClasses || L2_WHITELISTED_CLASSES.has(taskClass)) return null;
  return `ACT downgrades ${taskClass} to L1 at delivery: only docs, labels and copy auto-merge unless full-auto is on.`;
}

/** Human reading of a rule threshold, whose unit depends on the rule type. */
export function describeThreshold(ruleType: string, threshold: number): string {
  switch (ruleType) {
    case "stale_agent":
      return `${Math.round(threshold / 60)}m of silence`;
    case "runtime_overrun":
      return `${Math.round(threshold / 60)}m of runtime`;
    case "cost_overrun":
      return `${Math.round(threshold * 100)}% of daily budget`;
    case "context_exhaustion":
      return `${Math.round(threshold * 100)}% of context`;
    case "error_loop":
      return `${threshold} repeats`;
    default:
      return String(threshold);
  }
}

/** Attempts a human would count: the first run plus every retry and failover. */
export function attemptsOf(entry: ActLedgerEntry): number {
  return 1 + entry.retryCount + entry.failoverCount;
}

/** The delivery list: ledger rows that actually produced a PR, newest first. */
export function deliveredPrs(ledger: ActLedgerEntry[]): ActLedgerEntry[] {
  /* Date.parse returns NaN for a missing or malformed completedAt, and a
     comparator that returns NaN leaves the order unspecified — sinking the
     undated rows keeps it total. */
  const when = (entry: ActLedgerEntry): number => {
    const parsed = Date.parse(entry.completedAt ?? "");
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return ledger
    .filter((entry) => entry.prUrl !== null && entry.prUrl !== "")
    .sort((a, b) => when(b) - when(a));
}

/**
 * Percentage of the daily token allowance spent, or null when the allowance
 * cannot be known.
 *
 * The cap has to be reconstructed as used + remaining because ACT does not
 * report `dailyTokenLimit` on any route. That reconstruction only holds while
 * there is headroom left: `getTokensRemaining()` is `Math.max(0, limit -
 * used)`, so once spending passes the cap `remaining` pins to 0 and the sum
 * collapses to `used` — which would render a 40% overrun as a tidy 100% of a
 * cap equal to the overspend. When ACT says it is over budget, the real cap is
 * unrecoverable here, so report nothing rather than a flattering fiction.
 */
export function budgetHeadroom(budget: ActBudget): number | null {
  if (budget.isOverBudget) return null;
  const allowance = budget.dailyTokensUsed + budget.dailyTokensRemaining;
  if (allowance <= 0) return null;
  return Math.round((budget.dailyTokensUsed / allowance) * 100);
}

/** True once any subsystem has ever answered — i.e. the engine is reachable. */
export function engineReachable(reads: SubsystemReads): boolean {
  return ACT_SUBSYSTEMS.some(({ key }) => (reads[key]?.fetchedAt ?? 0) > 0);
}

/**
 * True when the panel has tried and nothing answered: ACT is simply not
 * running. That is a NORMAL state and reads as one offline line, never as a
 * wall of six connection errors.
 */
export function engineOffline(reads: SubsystemReads): boolean {
  if (engineReachable(reads)) return false;
  return ACT_SUBSYSTEMS.some(({ key }) => reads[key]?.error != null);
}

/**
 * The "unreadable subsystem" flags. ACT exposes no such concept — nothing in
 * its source records one — so the panel derives it from its own reads: a
 * subsystem is unreadable when its read failed while OTHER subsystems are
 * answering. That is the real fault this flag exists to catch — an engine that
 * is up but cannot serve one of its own surfaces, e.g. an older build missing
 * a route.
 *
 * A dead engine is deliberately not six faults. With nothing reachable at all,
 * every subsystem would flag at once and bury the one fact that matters, which
 * is that ACT is off; `engineOffline` covers that case instead.
 */
export function unreadableSubsystems(
  reads: SubsystemReads,
): { key: SubsystemKey; label: string; reason: string }[] {
  if (!engineReachable(reads)) return [];
  return ACT_SUBSYSTEMS.flatMap(({ key, label }) => {
    const read = reads[key];
    if (!read?.error) return [];
    return [{ key, label, reason: read.error }];
  });
}

/** Newest successful read across all subsystems; 0 when none has answered. */
export function lastReadAt(reads: SubsystemReads): number {
  return ACT_SUBSYSTEMS.reduce(
    (newest, { key }) => Math.max(newest, reads[key]?.fetchedAt ?? 0),
    0,
  );
}
