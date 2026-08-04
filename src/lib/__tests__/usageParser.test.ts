import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatResetTime, getUsageBars, type UsageData } from "../usageParser";

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
    spendPercent: null,
    spendResetsAt: null,
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

  it("treats 0% as a reported window, not an absent one", () => {
    const bars = getUsageBars({ ...noWindows, sessionPercent: 0, weeklyPercent: 0 });
    expect(bars.map((b) => b.label)).toEqual(["Session", "Week"]);
  });

  it("returns no bars when the API reports no windows", () => {
    expect(getUsageBars(noWindows)).toEqual([]);
  });

  it("keeps weekly Opus out of the bar list (tooltip-only)", () => {
    const bars = getUsageBars({ ...noWindows, weeklyPercent: 50, weeklyOpusPercent: 12 });
    expect(bars.map((b) => b.label)).toEqual(["Week"]);
  });
});
