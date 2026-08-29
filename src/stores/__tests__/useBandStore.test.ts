import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listDevProcessesMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listDevProcessesMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
/* Partial mock: the real isClaudeSession predicate is under test here, only
   the Tauri-backed scan call is stubbed. */
vi.mock("@/lib/processes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/processes")>()),
  listDevProcesses: listDevProcessesMock,
}));

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

import type { HandoffInfo } from "@/lib/bands";
import type { DevProcess } from "@/lib/processes";
import { useBandStore } from "@/stores/useBandStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/* Fixtures are fully synthetic: this repo is public, so no real project
   paths appear here. */

function proc(
  cwd: string | null,
  isMaestro: boolean,
  name = "claude",
  cmd = "claude --resume",
): DevProcess {
  return {
    pid: 1,
    parentPid: null,
    name,
    cmd,
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
       helper under node, npm running one, or a shell sourcing a ~/.claude
       snapshot all come back matched. Only the claude CLI itself, invoked
       as claude, is claude work. */
    listDevProcessesMock.mockResolvedValue([
      proc("/tmp/proj-helper", false, "node", "node /x/node_modules/.bin/claude-historian-mcp"),
      proc("/tmp/proj-npm", false, "npm", "npm exec claude-historian-mcp"),
      proc("/tmp/proj-shell", false, "zsh", "/bin/zsh -c source /x/.claude/snap.sh && claude"),
      proc("/tmp/proj-real", false, "claude"),
    ]);

    await useBandStore.getState().refresh();

    expect([...useBandStore.getState().externallyActiveDirs]).toEqual(["/tmp/proj-real"]);
  });

  it("recognises the claude CLI when its process name is the version-directory basename", async () => {
    /* Observed live: the CLI's executable image is
       ~/.local/share/claude/versions/<x.y.z>, so the OS-reported process
       name is a bare version number; argv[0] is what says claude. Covers
       both a PATH launch and a launchd job's full-path launch. */
    listDevProcessesMock.mockResolvedValue([
      proc("/tmp/proj-path", false, "2.1.228", "claude --resume"),
      proc("/tmp/proj-daemon", false, "2.1.228", "/x/.local/bin/claude -p tick"),
    ]);

    await useBandStore.getState().refresh();

    expect([...useBandStore.getState().externallyActiveDirs].sort()).toEqual([
      "/tmp/proj-daemon",
      "/tmp/proj-path",
    ]);
  });

  it("recognises Windows and node-shim launches of the CLI", async () => {
    /* Windows cmd lines are backslashed and keep .exe; an npm-installed CLI
       execs through env node with the claude script as argv[1]. */
    listDevProcessesMock.mockResolvedValue([
      proc(
        "/tmp/proj-win",
        false,
        "claude",
        "C:\\Users\\x\\AppData\\Local\\Programs\\claude\\claude.exe --resume",
      ),
      proc("/tmp/proj-shim", false, "node", "/usr/bin/node /x/.nvm/bin/claude --resume"),
    ]);

    await useBandStore.getState().refresh();

    expect([...useBandStore.getState().externallyActiveDirs].sort()).toEqual([
      "/tmp/proj-shim",
      "/tmp/proj-win",
    ]);
  });

  it("ignores claude mcp serve, plumbing is not a session", async () => {
    listDevProcessesMock.mockResolvedValue([
      proc("/tmp/proj-mcp", false, "2.1.228", "claude mcp serve"),
    ]);

    await useBandStore.getState().refresh();

    expect(useBandStore.getState().externallyActiveDirs.size).toBe(0);
  });

  it("ignores the Claude desktop app and its helpers", async () => {
    /* The GUI bundle's binary is also named claude once lowercased, but a
       .app bundle is not a coding session in a directory. */
    listDevProcessesMock.mockResolvedValue([
      proc("/", false, "claude", "/Applications/Claude.app/Contents/MacOS/Claude"),
      proc("/", false, "claude", "/Applications/Claude.app/Contents/MacOS/Claude --type=renderer"),
    ]);

    await useBandStore.getState().refresh();

    expect(useBandStore.getState().externallyActiveDirs.size).toBe(0);
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

function handoff(slug: string): HandoffInfo {
  return {
    slug,
    path: `/tmp/${slug}`,
    repo: slug,
    branch: "main",
    uncommitted: 0,
    lastCommit: null,
    asks: [],
    lastAction: "Stopped.",
    waiting: false,
    lastActive: new Date().toISOString(),
    stale: false,
    orphan: false,
  };
}

describe("useBandStore dismissHandoff", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useBandStore.setState({ handoffs: [handoff("keep"), handoff("go")] });
  });

  it("deletes the snapshot and drops just that row", async () => {
    invokeMock.mockResolvedValueOnce(true);

    const error = await useBandStore.getState().dismissHandoff("go");

    expect(invokeMock).toHaveBeenCalledWith("dismiss_handoff", { slug: "go" });
    expect(error).toBeNull();
    expect(useBandStore.getState().handoffs.map((h) => h.slug)).toEqual(["keep"]);
  });

  /* A slug whose files were already swept still leaves the UI in the state
     the user asked for. */
  it("drops the row even when nothing was left to delete", async () => {
    invokeMock.mockResolvedValueOnce(false);

    expect(await useBandStore.getState().dismissHandoff("go")).toBeNull();
    expect(useBandStore.getState().handoffs.map((h) => h.slug)).toEqual(["keep"]);
  });

  /* The file is still on disk, so hiding the row would only have it reappear
     on the next refresh — worse than saying the dismiss failed. */
  it("keeps the row and returns the error when the delete fails", async () => {
    invokeMock.mockRejectedValueOnce("permission denied");

    const error = await useBandStore.getState().dismissHandoff("go");

    expect(error).toContain("permission denied");
    expect(useBandStore.getState().handoffs.map((h) => h.slug)).toEqual(["keep", "go"]);
  });
});
