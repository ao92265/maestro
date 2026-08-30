import type { BandItem } from "@/lib/bands";
import type { AiMode } from "@/stores/useSessionStore";

/**
 * Pure logic for the small session-actions sweep: snoozing a decision-queue
 * row, and the closed-session record that makes "reopen a closed batch"
 * possible at all.
 *
 * Same split as `bands.ts` — the rules live here as pure functions so they are
 * unit-testable and the stores stay thin wrappers around them.
 */

export type SnoozeKey = string;

/**
 * Snooze keys for live sessions. A constant because two places have to agree
 * on it: `isPersistableSnoozeKey` and the store's load path.
 */
const SESSION_KEY_PREFIX = "session:";

/**
 * Offered in the snooze menu. Rohcna shipped 3h alone (board.jsx `onSnooze(3)`);
 * the shorter and longer ends cover "after this meeting" and "tomorrow morning".
 */
export const SNOOZE_PRESET_HOURS = [1, 3, 8] as const;

export interface SnoozeEntry {
  key: SnoozeKey;
  /** Epoch ms at which the row returns to its band. */
  untilMs: number;
}

/**
 * Parses persisted snooze entries, tolerating anything a hand-edit or a
 * half-written value could leave behind. A corrupt store costs the user their
 * snoozes, never a crash on launch.
 */
export function parseSnoozeEntries(raw: string | null): SnoozeEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is SnoozeEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as SnoozeEntry).key === "string" &&
      Number.isFinite((e as SnoozeEntry).untilMs),
  );
}

/**
 * Stable identity for a decision-queue row, used as its snooze key.
 *
 * Each kind uses the field that survives a refresh: a handoff's slug is its
 * filename, a PR's URL is globally unique, an ACT run carries its own id. A
 * live session has only its numeric id, which is why session snoozes are not
 * persisted — see {@link isPersistableSnoozeKey}.
 */
export function bandItemKey(item: BandItem): SnoozeKey {
  switch (item.kind) {
    case "session":
      return `${SESSION_KEY_PREFIX}${item.session.id}`;
    case "handoff":
      return `handoff:${item.handoff.slug}`;
    case "pr":
      return `pr:${item.pr.url}`;
    case "run":
      return `run:${item.run.id}`;
  }
}

/**
 * Whether a snooze may outlive the app session.
 *
 * Session ids are reassigned on every launch — `useSessionStore` keeps
 * `parkedSessionIds`/`flaggedSessionIds` in memory for exactly this reason.
 * Writing a session snooze to disk would silence an unrelated future session
 * that happened to reuse the number, so those entries stay in memory only.
 * Handoff slugs, PR URLs and run ids are all durable and do persist.
 */
export function isPersistableSnoozeKey(key: SnoozeKey): boolean {
  return !key.startsWith(SESSION_KEY_PREFIX);
}

/**
 * Drops entries whose deadline has passed. A deadline exactly at `nowMs`
 * counts as expired: the snooze was for a duration, and that duration is over.
 */
export function pruneSnoozes(entries: SnoozeEntry[], nowMs: number): SnoozeEntry[] {
  return entries.filter((e) => e.untilMs > nowMs);
}

/** Snooze `key` until `untilMs`, replacing any existing entry for that row. */
export function upsertSnooze(
  entries: SnoozeEntry[],
  key: SnoozeKey,
  untilMs: number,
): SnoozeEntry[] {
  return [...entries.filter((e) => e.key !== key), { key, untilMs }];
}

/** Unsnooze: bring the row back now, without waiting for its deadline. */
export function removeSnooze(entries: SnoozeEntry[], key: SnoozeKey): SnoozeEntry[] {
  return entries.filter((e) => e.key !== key);
}

/**
 * Splits a band's rows into the ones still due and the ones snoozed.
 *
 * Returns both halves rather than filtering, so the view can show a "N
 * snoozed" shelf. A snooze that hid rows with no way to see or undo them
 * would be indistinguishable from losing them.
 */
export function partitionSnoozed(
  items: BandItem[],
  entries: SnoozeEntry[],
  nowMs: number,
): { visible: BandItem[]; snoozed: BandItem[] } {
  const active = new Set(pruneSnoozes(entries, nowMs).map((e) => e.key));
  const visible: BandItem[] = [];
  const snoozed: BandItem[] = [];
  for (const item of items) {
    (active.has(bandItemKey(item)) ? snoozed : visible).push(item);
  }
  return { visible, snoozed };
}

export interface ClosedSessionRecord {
  id: number;
  name: string | null;
  /** Which CLI to relaunch — a Codex session must not come back as Claude. */
  mode: AiMode;
  /** Where the session was actually running — worktree path or project root. */
  projectPath: string;
  workingDirectory: string;
  branch: string | null;
}

export interface ClosedBatch {
  id: string;
  closedAtMs: number;
  projectPath: string;
  projectName: string;
  sessions: ClosedSessionRecord[];
}

/**
 * How long a closed batch stays reopenable.
 *
 * Short on purpose: this is an undo for "I closed the wrong tab", not a
 * session archive. The record is in-memory anyway (session ids are ephemeral,
 * see {@link isPersistableSnoozeKey}), so a longer window would mostly promise
 * a restore that an app restart already took away.
 */
export const CLOSED_BATCH_RETENTION_MS = 30 * 60 * 1000;

/** Cap on remembered batches — the shelf is an undo strip, not a list. */
export const MAX_CLOSED_BATCHES = 5;

/** Drops batches past {@link CLOSED_BATCH_RETENTION_MS}. */
export function pruneClosedBatches(batches: ClosedBatch[], nowMs: number): ClosedBatch[] {
  return batches.filter((b) => nowMs - b.closedAtMs <= CLOSED_BATCH_RETENTION_MS);
}

/** Records a newly closed batch newest-first, pruning expired ones and capping the list. */
export function recordClosedBatch(
  batches: ClosedBatch[],
  batch: ClosedBatch,
  nowMs: number,
): ClosedBatch[] {
  return [batch, ...pruneClosedBatches(batches, nowMs)].slice(0, MAX_CLOSED_BATCHES);
}

/**
 * Display name for a project path: its last component.
 *
 * Mirrors what the Rust handoff parser puts in `HandoffInfo.repo`, so a
 * closed batch and a parked handoff for the same checkout read the same.
 * Tolerates trailing separators and both separator styles.
 */
export function projectDisplayName(projectPath: string): string {
  const parts = projectPath.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}
