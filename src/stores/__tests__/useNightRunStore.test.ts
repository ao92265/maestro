import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NightRunView } from "@/lib/nightRun";
import { useNightRunStore } from "../useNightRunStore";

const invokeMock = vi.mocked(invoke);

const VIEW: NightRunView = {
  settings: {
    intervalMinutes: 5,
    label: "night-run",
    maxAgents: 2,
    autonomy: "L1",
    windowEnabled: true,
    startMinute: 23 * 60,
    stopMinute: 6 * 60,
  },
  loop: {
    isRunning: true,
    activeAgents: 1,
    pendingTasks: 4,
    inProgressTasks: 1,
    completedToday: 2,
    blockedTasks: 0,
    lastCheck: "2026-08-28T23:30:00.000Z",
    nextCheck: "2026-08-28T23:35:00.000Z",
  },
  loopError: null,
  fetchedAt: 1_756_000_000_000,
  inWindow: true,
  nextStartAt: "2026-08-29T23:00:00+01:00",
  nextStopAt: "2026-08-29T06:00:00+01:00",
  scheduleOwnsLoop: true,
  outcomes: [
    {
      at: "2026-08-28T23:00:04+01:00",
      action: "start",
      scheduled: true,
      ok: true,
      detail: "Loop started with a 5m interval, 2 agents.",
    },
  ],
};

describe("useNightRunStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNightRunStore.setState(useNightRunStore.getInitialState(), true);
  });

  it("reads the view and clears any earlier error", async () => {
    invokeMock.mockResolvedValue(VIEW);

    await useNightRunStore.getState().refresh();

    const state = useNightRunStore.getState();
    expect(state.view?.settings.label).toBe("night-run");
    expect(state.view?.outcomes).toHaveLength(1);
    expect(state.error).toBeNull();
  });

  /* Unreachable ACT is a normal state: the schedule and its last outcome are
     local facts and must stay on screen behind a stale badge. */
  it("keeps the last known view when a later read fails", async () => {
    invokeMock.mockResolvedValue(VIEW);
    await useNightRunStore.getState().refresh();

    invokeMock.mockRejectedValue(new Error("ACT unreachable"));
    await useNightRunStore.getState().refresh();

    const state = useNightRunStore.getState();
    expect(state.view?.settings.label).toBe("night-run");
    expect(state.error).toContain("ACT unreachable");
  });

  it("edits a draft locally without touching the engine", () => {
    useNightRunStore.setState({ view: VIEW });

    useNightRunStore.getState().setDraft({ maxAgents: 4 });

    expect(useNightRunStore.getState().draft?.maxAgents).toBe(4);
    // The unedited keys still come from the server's own settings.
    expect(useNightRunStore.getState().draft?.label).toBe("night-run");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  /* Starting has to send what is on screen. Sending the server's copy would
     silently run the night at the previous settings. */
  it("starts with the edited settings, then re-reads", async () => {
    invokeMock.mockResolvedValue(VIEW);
    await useNightRunStore.getState().refresh();
    useNightRunStore.getState().setDraft({ maxAgents: 4 });
    invokeMock.mockClear();

    await useNightRunStore.getState().start();

    const start = invokeMock.mock.calls.find((call) => call[0] === "night_run_start");
    expect((start?.[1] as { settings: { maxAgents: number } }).settings.maxAgents).toBe(4);
    expect(invokeMock.mock.calls.map((call) => call[0])).toContain("night_run_status");
  });

  it("stops through the engine and re-reads", async () => {
    invokeMock.mockResolvedValue(VIEW);

    await useNightRunStore.getState().stop();

    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "night_run_stop",
      "night_run_status",
    ]);
  });

  it("saves the draft and then follows the engine's copy again", async () => {
    invokeMock.mockResolvedValue(VIEW);
    await useNightRunStore.getState().refresh();
    useNightRunStore.getState().setDraft({ windowEnabled: false });
    invokeMock.mockClear();

    await useNightRunStore.getState().save();

    const save = invokeMock.mock.calls.find((call) => call[0] === "night_run_save_settings");
    expect((save?.[1] as { settings: { windowEnabled: boolean } }).settings.windowEnabled).toBe(
      false,
    );
    expect(useNightRunStore.getState().draft).toBeNull();
  });

  it("surfaces a rejected write instead of leaving the button looking applied", async () => {
    invokeMock.mockRejectedValue(new Error("ACT returned HTTP 500"));

    await useNightRunStore.getState().start();

    expect(useNightRunStore.getState().error).toContain("HTTP 500");
  });
});
