import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSnoozeStore } from "../useSnoozeStore";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const STORAGE_KEY = "maestro-snoozes";

describe("useSnoozeStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    useSnoozeStore.setState({ entries: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("snooze records a deadline the requested number of hours out", () => {
    useSnoozeStore.getState().snooze("handoff:a", 3);

    expect(useSnoozeStore.getState().entries).toEqual([
      { key: "handoff:a", untilMs: NOW + 3 * HOUR },
    ]);
  });

  it("re-snoozing the same row replaces its deadline", () => {
    useSnoozeStore.getState().snooze("handoff:a", 1);
    useSnoozeStore.getState().snooze("handoff:a", 8);

    expect(useSnoozeStore.getState().entries).toEqual([
      { key: "handoff:a", untilMs: NOW + 8 * HOUR },
    ]);
  });

  it("unsnooze brings the row back immediately", () => {
    useSnoozeStore.getState().snooze("handoff:a", 3);
    useSnoozeStore.getState().unsnooze("handoff:a");

    expect(useSnoozeStore.getState().entries).toEqual([]);
  });

  it("prune drops deadlines that have passed", () => {
    useSnoozeStore.getState().snooze("handoff:a", 1);
    vi.setSystemTime(NOW + HOUR + 1);

    useSnoozeStore.getState().prune();

    expect(useSnoozeStore.getState().entries).toEqual([]);
  });

  /* Session ids are reassigned every app launch (useSessionStore keeps parked
     ids in memory for the same reason), so a persisted session snooze would
     silence an unrelated future session that reused the number. */
  it("persists durable keys but never a session key", () => {
    useSnoozeStore.getState().snooze("handoff:a", 3);
    useSnoozeStore.getState().snooze("session:7", 3);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    expect(stored).toEqual([{ key: "handoff:a", untilMs: NOW + 3 * HOUR }]);
    // Both are still live in memory for this app session.
    expect(useSnoozeStore.getState().entries).toHaveLength(2);
  });

  it("unsnoozing a durable key removes it from storage too", () => {
    useSnoozeStore.getState().snooze("handoff:a", 3);
    useSnoozeStore.getState().unsnooze("handoff:a");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  it("re-snoozing after an unsnooze persists the new deadline", () => {
    useSnoozeStore.getState().snooze("handoff:a", 1);
    useSnoozeStore.getState().unsnooze("handoff:a");
    useSnoozeStore.getState().snooze("handoff:a", 8);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { key: "handoff:a", untilMs: NOW + 8 * HOUR },
    ]);
  });
});
