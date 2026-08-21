import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listDevProcessesMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listDevProcessesMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/processes", () => ({ listDevProcesses: listDevProcessesMock }));

/* The workspace store persists through the Tauri plugin-store, which has no
   window internals under vitest (same stub as BoardView.test.tsx). */
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import type { DevProcess } from "@/lib/processes";
import { useBandStore } from "@/stores/useBandStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/* Fixtures are fully synthetic: this repo is public, so no real project
   paths appear here. */

function proc(cwd: string | null, isMaestro: boolean, name = "claude"): DevProcess {
  return {
    pid: 1,
    parentPid: null,
    name,
    cmd: "claude",
    cwd,
    memoryBytes: 0,
    cpuPercent: 0,
    runTimeSecs: 0,
    isMaestro,
    matched: "claude",
    ports: [],
  };
}

describe("useBandStore externallyActiveDirs", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    listDevProcessesMock.mockReset();
    useWorkspaceStore.setState({ tabs: [] });
    useBandStore.setState({
      externallyActiveDirs: new Set<string>(),
      processesError: null,
      isRefreshing: false,
    });
  });

  it("collects only cwds of claude processes Maestro did not spawn itself", async () => {
    listDevProcessesMock.mockResolvedValue([
      proc("/tmp/proj-outside", false),
      proc("/tmp/proj-inside", true),
      proc(null, false),
    ]);

    await useBandStore.getState().refresh();

    expect([...useBandStore.getState().externallyActiveDirs]).toEqual(["/tmp/proj-outside"]);
  });

  it("ignores processes that merely mention claude in their command line", async () => {
    /* The Rust matcher also hits on a command-line substring, so an MCP
       helper under node or a shell sourcing a ~/.claude snapshot matches
       the watchlist. Only the claude executable itself is claude work. */
    listDevProcessesMock.mockResolvedValue([
      proc("/tmp/proj-helper", false, "node"),
      proc("/tmp/proj-shell", false, "zsh"),
      proc("/tmp/proj-real", false, "claude"),
    ]);

    await useBandStore.getState().refresh();

    expect([...useBandStore.getState().externallyActiveDirs]).toEqual(["/tmp/proj-real"]);
  });

  it("clears the set when the process scan fails instead of freezing stale liveness", async () => {
    listDevProcessesMock.mockResolvedValue([proc("/tmp/proj-outside", false)]);
    await useBandStore.getState().refresh();
    expect(useBandStore.getState().externallyActiveDirs.size).toBe(1);

    listDevProcessesMock.mockRejectedValue(new Error("scan failed"));
    await useBandStore.getState().refresh();

    expect(useBandStore.getState().externallyActiveDirs.size).toBe(0);
  });

  it("records a scan failure and clears it on the next success", async () => {
    listDevProcessesMock.mockRejectedValue(new Error("scan failed"));
    await useBandStore.getState().refresh();
    expect(useBandStore.getState().processesError).toContain("scan failed");

    listDevProcessesMock.mockResolvedValue([]);
    await useBandStore.getState().refresh();
    expect(useBandStore.getState().processesError).toBeNull();
  });
});
