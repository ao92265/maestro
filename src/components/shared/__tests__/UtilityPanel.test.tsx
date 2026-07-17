import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import { UtilityPanel } from "../UtilityPanel";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const invokeMock = vi.mocked(invoke);

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

/** Routes the global invoke mock by command; unknown commands resolve empty. */
function mockInvoke() {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "list_context_docs":
        return [
          {
            tier: "user",
            kind: "claude",
            label: "CLAUDE.md",
            path: "C:\\Users\\me\\.claude\\CLAUDE.md",
            exists: true,
          },
        ];
      case "list_memory_projects":
        return [
          {
            dirName: "C--git-maestro",
            memoryPath: "C:\\Users\\me\\.claude\\projects\\C--git-maestro\\memory",
            fileCount: 2,
            isActive: true,
          },
        ];
      case "list_memory_files":
        return [
          {
            relPath: "MEMORY.md",
            path: "C:\\Users\\me\\.claude\\projects\\C--git-maestro\\memory\\MEMORY.md",
            description: null,
            memType: null,
            isIndex: true,
            sizeBytes: 100,
            modified: null,
          },
          {
            relPath: "user_profile.md",
            path: "C:\\Users\\me\\.claude\\projects\\C--git-maestro\\memory\\user_profile.md",
            description: "Who the user is",
            memType: "user",
            isIndex: false,
            sizeBytes: 200,
            modified: null,
          },
        ];
      case "list_dev_processes":
        return [];
      case "list_docker_containers":
        return { available: false, containers: [] };
      default:
        return undefined;
    }
  });
}

describe("UtilityPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // The processes poll skips when the window is unfocused; happy-dom is headless.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("renders the Memory panel: user CLAUDE.md plus per-project files", async () => {
    render(<UtilityPanel panel="memory" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("User Memory")).toBeInTheDocument();
    expect(await screen.findByText("~/.claude/CLAUDE.md")).toBeInTheDocument();
    // Active project auto-expands with its memory files
    expect(await screen.findByText("C--git-maestro")).toBeInTheDocument();
    expect(await screen.findByText("MEMORY.md")).toBeInTheDocument();
    expect(screen.getByText("INDEX")).toBeInTheDocument();
    expect(screen.getByText("user_profile.md")).toBeInTheDocument();
    expect(screen.getByText("Who the user is")).toBeInTheDocument();
  });

  it("renders the Processes panel", async () => {
    render(<UtilityPanel panel="processes" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(
      screen.getByText("Dev processes on this machine, grouped by command."),
    ).toBeInTheDocument();
    expect(await screen.findByText("No watched processes running")).toBeInTheDocument();
  });

  it("renders the Notes panel with its empty state", () => {
    render(<UtilityPanel panel="notes" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
  });

  it("calls onClose from the header close button", () => {
    const onClose = vi.fn();
    render(<UtilityPanel panel="processes" width={320} onResize={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Processes panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
