import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// The persisted stores hydrate through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

import { usePlanStore, type DailyPlan } from "../usePlanStore";
import { localDateString, useStandupStore } from "../useStandupStore";

const invokeMock = vi.mocked(invoke);

const PROJECTS = ["C:/git/proj", "C:/git/other"];

function plan(date = "2026-07-30"): DailyPlan {
  return { date, markdown: "# Plan", generated_at: `${date}T08:30:00Z` };
}

describe("usePlanStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "generate_daily_plan") return plan();
      return null;
    });
    usePlanStore.setState({
      status: "idle",
      plan: null,
      error: null,
      concerns: "",
      lastRunDate: null,
      runInProgress: false,
    });
    // The plan rides the standup's schedule — there is only one setting.
    useStandupStore.setState({ scheduleEnabled: true, scheduleTime: "08:30" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 30, 9, 0, 0)); // 09:00 local, past 08:30
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generate sends every open project and the concerns text", async () => {
    usePlanStore.getState().setConcerns("finish the AI panel");
    await usePlanStore.getState().generate(PROJECTS);
    expect(invokeMock).toHaveBeenCalledWith("generate_daily_plan", {
      projectPaths: PROJECTS,
      concerns: "finish the AI panel",
    });
    const state = usePlanStore.getState();
    expect(state.status).toBe("ready");
    expect(state.plan?.markdown).toBe("# Plan");
  });

  it("generate records the error on failure", async () => {
    invokeMock.mockRejectedValueOnce("Claude CLI not found on PATH");
    await usePlanStore.getState().generate(PROJECTS);
    const state = usePlanStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("Claude CLI not found");
  });

  it("concerns are part of the persisted slice", async () => {
    // Retention of the user's own input across restarts: the box must survive
    // in the persisted partition, together with the run bookkeeping.
    const partialize = usePlanStore.persist.getOptions().partialize;
    usePlanStore.setState({ concerns: "watch the release", lastRunDate: "2026-07-29" });
    const persisted = partialize?.(usePlanStore.getState()) as Record<string, unknown>;
    expect(persisted.concerns).toBe("watch the release");
    expect(persisted.lastRunDate).toBe("2026-07-29");
    // Transient run state must NOT be persisted.
    expect(persisted).not.toHaveProperty("runInProgress");
    expect(persisted).not.toHaveProperty("plan");
  });

  it("loadLatest adopts the newest saved plan from disk (retention)", async () => {
    // Backend serves the newest plan when no date is given — e.g. yesterday's,
    // when today's has not been generated yet.
    invokeMock.mockResolvedValueOnce(plan("2026-07-29"));
    await usePlanStore.getState().loadLatest();
    expect(invokeMock).toHaveBeenCalledWith("load_daily_plan", { date: null });
    const state = usePlanStore.getState();
    expect(state.status).toBe("ready");
    expect(state.plan?.date).toBe("2026-07-29");
  });

  it("scheduled run fires once after the configured time and not again that day", async () => {
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(usePlanStore.getState().lastRunDate).toBe(localDateString(new Date()));
    expect(invokeMock).toHaveBeenCalledWith("generate_daily_plan", {
      projectPaths: PROJECTS,
      concerns: "",
    });

    invokeMock.mockClear();
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("scheduled run skips generation when that day's plan already exists", async () => {
    // Catch-up on startup must never regenerate over an existing plan — e.g.
    // one generated manually, or by a previous app run that day.
    const today = localDateString(new Date());
    const existing = plan(today);
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "load_daily_plan") return existing;
      return plan();
    });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).toHaveBeenCalledWith("load_daily_plan", { date: today });
    expect(invokeMock).not.toHaveBeenCalledWith("generate_daily_plan", expect.anything());
    const state = usePlanStore.getState();
    expect(state.status).toBe("ready");
    expect(state.plan).toEqual(existing);
    expect(state.lastRunDate).toBe(today);
  });

  it("scheduled run does not generate when the existence check fails", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "load_daily_plan") throw new Error("disk error");
      return plan();
    });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).not.toHaveBeenCalledWith("generate_daily_plan", expect.anything());
    const state = usePlanStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("disk error");
    // The day stays open so the next tick retries it.
    expect(state.lastRunDate).toBeNull();
    expect(state.runInProgress).toBe(false);
  });

  it("a failed generation leaves the day open for the next tick", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "load_daily_plan") return null;
      throw new Error("claude blew up");
    });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(usePlanStore.getState().status).toBe("error");
    expect(usePlanStore.getState().lastRunDate).toBeNull();
  });

  it("scheduled run fires again after midnight when lastRunDate is yesterday", async () => {
    usePlanStore.setState({ lastRunDate: "2026-07-29" });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).toHaveBeenCalledWith("generate_daily_plan", {
      projectPaths: PROJECTS,
      concerns: "",
    });
    expect(usePlanStore.getState().lastRunDate).toBe("2026-07-30");
  });

  it("scheduled run does not fire before the shared schedule time", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 8, 0, 0)); // 08:00 < 08:30
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(usePlanStore.getState().lastRunDate).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("scheduled run follows the standup schedule setting", async () => {
    // Proof the two share one setting: turning the report schedule off, or
    // moving its time, changes when the plan runs.
    useStandupStore.setState({ scheduleEnabled: false });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).not.toHaveBeenCalled();

    useStandupStore.setState({ scheduleEnabled: true, scheduleTime: "23:00" });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).not.toHaveBeenCalled();

    useStandupStore.setState({ scheduleTime: "07:00" });
    await usePlanStore.getState().maybeRunScheduled(PROJECTS);
    expect(invokeMock).toHaveBeenCalledWith("generate_daily_plan", expect.anything());
  });

  it("scheduled run does nothing with no open projects", async () => {
    await usePlanStore.getState().maybeRunScheduled([]);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(usePlanStore.getState().lastRunDate).toBeNull();
  });
});
