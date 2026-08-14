import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { localDateString, type StandupReport, useStandupStore } from "../useStandupStore";

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
      runInProgress: false,
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
    // If we can't tell whether the report exists, don't risk overwriting it:
    // surface the failure in the panel and leave the day open for a retry.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "load_standup_report") throw new Error("disk error");
      return report("C:/git/proj");
    });
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).not.toHaveBeenCalledWith("generate_standup_report", expect.anything());
    const state = useStandupStore.getState().reports["C:/git/proj"];
    expect(state.status).toBe("error");
    expect(state.error).toContain("disk error");
    expect(useStandupStore.getState().lastRunDate).toBeNull();
    expect(useStandupStore.getState().runInProgress).toBe(false);
  });

  it("scheduled run fires again after midnight when lastRunDate is yesterday", async () => {
    useStandupStore.setState({ lastRunDate: "2026-07-29" });
    await useStandupStore.getState().maybeRunScheduled(["C:/git/proj"]);
    expect(invokeMock).toHaveBeenCalledWith("generate_standup_report", {
      projectPath: "C:/git/proj",
      promptTemplate: null,
    });
    expect(useStandupStore.getState().lastRunDate).toBe("2026-07-30");
  });

  it("one project's failed existence check does not block the others", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      const { projectPath } = args as { projectPath: string };
      if (cmd === "load_standup_report") {
        if (projectPath === "C:/git/bad") throw new Error("disk error");
        return null;
      }
      return report(projectPath);
    });
    await useStandupStore.getState().maybeRunScheduled(["C:/git/bad", "C:/git/good"]);
    expect(invokeMock).toHaveBeenCalledWith("generate_standup_report", {
      projectPath: "C:/git/good",
      promptTemplate: null,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "generate_standup_report",
      expect.objectContaining({ projectPath: "C:/git/bad" }),
    );
    expect(useStandupStore.getState().reports["C:/git/bad"].status).toBe("error");
    expect(useStandupStore.getState().reports["C:/git/good"].status).toBe("ready");
    // The failed project leaves the day open so the next tick retries it;
    // the generated one is protected from a rerun by its on-disk report.
    expect(useStandupStore.getState().lastRunDate).toBeNull();
  });

  it("loadLatest does not clobber a slot taken while it was reading", async () => {
    let resolveLoad!: (r: StandupReport | null) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<StandupReport | null>((res) => {
          resolveLoad = res;
        }),
    );
    const pending = useStandupStore.getState().loadLatest("C:/git/proj");
    // A generation fails and takes the slot while the disk read is in flight.
    useStandupStore.setState({
      reports: { "C:/git/proj": { status: "error", report: null, error: "boom" } },
    });
    resolveLoad({ ...report("C:/git/proj"), date: "2026-07-29" });
    await pending;
    // The stale read must not mask the error with yesterday's report.
    const state = useStandupStore.getState().reports["C:/git/proj"];
    expect(state.status).toBe("error");
    expect(state.error).toBe("boom");
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
