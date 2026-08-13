import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// useTerminalDragDrop subscribes to the real Tauri window on mount.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

// xterm.js cannot mount in happy-dom — the grid only needs a pane placeholder.
vi.mock("../TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

vi.mock("@/lib/terminal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminal")>();
  return {
    ...actual,
    spawnShell: vi.fn(async () => 1),
    createSession: vi.fn(async (id: number) => ({
      id,
      mode: "Claude",
      branch: null,
      status: "Working",
      worktree_path: null,
      project_path: "C:/proj",
      name: null,
    })),
    // Unlike the samuraiClose suite this must be TRUE: the CLI-launch half of
    // launchSlotInner is exactly what this test is about.
    checkCliAvailable: vi.fn(async () => true),
    killSession: vi.fn(async () => {}),
    assignSessionBranch: vi.fn(async () => ({ branch: null, worktree_path: null })),
    waitForTerminalReady: vi.fn(async () => {}),
    writeStdin: vi.fn(async () => {}),
    writeSessionHooksConfig: vi.fn(async () => {}),
    removeSessionHooksConfig: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp")>();
  return {
    ...actual,
    getProjectMcpServers: vi.fn(async () => []),
    loadProjectMcpDefaults: vi.fn(async () => null),
    setSessionMcpServers: vi.fn(async () => {}),
    writeSessionMcpConfig: vi.fn(async () => {}),
    writeOpenCodeMcpConfig: vi.fn(async () => {}),
    removeSessionMcpConfig: vi.fn(async () => {}),
    removeOpenCodeMcpConfig: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugins")>();
  return {
    ...actual,
    getProjectPlugins: vi.fn(async () => ({ plugins: [], skills: [] })),
    loadProjectSkillDefaults: vi.fn(async () => null),
    loadProjectPluginDefaults: vi.fn(async () => null),
    loadBranchConfig: vi.fn(async () => null),
    saveBranchConfig: vi.fn(async () => {}),
    setSessionSkills: vi.fn(async () => {}),
    setSessionPlugins: vi.fn(async () => {}),
    writeSessionPluginConfig: vi.fn(async () => {}),
    removeSessionPluginConfig: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  return {
    ...actual,
    getBranchesWithWorktreeStatus: vi.fn(async () => []),
    invalidateCurrentBranchCache: vi.fn(),
  };
});

vi.mock("@/lib/worktreeManager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktreeManager")>();
  return {
    ...actual,
    prepareSessionWorktree: vi.fn(),
    cleanupSessionWorktree: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/samurai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/samurai")>();
  return {
    ...actual,
    samuraiRegisterSession: vi.fn(async () => ({})),
    samuraiHarvestArm: vi.fn(async () => {}),
  };
});

import { invoke } from "@tauri-apps/api/core";
import { samuraiHarvestArm, samuraiRegisterSession } from "@/lib/samurai";
import { spawnShell, writeStdin } from "@/lib/terminal";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalGrid } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);
const writeStdinMock = vi.mocked(writeStdin);
const registerMock = vi.mocked(samuraiRegisterSession);
const harvestArmMock = vi.mocked(samuraiHarvestArm);

const WORKTREE = "C:/wt/samurai-77-78";

/**
 * Regression cover for the samurai launch landing in the WRONG place.
 *
 * A samurai launch queues into `usePendingLaunchStore` and then forces the
 * grid to mount (`setSessionsLaunched`), so the consume effect and the
 * deferred auto-launch effect run in the SAME passive-effect flush. React
 * cannot re-render between them, so the ref-sync effect has not run — and the
 * launch used to read the PRISTINE slot from the stale ref: a plain claude
 * session in the project directory, no `--dangerously-skip-permissions`, and
 * no supervision registration. The backend then re-emitted 180s later and
 * opened a SECOND terminal, which is the one that actually worked.
 */
describe("TerminalGrid pending samurai launch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      return [];
    });
    spawnShellMock.mockClear();
    writeStdinMock.mockClear();
    registerMock.mockClear();
    harvestArmMock.mockClear();
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {}, parkedSessionIds: [] });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("launches a queued samurai claim in its worktree, supervised, on the mount commit", async () => {
    // Queued BEFORE the grid exists — the real ordering: the spawn listener
    // requests the launch and only then mounts the grid.
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: WORKTREE,
      branch: null,
      customName: "samurai gen-1 77-78",
      samurai: { project: "C:/proj", epic: "77, 78", generation: 1, model: "claude-opus-5" },
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());

    // The shell opens in the EPIC WORKTREE, not the project checkout.
    const [workingDir] = spawnShellMock.mock.calls[0];
    expect(workingDir).toBe(WORKTREE);

    // Registered under supervision — this is what arms the backend's brief
    // delivery and stops it re-emitting the spawn event.
    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    expect(registerMock).toHaveBeenCalledWith(expect.any(Number), "C:/proj", "77, 78", 1);

    // …and the CLI carries the autonomy flags a samurai generation needs.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("--dangerously-skip-permissions");
    expect(cli).toContain("--model claude-opus-5");

    // Exactly one terminal: the stray unsupervised one is the bug.
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  // Issue #98: a "Harvest now" launch rides the same pending-launch flow —
  // the grid must arm the backend's journal-prompt injection BEFORE the CLI
  // command is typed, so the gate is set ahead of claude's SessionStart hook.
  it("arms the harvest triage before launching the CLI for a harvest claim", async () => {
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: "C:/proj",
      branch: null,
      customName: "harvest triage",
      harvest: true,
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());
    // The shell opens in the project's MAIN checkout (the override), no
    // worktree derivation.
    const [workingDir] = spawnShellMock.mock.calls[0];
    expect(workingDir).toBe("C:/proj");

    // Armed exactly once, with the launched session's id…
    await waitFor(() => expect(harvestArmMock).toHaveBeenCalledTimes(1));
    expect(harvestArmMock).toHaveBeenCalledWith(1);
    // …and strictly before the CLI command went to the PTY.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    expect(harvestArmMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeStdinMock.mock.invocationCallOrder[0],
    );

    // A plain interactive session: no samurai supervision registration, no
    // forced skip-permissions.
    expect(registerMock).not.toHaveBeenCalled();
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).not.toContain("--dangerously-skip-permissions");
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
  });
});
