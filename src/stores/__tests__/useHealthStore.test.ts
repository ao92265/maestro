import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { HEALTH_THRESHOLDS } from "../../lib/healthRules";
import type { DevProcess } from "../../lib/processes";
import { useGitHubWatchdogStore } from "../useGitHubWatchdogStore";
import { countForArea, reasonsByRow, useHealthStore } from "../useHealthStore";

const invokeMock = vi.mocked(invoke);

/** `C:\git\app` encoded the way Claude Code names its project directories. */
const APP_DIR = "C--git-app";
const APP_PATH = "C:\\git\\app";

function proc(overrides: Partial<DevProcess> = {}): DevProcess {
  return {
    pid: 100,
    parentPid: 1,
    name: "node",
    cmd: "node vite",
    cwd: APP_PATH,
    memoryBytes: 1024,
    cpuPercent: 1,
    runTimeSecs: 10,
    isMaestro: false,
    matched: "vite",
    ports: [],
    ...overrides,
  };
}

/**
 * Wires the four commands one check makes. `memoryFiles` is keyed by memory
 * dir; `bodies` by memory file rel path; `missing` is what the path probe
 * reports as absent.
 */
function mockBackend({
  memoryProjects = [] as Array<{ dirName: string }>,
  memoryFiles = {} as Record<string, unknown[]>,
  bodies = {} as Record<string, string>,
  missing = [] as string[],
  processes = [] as DevProcess[],
  fail = null as null | string,
} = {}) {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === fail) throw new Error(`${cmd} exploded`);
    switch (cmd) {
      case "list_memory_projects":
        return memoryProjects.map((p) => ({
          dirName: p.dirName,
          memoryPath: `/m/${p.dirName}`,
          fileCount: (memoryFiles[p.dirName] ?? []).length,
          isActive: false,
        }));
      case "list_memory_files":
        return memoryFiles[args?.dirName as string] ?? [];
      case "read_memory_file":
        return bodies[args?.relPath as string] ?? "";
      case "check_paths_exist":
        return missing;
      case "list_dev_processes":
        return processes;
      default:
        return undefined;
    }
  });
}

function memFile(relPath: string, overrides: Record<string, unknown> = {}) {
  return {
    relPath,
    path: `/m/${relPath}`,
    description: null,
    memType: null,
    isIndex: relPath === "MEMORY.md",
    sizeBytes: 100,
    modified: new Date().toISOString(),
    ...overrides,
  };
}

/** A project whose fact count is one over the threshold. */
function sprawlingProject() {
  return {
    memoryProjects: [{ dirName: APP_DIR }],
    memoryFiles: {
      [APP_DIR]: Array.from({ length: HEALTH_THRESHOLDS.maxFactFiles + 1 }, (_, i) =>
        memFile(`f${i}.md`),
      ),
    },
  };
}

const OPEN = [{ projectPath: APP_PATH }];

describe("useHealthStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useHealthStore.setState({
      flags: [],
      streaks: {},
      baselineKeys: { memory: null, processes: null },
      toasts: [],
      lastCheckedAt: null,
      isChecking: false,
    });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
  });

  it("raises flags but no toasts on the first check", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck(OPEN);

    const { flags, toasts, lastCheckedAt } = useHealthStore.getState();
    expect(countForArea(flags, "memory")).toBe(1);
    expect(toasts).toEqual([]);
    expect(lastCheckedAt).not.toBeNull();
  });

  it("toasts only flags that are new since the previous check", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck(OPEN);

    // Second check: same sprawl, plus a long-running process.
    mockBackend({
      ...sprawlingProject(),
      processes: [proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 60 })],
    });
    await useHealthStore.getState().runCheck(OPEN);

    const { toasts } = useHealthStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].area).toBe("processes");
    expect(toasts[0].reason).toBe("running 24h");

    // Third check with unchanged data: no repeat toast.
    await useHealthStore.getState().runCheck(OPEN);
    expect(useHealthStore.getState().toasts).toHaveLength(1);
  });

  it("keeps badges but queues no toasts while notifications are off", async () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });
    mockBackend({ processes: [] });
    await useHealthStore.getState().runCheck(OPEN);

    mockBackend({ processes: [proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 60 })] });
    await useHealthStore.getState().runCheck(OPEN);

    const { flags, toasts } = useHealthStore.getState();
    expect(countForArea(flags, "processes")).toBe(1);
    expect(toasts).toEqual([]);
  });

  it("keeps the last-known flags of an area whose check failed", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck(OPEN);
    expect(countForArea(useHealthStore.getState().flags, "memory")).toBe(1);

    mockBackend({ ...sprawlingProject(), fail: "list_memory_projects" });
    await useHealthStore.getState().runCheck(OPEN);

    // Badge survives the blip, and recovery does not re-toast the same flag.
    expect(countForArea(useHealthStore.getState().flags, "memory")).toBe(1);
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck(OPEN);
    expect(useHealthStore.getState().toasts).toEqual([]);
  });

  it("checks path references only for projects open in Maestro", async () => {
    mockBackend({
      memoryProjects: [{ dirName: APP_DIR }, { dirName: "C--git-other" }],
      memoryFiles: { [APP_DIR]: [memFile("a.md")], "C--git-other": [memFile("b.md")] },
      bodies: { "a.md": "see `src/gone.ts`", "b.md": "see `src/also.ts`" },
      missing: ["src/gone.ts"],
    });
    await useHealthStore.getState().runCheck(OPEN);

    const { flags } = useHealthStore.getState();
    expect(flags).toHaveLength(1);
    expect(flags[0].scope).toBe(APP_DIR);
    expect(flags[0].reason).toBe("references missing src/gone.ts");

    // The unopened project's files are never read — its repo root is unknown.
    const readPaths = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "read_memory_file")
      .map(([, args]) => (args as { relPath: string }).relPath);
    expect(readPaths).toEqual(["a.md"]);
  });

  it("exposes reasons keyed by scope and target for inline highlighting", async () => {
    mockBackend({
      ...sprawlingProject(),
      processes: [proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 60 })],
    });
    await useHealthStore.getState().runCheck(OPEN);

    const { flags } = useHealthStore.getState();
    expect(reasonsByRow(flags, "memory").get(`${APP_DIR}|${APP_DIR}`)).toEqual([
      `${HEALTH_THRESHOLDS.maxFactFiles + 1} facts`,
    ]);
    expect(reasonsByRow(flags, "processes").get("100:node|vite")).toEqual(["running 24h"]);
  });

  it("ignores a re-entrant check while one is in flight", async () => {
    mockBackend(sprawlingProject());
    const first = useHealthStore.getState().runCheck(OPEN);
    await useHealthStore.getState().runCheck(OPEN);
    await first;
    const projectListCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "list_memory_projects",
    );
    expect(projectListCalls).toHaveLength(1);
  });
});
