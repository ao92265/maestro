import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { engineOffline, unreadableSubsystems } from "@/lib/actControl";
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
  act_list_ledger: {
    total: 1,
    entries: [
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
  },
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

  /* The engine REPLACES the autonomy block (its `updatePolicy` spreads
     `updates` shallowly and deep-merges only agent_priority, tool_policies and
     today_overrides). Sending just the changed key erased the default, both
     sample rates and both switches, and persisted that to disk. */
  it("sends the whole merged block, not just the changed key", async () => {
    mockAllHealthy();
    await useActControlStore.getState().refreshAll();
    invokeMock.mockClear();

    await useActControlStore.getState().setAutonomy({ classes: { code: "L0" } });

    const write = invokeMock.mock.calls.find((call) => call[0] === "act_set_autonomy");
    expect(write?.[1]).toEqual({
      autonomy: {
        default: "L1",
        classes: { code: "L0" },
        l2SampleRate: 0.1,
        humanSampleRate: 0.2,
        allowAllClasses: false,
        directMerge: false,
      },
    });
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("act_get_policy");
  });

  it("carries every untouched field through a single-toggle change", async () => {
    mockAllHealthy();
    await useActControlStore.getState().refreshAll();
    invokeMock.mockClear();

    await useActControlStore.getState().setAutonomy({ allowAllClasses: true });

    const write = invokeMock.mock.calls.find((call) => call[0] === "act_set_autonomy");
    const sent = (write?.[1] as { autonomy: Record<string, unknown> }).autonomy;
    expect(sent.allowAllClasses).toBe(true);
    // The rest of the ladder survives the write.
    expect(sent.classes).toEqual({ docs: "L2" });
    expect(sent.l2SampleRate).toBe(0.1);
    expect(sent.humanSampleRate).toBe(0.2);
    expect(sent.default).toBe("L1");
  });

  /* Without a snapshot to merge onto, any block we could assemble would be
     defaults overwriting whatever the engine actually has on disk. */
  it("refuses to write before a policy has ever been read", async () => {
    invokeMock.mockResolvedValue(1);

    await useActControlStore.getState().setAutonomy({ default: "L2" });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useActControlStore.getState().reads.policy.error).toContain("No policy read yet");
  });

  /* A rejected write must surface on the policy subsystem, not as a silent
     no-op that leaves the toggle looking applied. */
  it("records a rejected write against the policy subsystem", async () => {
    mockAllHealthy();
    await useActControlStore.getState().refreshAll();
    invokeMock.mockRejectedValue(new Error("writes are disabled"));

    await useActControlStore.getState().setAutonomy({ default: "L2" });

    expect(useActControlStore.getState().reads.policy.error).toContain("writes are disabled");
  });
});

describe("useActControlStore with the engine off", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useActControlStore.setState(useActControlStore.getInitialState(), true);
  });

  /* Cold start against a stopped ACT. The earlier version of this test
     asserted the pre-first-poll state, which is all zeros and no errors, so it
     never covered the case it was named for: the panel rendered six raw
     connection-refused lines the first time it opened without the engine. */
  it("reads as offline, not as six faults, after a failed first poll", async () => {
    invokeMock.mockRejectedValue(new Error("error sending request for url (127.0.0.1:3847)"));

    await useActControlStore.getState().refreshAll();

    const { reads } = useActControlStore.getState();
    expect(engineOffline(reads)).toBe(true);
    expect(unreadableSubsystems(reads)).toEqual([]);
  });

  it("switches from offline to per-subsystem faults once ACT comes back partly", async () => {
    invokeMock.mockRejectedValue(new Error("connection refused"));
    await useActControlStore.getState().refreshAll();
    expect(engineOffline(useActControlStore.getState().reads)).toBe(true);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "act_list_replays") throw new Error("ACT returned HTTP 404");
      return PAYLOADS[cmd] ?? [];
    });
    await useActControlStore.getState().refreshAll();

    const { reads } = useActControlStore.getState();
    expect(engineOffline(reads)).toBe(false);
    expect(unreadableSubsystems(reads).map((f) => f.key)).toEqual(["replays"]);
  });
});
