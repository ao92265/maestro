/**
 * Types and pure helpers for night runs — starting and stopping ACT's intake
 * loop from inside Vanguard, on a schedule.
 *
 * The loop itself is ACT's ScrumMaster (`/api/scrum-master/*`), driven through
 * the relay in `src-tauri/src/commands/night_run.rs`. The SCHEDULE lives in
 * Rust too: it has to keep ticking while the Factory overlay is unmounted, so
 * the frontend is a viewer here rather than the clock. Everything below is
 * either a wire shape or presentation over one.
 *
 * The failure this module exists to prevent is a window that quietly does
 * nothing all night, so every helper here answers "what happens next, and
 * what happened last time" out loud.
 */

import type { AutonomyLevel } from "@/lib/actControl";

export const MINUTES_IN_DAY = 1440;

/** What Vanguard hands ACT when it starts the loop, plus the window. */
export interface NightRunSettings {
  /** ACT's `pollInterval`, in minutes rather than the wire's milliseconds. */
  intervalMinutes: number;
  /** GitHub issue label the intake pulls from; empty means every issue. */
  label: string;
  /** ACT's `maxConcurrentAgents`. */
  maxAgents: number;
  /** Applied to ACT's autonomy ladder before the loop starts. */
  autonomy: AutonomyLevel;
  windowEnabled: boolean;
  /** Local minutes past midnight; the window may cross midnight. */
  startMinute: number;
  stopMinute: number;
}

/** ACT's `/api/scrum-master/status`, normalized in Rust. */
export interface NightRunLoop {
  isRunning: boolean;
  activeAgents: number;
  pendingTasks: number;
  inProgressTasks: number;
  completedToday: number;
  blockedTasks: number;
  lastCheck: string | null;
  nextCheck: string | null;
}

export type NightRunAction = "start" | "stop";

/** One thing the schedule (or the user) did, kept so a silent night shows. */
export interface NightRunOutcome {
  at: string;
  action: NightRunAction;
  /** True when the schedule fired it, false when a button did. */
  scheduled: boolean;
  ok: boolean;
  detail: string;
}

export interface NightRunView {
  settings: NightRunSettings;
  /** Null when ACT did not answer this read; `loopError` says why. */
  loop: NightRunLoop | null;
  loopError: string | null;
  /** Last successful loop read, ms epoch; 0 = never. */
  fetchedAt: number;
  inWindow: boolean;
  nextStartAt: string | null;
  nextStopAt: string | null;
  /** True when the schedule started what is running — and so may stop it. */
  scheduleOwnsLoop: boolean;
  /** Newest first. */
  outcomes: NightRunOutcome[];
}

/** ACT rejects nothing here, but these are the bounds a night run is sane in. */
export const INTERVAL_BOUNDS = { min: 1, max: 240 } as const;
export const AGENT_BOUNDS = { min: 1, max: 10 } as const;

const CLOCK = /^(\d{1,2}):(\d{2})$/;

/** "23:00" → 1380. Null for anything that is not a time of day. */
export function parseClock(text: string): number | null {
  const match = CLOCK.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 1380 → "23:00", wrapping so arithmetic on a minute never prints "25:00". */
export function formatClock(minute: number): string {
  const wrapped = ((Math.round(minute) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** True when the window runs past midnight into the next day. */
export function crossesMidnight(startMinute: number, stopMinute: number): boolean {
  return stopMinute < startMinute;
}

/** How long the window lasts, counting across the day boundary. */
export function windowLengthMinutes(startMinute: number, stopMinute: number): number {
  return (((stopMinute - startMinute) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function describeWindow(settings: NightRunSettings): string {
  const length = windowLengthMinutes(settings.startMinute, settings.stopMinute);
  return `${formatClock(settings.startMinute)} → ${formatClock(settings.stopMinute)} · ${formatDuration(length)}`;
}

/**
 * The one-line reason these settings cannot run, or null. Checked before the
 * write rather than after: a window of zero length is accepted by every layer
 * below and then simply never fires.
 */
export function settingsProblem(settings: NightRunSettings): string | null {
  if (
    !Number.isFinite(settings.intervalMinutes) ||
    settings.intervalMinutes < INTERVAL_BOUNDS.min ||
    settings.intervalMinutes > INTERVAL_BOUNDS.max
  ) {
    return `Check interval must be between ${INTERVAL_BOUNDS.min} and ${INTERVAL_BOUNDS.max} minutes.`;
  }
  if (
    !Number.isFinite(settings.maxAgents) ||
    settings.maxAgents < AGENT_BOUNDS.min ||
    settings.maxAgents > AGENT_BOUNDS.max
  ) {
    return `Agent limit must be between ${AGENT_BOUNDS.min} and ${AGENT_BOUNDS.max}.`;
  }
  if (
    settings.windowEnabled &&
    windowLengthMinutes(settings.startMinute, settings.stopMinute) === 0
  ) {
    return "The window starts and stops at the same time, so it would never run.";
  }
  return null;
}

/** "in 5h 4m", or "" when the instant is unknown or already past. */
function until(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return `in ${formatDuration(ms / 60000)}`;
}

/**
 * What the schedule will do next, in one line. This is the panel's honesty
 * check: with a window enabled it always names a wall-clock time, so "nothing
 * happened last night" is never the first time you learn the window was off.
 */
export function nextWindowLine(view: NightRunView, now: number = Date.now()): string {
  const { settings } = view;
  if (!settings.windowEnabled) {
    return "No overnight window. The loop runs only while you have it started.";
  }
  if (view.inWindow) {
    const delta = until(view.nextStopAt, now);
    return `In the window — stops at ${formatClock(settings.stopMinute)}${delta ? `, ${delta}` : ""}.`;
  }
  const delta = until(view.nextStartAt, now);
  if (!view.nextStartAt) return "Window on, but the next run is not scheduled yet.";
  return `Next window starts at ${formatClock(settings.startMinute)}${delta ? `, ${delta}` : ""}.`;
}

export function outcomeLabel(outcome: NightRunOutcome): string {
  const who = outcome.scheduled ? "Schedule" : "You";
  const verb = outcome.action === "start" ? "start" : "stop";
  if (outcome.ok) {
    const past = outcome.action === "start" ? "started" : "stopped";
    return `${who} ${past} the loop`;
  }
  return `${who} could not ${verb} the loop`;
}

export function loopSummary(loop: NightRunLoop | null): string {
  if (!loop) return "No status read from ACT yet.";
  return `${loop.activeAgents} working · ${loop.pendingTasks} pending · ${loop.blockedTasks} blocked · ${loop.completedToday} done today`;
}

/**
 * What a night run is before anyone configures one. Mirrors the defaults in
 * `night_run.rs`, and is what the panel sends if a button is somehow pressed
 * before the first status read lands.
 */
export const DEFAULT_NIGHT_RUN_SETTINGS: NightRunSettings = {
  intervalMinutes: 5,
  label: "",
  maxAgents: 2,
  autonomy: "L1",
  windowEnabled: false,
  startMinute: 23 * 60,
  stopMinute: 6 * 60,
};
