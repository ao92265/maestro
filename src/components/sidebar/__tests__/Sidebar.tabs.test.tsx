import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// useTerminalSettingsStore subscribes to a Tauri event at module scope.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { Sidebar } from "../Sidebar";
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
      case "git_user_config":
        return { name: "Test User", email: "test@example.com" };
      case "git_list_remotes":
        return [];
      case "get_default_worktree_base_dir":
        return "C:\\worktrees";
      // Infra tab reads — stores write these results straight into arrays,
      // so they must resolve to the right shapes, not undefined.
      case "get_mcp_status":
        return { servers: [], connectors: [] };
      case "get_custom_mcp_servers":
      case "get_project_mcp_servers":
      case "refresh_project_mcp_servers":
      case "get_marketplace_sources":
      case "get_available_plugins":
      case "get_installed_plugins":
        return [];
      case "get_project_plugins":
      case "refresh_project_plugins":
        return { skills: [], plugins: [] };
      default:
        return undefined;
    }
  });
}

describe("Sidebar tab bar", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    localStorage.clear();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
  });

  it("renders the four tabs with General active by default", () => {
    render(<Sidebar />);
    for (const label of ["General", "Infra", "Memory", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // General tab content
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Git Repository")).toBeInTheDocument();
    // Content from other tabs is not mounted
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    expect(screen.queryByText("User Memory")).not.toBeInTheDocument();
  });

  it("switches to Infra (MCP + skills + project context)", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Infra" }));
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Plugins & Skills")).toBeInTheDocument();
    expect(screen.getByText("Project Context")).toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  });

  it("shows memory: user CLAUDE.md plus per-project files with index and type badges", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(screen.getByText("User Memory")).toBeInTheDocument();
    expect(await screen.findByText("~/.claude/CLAUDE.md")).toBeInTheDocument();
    // Active project auto-expands with its memory files
    expect(await screen.findByText("C--git-maestro")).toBeInTheDocument();
    expect(await screen.findByText("MEMORY.md")).toBeInTheDocument();
    expect(screen.getByText("INDEX")).toBeInTheDocument();
    expect(screen.getByText("user_profile.md")).toBeInTheDocument();
    expect(screen.getByText("Who the user is")).toBeInTheDocument();
  });

  it("switches to Settings and persists the chosen tab", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Terminal Settings")).toBeInTheDocument();
    await waitFor(() => {
      expect(localStorage.getItem("maestro-sidebar-tab")).toBe("settings");
    });
  });
});
