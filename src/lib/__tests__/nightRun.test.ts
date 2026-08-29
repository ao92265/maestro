import { describe, expect, it } from "vitest";

import {
  crossesMidnight,
  describeWindow,
  formatClock,
  formatDuration,
  loopSummary,
  type NightRunSettings,
  type NightRunView,
  nextWindowLine,
  outcomeLabel,
  parseClock,
  settingsProblem,
  windowLengthMinutes,
} from "@/lib/nightRun";

const SETTINGS: NightRunSettings = {
  intervalMinutes: 5,
  label: "",
  maxAgents: 2,
  autonomy: "L1",
  windowEnabled: true,
  startMinute: 23 * 60,
  stopMinute: 6 * 60,
};

function view(overrides: Partial<NightRunView> = {}): NightRunView {
  return {
    settings: SETTINGS,
    loop: null,
    loopError: null,
    fetchedAt: 0,
    inWindow: false,
    nextStartAt: null,
    nextStopAt: null,
    scheduleOwnsLoop: false,
    outcomes: [],
    ...overrides,
  };
}

describe("parseClock", () => {
  it("reads a wall clock into minutes past midnight", () => {
    expect(parseClock("23:00")).toBe(1380);
    expect(parseClock("06:00")).toBe(360);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("9:05")).toBe(545);
  });

  it("refuses anything that is not a time of day", () => {
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(parseClock("tonight")).toBeNull();
  });
});

describe("formatClock", () => {
  it("pads back to a two-digit wall clock", () => {
    expect(formatClock(1380)).toBe("23:00");
    expect(formatClock(545)).toBe("09:05");
    expect(formatClock(0)).toBe("00:00");
  });

  it("wraps a minute past the end of the day rather than printing 25:00", () => {
    expect(formatClock(1440)).toBe("00:00");
    expect(formatClock(-60)).toBe("23:00");
  });
});

/* The case this whole feature turns on: an overnight window runs from one day
   into the next, and every naive start<stop comparison gets it backwards. */
describe("a window that crosses midnight", () => {
  it("is recognised as crossing", () => {
    expect(crossesMidnight(23 * 60, 6 * 60)).toBe(true);
    expect(crossesMidnight(9 * 60, 17 * 60)).toBe(false);
    expect(crossesMidnight(600, 600)).toBe(false);
  });

  it("measures its length across the day boundary", () => {
    expect(windowLengthMinutes(23 * 60, 6 * 60)).toBe(420);
    expect(windowLengthMinutes(9 * 60, 17 * 60)).toBe(480);
    expect(windowLengthMinutes(23 * 60 + 30, 0)).toBe(30);
  });

  it("has no length when it starts and stops at the same minute", () => {
    expect(windowLengthMinutes(600, 600)).toBe(0);
  });

  it("describes itself with both ends and its length", () => {
    expect(describeWindow(SETTINGS)).toBe("23:00 → 06:00 · 7h");
    expect(describeWindow({ ...SETTINGS, startMinute: 9 * 60, stopMinute: 17 * 60 + 30 })).toBe(
      "09:00 → 17:30 · 8h 30m",
    );
  });
});

describe("formatDuration", () => {
  it("reads in hours and minutes", () => {
    expect(formatDuration(420)).toBe("7h");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(450)).toBe("7h 30m");
    expect(formatDuration(0)).toBe("0m");
  });
});

describe("settingsProblem", () => {
  it("passes a usable night run", () => {
    expect(settingsProblem(SETTINGS)).toBeNull();
  });

  it("names a zero-length window rather than scheduling nothing", () => {
    expect(settingsProblem({ ...SETTINGS, stopMinute: 23 * 60 })).toMatch(/same time/i);
  });

  it("ignores the window's shape while the window is off", () => {
    expect(settingsProblem({ ...SETTINGS, windowEnabled: false, stopMinute: 23 * 60 })).toBeNull();
  });

  it("rejects an interval or agent count ACT would not accept", () => {
    expect(settingsProblem({ ...SETTINGS, intervalMinutes: 0 })).toMatch(/interval/i);
    expect(settingsProblem({ ...SETTINGS, intervalMinutes: 999 })).toMatch(/interval/i);
    expect(settingsProblem({ ...SETTINGS, maxAgents: 0 })).toMatch(/agent/i);
    expect(settingsProblem({ ...SETTINGS, maxAgents: 99 })).toMatch(/agent/i);
  });
});

/* The anti-silence line. A window that quietly does nothing is this feature's
   main failure mode, so the panel always says what happens next and when. */
describe("nextWindowLine", () => {
  it("says the loop is manual when no window is set", () => {
    expect(nextWindowLine(view({ settings: { ...SETTINGS, windowEnabled: false } }))).toMatch(
      /no overnight window/i,
    );
  });

  it("counts down to the stop while inside the window", () => {
    const line = nextWindowLine(
      view({ inWindow: true, nextStopAt: new Date(Date.now() + 2 * 3600_000).toISOString() }),
      Date.now(),
    );
    expect(line).toContain("06:00");
    expect(line).toContain("2h");
  });

  it("counts down to the next start while outside it", () => {
    const line = nextWindowLine(
      view({ nextStartAt: new Date(Date.now() + 5 * 3600_000 + 4 * 60_000).toISOString() }),
      Date.now(),
    );
    expect(line).toContain("23:00");
    expect(line).toContain("5h 4m");
  });

  it("admits when the schedule has not been computed yet", () => {
    expect(nextWindowLine(view())).toMatch(/not scheduled/i);
  });
});

describe("outcomeLabel", () => {
  it("says who acted and whether it worked", () => {
    expect(outcomeLabel({ at: "", action: "start", scheduled: true, ok: true, detail: "" })).toBe(
      "Schedule started the loop",
    );
    expect(outcomeLabel({ at: "", action: "start", scheduled: true, ok: false, detail: "" })).toBe(
      "Schedule could not start the loop",
    );
    expect(outcomeLabel({ at: "", action: "stop", scheduled: false, ok: true, detail: "" })).toBe(
      "You stopped the loop",
    );
    expect(outcomeLabel({ at: "", action: "stop", scheduled: true, ok: false, detail: "" })).toBe(
      "Schedule could not stop the loop",
    );
  });
});

describe("loopSummary", () => {
  it("counts what the loop is carrying", () => {
    expect(
      loopSummary({
        isRunning: true,
        activeAgents: 2,
        pendingTasks: 5,
        inProgressTasks: 2,
        completedToday: 3,
        blockedTasks: 1,
        lastCheck: null,
        nextCheck: null,
      }),
    ).toBe("2 working · 5 pending · 1 blocked · 3 done today");
  });

  it("says nothing has been read rather than printing zeroes", () => {
    expect(loopSummary(null)).toMatch(/no status/i);
  });
});
