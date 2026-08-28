import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { unreadableSubsystems } from "@/lib/actControl";
import { useActControlStore } from "../useActControlStore";

const invokeMock = vi.mocked(invoke);

/** Minimal well-formed payload per relay command. */
const PAYLOADS: Record<string, unknown> = {
  act_get_policy: {
    autonomy: {
      default: "L1",
      classes: { docs: "L2" },
      l2SampleRate: 0.1,
      humanSampleRate: 0.2,
      allowAllClasses: false,
      directMerge: false,
    },
    writesEnabled: true,
  },
  act_list_intervention_rules: [
    { type: "stale_agent", threshold: 1200, action: "restart", enabled: true },
  ],
  act_list_intervention_events: [
    {
      ruleType: "cost_overrun",
      agentId: "agent-1",
      action: "stop",
      reason: "30% of daily budget",
      timestamp: "2026-08-28T09:00:00.000Z",
    },
  ],
  act_get_budget: {
    dailyTokensUsed: 100,
    dailyTokensRemaining: 900,
    dailyCostUsed: 1,
    dailyCostRemaining: 9,
    isOverBudget: false,
    lastResetDate: "2026-08-28",
    weeklyTokensUsed: 500,
    weeklyTokensLimit: 5000,
    weeklyUsagePercent: 10,
    cacheTokensUsed: 20,
  },
  act_list_ledger: [
    {
      id: "task-1",
      title: "Ship the panel",
      status: "completed",
      retryCount: 1,
      failoverCount: 0,
      prUrl: "https://example.test/pr/1",
      branchName: "feat/panel",
      blockReason: null,
      lastFailoverReason: null,
      createdAt: "2026-08-28T08:00:00.000Z",
      completedAt: "2026-08-28T09:00:00.000Z",
    },
  ],
  act_list_replays: [
    {
      sessionId: "s-1",
      agentId: "agent-1",
      taskId: "task-1",
      runtime: "claude",
      startedAt: "2026-08-28T08:00:00.000Z",
      eventCount: 12,
    },
  ],
};

function mockAllHealthy() {
  invokeMock.mockImplementation(async (cmd: string) => PAYLOADS[cmd] ?? []);
}

describe("useActControlStore.refreshAll", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useActControlStore.setState(useActControlStore.getInitialState(), true);
  });

  it("loads every subsystem in one pass", async () => {
    mockAllHealthy();

    await useActControlStore.getState().refreshAll();

    const state = useActControlStore.getState();
    expect(state.policy?.autonomy.classes.docs).toBe("L2");
    expect(state.rules).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.budget?.dailyTokensUsed).toBe(100);
    expect(state.ledger).toHaveLength(1);
    expect(state.replays).toHaveLength(1);
    expect(unreadableSubsystems(state.reads)).toEqual([]);
  });

  /* The whole point of the per-subsystem split: ACT can serve five of six
     endpoints (an older build, a route that throws) and the panel must show
     the five rather than collapse to an error screen. */
  it("keeps the healthy subsystems when one endpoint fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "act_get_budget") throw new Error("ACT returned HTTP 500");
      return PAYLOADS[cmd] ?? [];
    });

    await useActControlStore.getState().refreshAll();

    const state = useActControlStore.getState();
    expect(state.budget).toBeNull();
    expect(state.reads.budget.error).toContain("HTTP 500");
    expect(state.policy).not.toBeNull();
    expect(state.ledger).toHaveLength(1);
    expect(state.reads.ledger.error).toBeNull();
    expect(unreadableSubsystems(state.reads).map((f) => f.key)).toEqual(["budget"]);
  });

  /* Stale-not-empty, the rohcna ACT-client contract: a poll that fails after
     a good one keeps the last known rows behind a stale badge. */
  it("keeps the last good data when a later poll fails", async () => {
    mockAllHealthy();
    await useActControlStore.getState().refreshAll();

    invokeMock.mockImplementation(async () => {
      throw new Error("ACT unreachable");
    });
    await useActControlStore.getState().refreshAll();

    const state = useActControlStore.getState();
    expect(state.ledger).toHaveLength(1);
    expect(state.budget?.dailyTokensUsed).toBe(100);
    expect(unreadableSubsystems(state.reads)).toHaveLength(6);
  });

  it("clears a subsystem error once it reads cleanly again", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "act_get_budget") throw new Error("ACT returned HTTP 500");
      return PAYLOADS[cmd] ?? [];
    });
    await useActControlStore.getState().refreshAll();
    expect(useActControlStore.getState().reads.budget.error).not.toBeNull();

    mockAllHealthy();
    await useActControlStore.getState().refreshAll();

    expect(useActControlStore.getState().reads.budget.error).toBeNull();
    expect(useActControlStore.getState().budget?.dailyTokensUsed).toBe(100);
  });
});

describe("useActControlStore.setAutonomy", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useActControlStore.setState(useActControlStore.getInitialState(), true);
  });

  it("sends only the autonomy patch and re-reads the policy afterwards", async () => {
    mockAllHealthy();
    await useActControlStore.getState().refreshAll();
    invokeMock.mockClear();

    await useActControlStore.getState().setAutonomy({ classes: { code: "L0" } });

    const write = invokeMock.mock.calls.find((call) => call[0] === "act_set_autonomy");
    expect(write?.[1]).toEqual({ autonomy: { classes: { code: "L0" } } });
    // The engine, not the panel, decides what the merged policy becomes.
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("act_get_policy");
  });

  /* A rejected write must surface on the policy subsystem, not as a silent
     no-op that leaves the toggle looking applied. */
  it("records a rejected write against the policy subsystem", async () => {
    invokeMock.mockRejectedValue(new Error("writes are disabled"));

    await useActControlStore.getState().setAutonomy({ default: "L2" });

    expect(useActControlStore.getState().reads.policy.error).toContain("writes are disabled");
  });
});
