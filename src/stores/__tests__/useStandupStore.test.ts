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

  it("scheduled run fires once after the configured time and not again that day", () => {
    const store = useStandupStore.getState();
    store.maybeRunScheduled(["C:/git/proj"]);
    expect(useStandupStore.getState().lastRunDate).toBe(localDateString(new Date()));
    expect(invokeMock).toHaveBeenCalledWith("generate_standup_report", {
      projectPath: "C:/git/proj",
    });

    invokeMock.mockClear();
    useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("scheduled run does not fire before the configured time", () => {
    vi.setSystemTime(new Date(2026, 6, 30, 8, 0, 0)); // 08:00 < 08:30
    useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(useStandupStore.getState().lastRunDate).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("scheduled run does not fire when disabled", () => {
    useStandupStore.setState({ scheduleEnabled: false });
    useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
