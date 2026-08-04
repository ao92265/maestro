import { invoke } from "@tauri-apps/api/core";

/**
 * Usage data from Anthropic's OAuth API.
 *
 * Every window is nullable: the API reports different windows per account
 * type. Pro/Max accounts get the session/weekly windows; enterprise seats
 * get a monthly spend budget instead, with the session/weekly windows
 * returned as null. `null` means "window not reported" — distinct from 0%.
 */
export interface UsageData {
  sessionPercent: number | null;
  sessionResetsAt: string | null;
  weeklyPercent: number | null;
  weeklyResetsAt: string | null;
  weeklyOpusPercent: number | null;
  weeklyOpusResetsAt: string | null;
  spendPercent: number | null;
  spendResetsAt: string | null;
  errorMessage: string | null;
  needsAuth: boolean;
}

export async function getClaudeUsage(forceRefresh = false): Promise<UsageData> {
  return invoke<UsageData>("get_claude_usage", { forceRefresh });
}

/** One bar of the usage display. */
export interface UsageWindowBar {
  label: string;
  percent: number;
  resetsAt: string | null;
}

/**
 * Pick which bars to render: one per window the API actually reported.
 * Pro/Max accounts report session + weekly windows; enterprise seats report
 * a monthly spend budget instead (session/weekly come back null for those).
 * Weekly Opus stays tooltip-only, matching the previous display.
 */
export function getUsageBars(usage: UsageData): UsageWindowBar[] {
  const bars: UsageWindowBar[] = [];
  if (usage.sessionPercent !== null) {
    bars.push({ label: "Session", percent: usage.sessionPercent, resetsAt: usage.sessionResetsAt });
  }
  if (usage.weeklyPercent !== null) {
    bars.push({ label: "Week", percent: usage.weeklyPercent, resetsAt: usage.weeklyResetsAt });
  }
  if (usage.spendPercent !== null) {
    bars.push({ label: "Budget", percent: usage.spendPercent, resetsAt: usage.spendResetsAt });
  }
  return bars;
}

export interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
}

export async function getClaudeAccount(): Promise<ClaudeAccount> {
  return invoke<ClaudeAccount>("get_claude_account");
}

/** Format a reset time as a short relative string (e.g. "2h 30m", "3d"). */
export function formatResetTime(isoDate: string | null): string {
  if (!isoDate) return "";
  try {
    const resetDate = new Date(isoDate);
    const time = resetDate.getTime();
    // Invalid dates yield NaN, which silently slips past the comparisons below
    // and renders as "NaNm" — guard explicitly.
    if (Number.isNaN(time)) return "";
    const diffMs = time - Date.now();
    if (diffMs <= 0) return "now";
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffDays > 0) {
      const remH = diffHours % 24;
      return remH > 0 ? `${diffDays}d ${remH}h` : `${diffDays}d`;
    }
    if (diffHours > 0) {
      const remM = diffMins % 60;
      return remM > 0 ? `${diffHours}h ${remM}m` : `${diffHours}h`;
    }
    return `${diffMins}m`;
  } catch {
    return "";
  }
}
