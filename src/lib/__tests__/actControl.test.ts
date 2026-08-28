import { describe, expect, it } from "vitest";

import {
  ACT_SUBSYSTEMS,
  type ActAutonomyPolicy,
  type ActLedgerEntry,
  attemptsOf,
  budgetHeadroom,
  deliveredPrs,
  describeThreshold,
  effectiveLevel,
  l2Caveat,
  unreadableSubsystems,
} from "../actControl";

const policy = (over: Partial<ActAutonomyPolicy> = {}): ActAutonomyPolicy => ({
  default: "L1",
  classes: {},
  l2SampleRate: 0.1,
  humanSampleRate: 0.2,
  allowAllClasses: false,
  directMerge: false,
  ...over,
});

const entry = (over: Partial<ActLedgerEntry> = {}): ActLedgerEntry => ({
  id: "task-1",
  title: "Task",
  status: "completed",
  retryCount: 0,
  failoverCount: 0,
  prUrl: null,
  branchName: null,
  blockReason: null,
  lastFailoverReason: null,
  createdAt: null,
  completedAt: null,
  ...over,
});

describe("effectiveLevel", () => {
  it("falls back to the policy default when a class has no override", () => {
    expect(effectiveLevel(policy({ default: "L0" }), "code")).toBe("L0");
  });

  it("prefers the per-class override", () => {
    expect(effectiveLevel(policy({ classes: { docs: "L2" } }), "docs")).toBe("L2");
  });

  /* ACT's own default when `default` is absent is L1 (autonomy.ts
     `policy.default ?? 'L1'`); the panel must agree or it would show a
     ladder position the engine will not honour. */
  it("reads an absent default as L1, matching the engine", () => {
    expect(effectiveLevel(policy({ default: undefined }), "code")).toBe("L1");
  });
});

describe("l2Caveat", () => {
  it("is silent for a whitelisted class at L2", () => {
    expect(l2Caveat(policy({ classes: { docs: "L2" } }), "docs")).toBeNull();
  });

  it("warns that a non-whitelisted class cannot reach L2", () => {
    expect(l2Caveat(policy({ classes: { code: "L2" } }), "code")).toContain("L1");
  });

  it("stops warning once full-auto is on, since the whitelist no longer applies", () => {
    expect(l2Caveat(policy({ classes: { code: "L2" }, allowAllClasses: true }), "code")).toBeNull();
  });

  it("says nothing about classes that are not set to L2", () => {
    expect(l2Caveat(policy({ classes: { code: "L1" } }), "code")).toBeNull();
  });
});

describe("describeThreshold", () => {
  it("renders a seconds threshold as minutes", () => {
    expect(describeThreshold("stale_agent", 1200)).toBe("20m of silence");
  });

  it("renders a fractional budget threshold as a percentage", () => {
    expect(describeThreshold("cost_overrun", 0.3)).toBe("30% of daily budget");
  });

  it("renders a repeat count as a count", () => {
    expect(describeThreshold("error_loop", 3)).toBe("3 repeats");
  });
});

describe("attemptsOf", () => {
  /* An "attempt" is what a human would count: retries AND runtime failovers,
     which ACT tracks in two separate columns. */
  it("counts the first run plus every retry and failover", () => {
    expect(attemptsOf(entry({ retryCount: 2, failoverCount: 1 }))).toBe(4);
  });

  it("is 1 for a task that ran once", () => {
    expect(attemptsOf(entry())).toBe(1);
  });
});

describe("deliveredPrs", () => {
  it("keeps only entries that actually produced a PR, newest first", () => {
    const rows = deliveredPrs([
      entry({ id: "a", prUrl: "https://example.test/pr/1", completedAt: "2026-08-01T00:00:00Z" }),
      entry({ id: "b", prUrl: null }),
      entry({ id: "c", prUrl: "https://example.test/pr/2", completedAt: "2026-08-02T00:00:00Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["c", "a"]);
  });
});

describe("budgetHeadroom", () => {
  it("reports the used fraction of the daily token allowance", () => {
    expect(
      budgetHeadroom({
        dailyTokensUsed: 250,
        dailyTokensRemaining: 750,
        dailyCostUsed: 1,
        dailyCostRemaining: 3,
        isOverBudget: false,
        lastResetDate: null,
        weeklyTokensUsed: 0,
        weeklyTokensLimit: 0,
        weeklyUsagePercent: 0,
        cacheTokensUsed: null,
      }),
    ).toBe(25);
  });

  it("returns null when there is no allowance to divide by", () => {
    expect(
      budgetHeadroom({
        dailyTokensUsed: 0,
        dailyTokensRemaining: 0,
        dailyCostUsed: 0,
        dailyCostRemaining: 0,
        isOverBudget: false,
        lastResetDate: null,
        weeklyTokensUsed: 0,
        weeklyTokensLimit: 0,
        weeklyUsagePercent: 0,
        cacheTokensUsed: null,
      }),
    ).toBeNull();
  });
});

describe("unreadableSubsystems", () => {
  /* ACT has no server-side notion of an unreadable subsystem (there is no
     such flag anywhere in its source), so the panel derives it: a subsystem
     is unreadable when its own last read failed. Every other subsystem keeps
     rendering — one dead endpoint must never blank the panel. */
  const healthy = Object.fromEntries(
    ACT_SUBSYSTEMS.map((s) => [s.key, { fetchedAt: 1, error: null }]),
  ) as Parameters<typeof unreadableSubsystems>[0];

  it("flags nothing when every subsystem last read cleanly", () => {
    expect(unreadableSubsystems(healthy)).toEqual([]);
  });

  it("flags only the subsystem whose read failed", () => {
    const flags = unreadableSubsystems({
      ...healthy,
      budget: { fetchedAt: 1, error: "ACT returned HTTP 500" },
    });
    expect(flags.map((f) => f.key)).toEqual(["budget"]);
    expect(flags[0]?.reason).toContain("HTTP 500");
  });

  /* Never read yet is not the same as broken: with ACT simply off, the whole
     panel is offline and flagging six subsystems as faulty would be noise. */
  it("does not flag a subsystem that has never been read", () => {
    const flags = unreadableSubsystems({
      ...healthy,
      replays: { fetchedAt: 0, error: null },
    });
    expect(flags).toEqual([]);
  });

  it("still flags a subsystem that has never read AND has an error", () => {
    const flags = unreadableSubsystems({
      ...healthy,
      replays: { fetchedAt: 0, error: "ACT request failed" },
    });
    expect(flags.map((f) => f.key)).toEqual(["replays"]);
  });
});
