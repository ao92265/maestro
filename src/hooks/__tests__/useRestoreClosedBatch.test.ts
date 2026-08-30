import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import type { ClosedBatch, ClosedSessionRecord } from "@/lib/sessionActions";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { buildRestoreLaunches } from "../useRestoreClosedBatch";

function record(overrides: Partial<ClosedSessionRecord> = {}): ClosedSessionRecord {
  return {
    id: 1,
    name: null,
    mode: "Claude",
    projectPath: "/repo",
    workingDirectory: "/repo",
    branch: null,
    ...overrides,
  };
}

function batch(sessions: ClosedSessionRecord[]): ClosedBatch {
  return {
    id: "closed-1",
    closedAtMs: 0,
    projectPath: "/repo",
    projectName: "repo",
    sessions,
  };
}

describe("buildRestoreLaunches", () => {
  it("carries each session's directory, branch, mode and name", () => {
    const launches = buildRestoreLaunches(
      batch([
        record({ id: 1, name: "api", branch: "feat/x", workingDirectory: "/wt/x", mode: "Claude" }),
      ]),
      "tab-1",
    );

    expect(launches).toEqual([
      {
        tabId: "tab-1",
        mode: "Claude",
        resumeSessionId: null,
        workingDirOverride: "/wt/x",
        branch: "feat/x",
        customName: "api",
      },
    ]);
  });

  it("never resumes the dead conversation — the PTY went with the tab", () => {
    const launches = buildRestoreLaunches(batch([record(), record({ id: 2 })]), "tab-1");

    expect(launches.every((l) => l.resumeSessionId === null)).toBe(true);
  });

  /**
   * `usePendingLaunchStore.request` drops a launch identical to one already
   * queued (its double-click guard). Two unnamed sessions in the same
   * directory on the same branch are identical, so without distinct names a
   * three-session batch would restore as one.
   */
  it("keeps unnamed sessions distinct so the queue cannot collapse them", () => {
    usePendingLaunchStore.setState({ pending: [] });

    const launches = buildRestoreLaunches(
      batch([record({ id: 1 }), record({ id: 2 }), record({ id: 3 })]),
      "tab-1",
    );
    for (const launch of launches) usePendingLaunchStore.getState().request(launch);

    expect(new Set(launches.map((l) => l.customName)).size).toBe(3);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(3);
  });

  it("keeps a recorded name rather than renumbering it", () => {
    const launches = buildRestoreLaunches(
      batch([record({ id: 1, name: "api" }), record({ id: 2 })]),
      "tab-1",
    );

    expect(launches.map((l) => l.customName)).toEqual(["api", "repo 2"]);
  });
});
