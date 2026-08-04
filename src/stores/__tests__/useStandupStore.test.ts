import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// The persisted store hydrates through the Tauri store plugin at import time;
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

import { localDateString, useStandupStore, type StandupReport } from "../useStandupStore";

const invokeMock = vi.mocked(invoke);

function report(projectPath: string): StandupReport {
  return {
    project_path: projectPath,
    date: "2026-07-30",
    markdown: "# Standup",
    generated_at: "2026-07-30T08:30:00Z",
  };
}

describe("useStandupStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "generate_standup_report") {
        return report((args as { projectPath: string }).projectPath);
      }
      return null;
    });
    useStandupStore.setState({
      reports: {},
      scheduleEnabled: true,
      scheduleTime: "08:30",
      lastRunDate: null,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 30, 9, 0, 0)); // 09:00 local, past 08:30
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generate stores the report on success", async () => {
    await useStandupStore.getState().generate("C:/git/proj");
    const state = useStandupStore.getState().reports["C:/git/proj"];
    expect(state.status).toBe("ready");
    expect(state.report?.markdown).toBe("# Standup");
  });

  it("generate records the error on failure", async () => {
    invokeMock.mockRejectedValueOnce("Claude CLI not found on PATH");
    await useStandupStore.getState().generate("C:/git/proj");
    const state = useStandupStore.getState().reports["C:/git/proj"];
    expect(state.status).toBe("error");
    expect(state.error).toContain("Claude CLI not found");
  });

  it("loadLatest adopts the newest saved report from disk (retention)", async () => {
    // Backend serves the newest report when no date is given — e.g.
    // yesterday's, when today's has not been generated yet.
    invokeMock.mockResolvedValueOnce({ ...report("C:/git/proj"), date: "2026-07-29" });
    await useStandupStore.getState().loadLatest("C:/git/proj");
    expect(invokeMock).toHaveBeenCalledWith("load_standup_report", {
      projectPath: "C:/git/proj",
      date: null,
    });
    const state = useStandupStore.getState().reports["C:/git/proj"];
    expect(state.status).toBe("ready");
    expect(state.report?.date).toBe("2026-07-29");
  });

  it("scheduled run fires once after the configured time and not again that day", async () => {
    const store = useStandupStore.getState();
    await store.maybeRunScheduled(["C:/git/proj"]);
    expect(useStandupStore.getState().lastRunDate).toBe(localDateString(new Date()));
    expect(invokeMock).toHaveBeenCalledWith("generate_standup_report", {
      projectPath: "C:/git/proj",
      promptTemplate: null,
    });

    invokeMock.mockClear();
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("scheduled run skips generation when that day's report already exists", async () => {
    // Catch-up on startup must never regenerate over an existing report —
    // e.g. one generated manually, or by a previous app run that day.
    const today = localDateString(new Date());
    const existing = { ...report("C:/git/proj"), date: today };
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "load_standup_report") return existing;
      return report("C:/git/proj");
    });
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).toHaveBeenCalledWith("load_standup_report", {
      projectPath: "C:/git/proj",
      date: today,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("generate_standup_report", expect.anything());
    const state = useStandupStore.getState().reports["C:/git/proj"];
    expect(state.status).toBe("ready");
    expect(state.report).toEqual(existing);
  });

  it("scheduled run does not generate when the existence check fails", async () => {
    // If we can't tell whether the report exists, don't risk overwriting it.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "load_standup_report") throw new Error("disk error");
      return report("C:/git/proj");
    });
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).not.toHaveBeenCalledWith("generate_standup_report", expect.anything());
  });

  it("scheduled run does not fire before the configured time", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 8, 0, 0)); // 08:00 < 08:30
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(useStandupStore.getState().lastRunDate).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("scheduled run does not fire when disabled", async () => {
    useStandupStore.setState({ scheduleEnabled: false });
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
