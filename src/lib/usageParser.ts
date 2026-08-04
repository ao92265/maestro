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
  weeklySonnetPercent: number | null;
  weeklySonnetResetsAt: string | null;
  weeklyOauthAppsPercent: number | null;
  weeklyOauthAppsResetsAt: string | null;
  spendPercent: number | null;
  spendResetsAt: string | null;
  /** Dollars spent / total in the monthly budget window (enterprise only). */
  spendUsedDollars: number | null;
  spendLimitDollars: number | null;
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
  /** Extra context shown next to the bar, e.g. "$857 / $1000" for Budget. */
  detail?: string;
}

/**
 * Pick which bars to render: one per window the API actually reported
 * (null = not reported, distinct from 0%). Pro/Max accounts report the
 * session + weekly windows (incl. per-model weeklies); enterprise seats
 * report a monthly spend budget instead (session/weekly come back null).
 */
export function getUsageBars(usage: UsageData): UsageWindowBar[] {
  const bars: UsageWindowBar[] = [];
  if (usage.sessionPercent !== null) {
    bars.push({ label: "Session", percent: usage.sessionPercent, resetsAt: usage.sessionResetsAt });
  }
  if (usage.weeklyPercent !== null) {
    bars.push({ label: "Week", percent: usage.weeklyPercent, resetsAt: usage.weeklyResetsAt });
  }
  if (usage.weeklyOpusPercent !== null) {
    bars.push({
      label: "Week (Opus)",
      percent: usage.weeklyOpusPercent,
      resetsAt: usage.weeklyOpusResetsAt,
    });
  }
  if (usage.weeklySonnetPercent !== null) {
    bars.push({
      label: "Week (Sonnet)",
      percent: usage.weeklySonnetPercent,
      resetsAt: usage.weeklySonnetResetsAt,
    });
  }
  if (usage.weeklyOauthAppsPercent !== null) {
    bars.push({
      label: "Week (OAuth apps)",
      percent: usage.weeklyOauthAppsPercent,
      resetsAt: usage.weeklyOauthAppsResetsAt,
    });
  }
  if (usage.spendPercent !== null) {
    const detail =
      usage.spendUsedDollars !== null && usage.spendLimitDollars !== null
        ? `$${Math.round(usage.spendUsedDollars)} / $${Math.round(usage.spendLimitDollars)}`
        : undefined;
    bars.push({
      label: "Budget",
      percent: usage.spendPercent,
      resetsAt: usage.spendResetsAt,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return bars;
}

/**
 * The single most critical window (highest utilization) — shown in the
 * dropdown trigger so glanceability survives the compression. Ties keep the
 * first (most general) window. Returns null when nothing was reported.
 */
export function mostCriticalBar(bars: UsageWindowBar[]): UsageWindowBar | null {
  let top: UsageWindowBar | null = null;
  for (const bar of bars) {
    if (top === null || bar.percent > top.percent) top = bar;
  }
  return top;
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
