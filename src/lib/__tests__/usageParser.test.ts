import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatResetTime,
  getUsageBars,
  mostCriticalBar,
  type UsageData,
} from "../usageParser";

describe("formatResetTime", () => {
  // Anchor "now" so relative formatting is deterministic.
  const NOW = new Date("2026-06-05T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty string for null input", () => {
    expect(formatResetTime(null)).toBe("");
  });

  it("returns 'now' when the reset time is in the past", () => {
    expect(formatResetTime("2026-06-05T11:00:00.000Z")).toBe("now");
  });

  it("returns 'now' when the reset time is exactly now", () => {
    expect(formatResetTime("2026-06-05T12:00:00.000Z")).toBe("now");
  });

  it("formats sub-hour durations in minutes", () => {
    expect(formatResetTime("2026-06-05T12:45:00.000Z")).toBe("45m");
  });

  it("formats whole-hour durations without trailing minutes", () => {
    expect(formatResetTime("2026-06-05T14:00:00.000Z")).toBe("2h");
  });

  it("formats hours with remaining minutes", () => {
    expect(formatResetTime("2026-06-05T14:30:00.000Z")).toBe("2h 30m");
  });

  it("formats whole-day durations without trailing hours", () => {
    expect(formatResetTime("2026-06-08T12:00:00.000Z")).toBe("3d");
  });

  it("formats days with remaining hours", () => {
    expect(formatResetTime("2026-06-08T17:00:00.000Z")).toBe("3d 5h");
  });

  it("returns an empty string for an unparseable date", () => {
    expect(formatResetTime("not-a-date")).toBe("");
  });
});

describe("getUsageBars", () => {
  /** All windows absent — the shape the backend returns for error/auth paths. */
  const noWindows: UsageData = {
    sessionPercent: null,
    sessionResetsAt: null,
    weeklyPercent: null,
    weeklyResetsAt: null,
    weeklyOpusPercent: null,
    weeklyOpusResetsAt: null,
    weeklySonnetPercent: null,
    weeklySonnetResetsAt: null,
    weeklyOauthAppsPercent: null,
    weeklyOauthAppsResetsAt: null,
    spendPercent: null,
    spendResetsAt: null,
    spendUsedDollars: null,
    spendLimitDollars: null,
    errorMessage: null,
    needsAuth: false,
  };

  it("maps a Pro/Max account (session + weekly windows) to Session and Week bars", () => {
    const bars = getUsageBars({
      ...noWindows,
      sessionPercent: 42,
      sessionResetsAt: "2026-08-04T20:00:00.000Z",
      weeklyPercent: 63,
      weeklyResetsAt: "2026-08-08T00:00:00.000Z",
    });
    expect(bars).toEqual([
      { label: "Session", percent: 42, resetsAt: "2026-08-04T20:00:00.000Z" },
      { label: "Week", percent: 63, resetsAt: "2026-08-08T00:00:00.000Z" },
    ]);
  });

  it("maps an enterprise account (spend budget only) to a single Budget bar", () => {
    // Real /api/oauth/usage response for enterprise seats (Claude Code 2.1.x,
    // 2026-08): five_hour/seven_day/seven_day_opus are null and the monthly
    // dollar budget arrives as the `cinder_cove` window.
    const bars = getUsageBars({
      ...noWindows,
      spendPercent: 85.70003930000001,
      spendResetsAt: "2026-09-06T10:33:51.866730+00:00",
    });
    expect(bars).toEqual([
      { label: "Budget", percent: 85.70003930000001, resetsAt: "2026-09-06T10:33:51.866730+00:00" },
    ]);
  });

  it("adds a dollars detail to the Budget bar when the API reports them", () => {
    const bars = getUsageBars({
      ...noWindows,
      spendPercent: 85.7,
      spendResetsAt: "2026-09-06T10:33:51.866730+00:00",
      spendUsedDollars: 857.000393,
      spendLimitDollars: 1000,
    });
    expect(bars).toEqual([
      {
        label: "Budget",
        percent: 85.7,
        resetsAt: "2026-09-06T10:33:51.866730+00:00",
        detail: "$857 / $1000",
      },
    ]);
  });

  it("degrades to a percent-only Budget row when either dollar figure is missing", () => {
    const bars = getUsageBars({
      ...noWindows,
      spendPercent: 85.7,
      spendUsedDollars: 857.000393,
      spendLimitDollars: null,
    });
    expect(bars).toEqual([{ label: "Budget", percent: 85.7, resetsAt: null }]);
    expect(bars[0]).not.toHaveProperty("detail");
  });

  it("treats 0% as a reported window, not an absent one", () => {
    const bars = getUsageBars({ ...noWindows, sessionPercent: 0, weeklyPercent: 0 });
    expect(bars.map((b) => b.label)).toEqual(["Session", "Week"]);
  });

  it("returns no bars when the API reports no windows", () => {
    expect(getUsageBars(noWindows)).toEqual([]);
  });

  it("promotes weekly Opus to its own row (was tooltip-only)", () => {
    const bars = getUsageBars({
      ...noWindows,
      weeklyPercent: 50,
      weeklyOpusPercent: 12,
      weeklyOpusResetsAt: "2026-08-08T00:00:00.000Z",
    });
    expect(bars).toEqual([
      { label: "Week", percent: 50, resetsAt: null },
      { label: "Week (Opus)", percent: 12, resetsAt: "2026-08-08T00:00:00.000Z" },
    ]);
  });

  it("shows every reported window, including per-model and OAuth-apps weeklies", () => {
    const bars = getUsageBars({
      ...noWindows,
      sessionPercent: 10,
      weeklyPercent: 20,
      weeklyOpusPercent: 30,
      weeklySonnetPercent: 40,
      weeklyOauthAppsPercent: 50,
      spendPercent: 60,
    });
    expect(bars.map((b) => b.label)).toEqual([
      "Session",
      "Week",
      "Week (Opus)",
      "Week (Sonnet)",
      "Week (OAuth apps)",
      "Budget",
    ]);
  });
});

describe("mostCriticalBar", () => {
  it("returns null for an empty bar list", () => {
    expect(mostCriticalBar([])).toBeNull();
  });

  it("picks the window with the highest utilization", () => {
    const top = mostCriticalBar([
      { label: "Session", percent: 42, resetsAt: null },
      { label: "Week (Opus)", percent: 91, resetsAt: null },
      { label: "Week", percent: 63, resetsAt: null },
    ]);
    expect(top?.label).toBe("Week (Opus)");
  });

  it("keeps the first (most general) window on a tie", () => {
    const top = mostCriticalBar([
      { label: "Session", percent: 50, resetsAt: null },
      { label: "Week", percent: 50, resetsAt: null },
    ]);
    expect(top?.label).toBe("Session");
  });

  it("skips non-finite percents instead of letting NaN win", () => {
    const top = mostCriticalBar([
      { label: "Session", percent: NaN, resetsAt: null },
      { label: "Week", percent: 99, resetsAt: null },
    ]);
    expect(top?.label).toBe("Week");
  });
});
