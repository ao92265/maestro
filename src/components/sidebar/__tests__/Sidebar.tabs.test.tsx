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
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { useSessionStore } from "@/stores/useSessionStore";

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
      // History tab reads
      case "list_claude_sessions":
        return [
          {
            session_id: "11111111-2222-3333-4444-555555555555",
            first_prompt: "Fix the login bug",
            started_at: "2026-07-29T08:00:00Z",
            last_active: "2026-07-29T09:00:00Z",
            git_branch: "feat/login",
          },
        ];
      case "git_worktree_list":
        return [
          {
            path: "C:\\git\\maestro",
            head: "abc123",
            branch: "main",
            is_bare: false,
            is_main_worktree: true,
          },
          {
            path: "C:\\worktrees\\feat-login",
            head: "def456",
            branch: "feat/login",
            is_bare: false,
            is_main_worktree: false,
          },
        ];
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
    useSessionStore.setState({ sessions: [] });
  });

  it("renders the four tabs with General active by default", () => {
    render(<Sidebar />);
    for (const label of ["General", "History", "Infra", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Processes and Memory moved to the right-side utility panel
    expect(screen.queryByRole("button", { name: "Processes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory" })).not.toBeInTheDocument();
    // General tab content
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Git Repository")).toBeInTheDocument();
    // Content from other tabs is not mounted
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
  });

  it("switches to Infra (MCP + skills + project context)", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Infra" }));
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Plugins & Skills")).toBeInTheDocument();
    expect(screen.getByText("Project Context")).toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  });

  it("switches to Settings and persists the chosen tab", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Terminal Settings")).toBeInTheDocument();
    await waitFor(() => {
      expect(localStorage.getItem("maestro-sidebar-tab")).toBe("settings");
    });
  });

  it("falls back to General when a removed tab id was persisted", () => {
    localStorage.setItem("maestro-sidebar-tab", "memory");
    render(<Sidebar />);
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("History tab lists past conversations and queues a resume launch", async () => {
    usePendingLaunchStore.setState({ pending: null });
    const onHistoryLaunch = vi.fn();
    render(<Sidebar onHistoryLaunch={onHistoryLaunch} />);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    // Expand the project's collapsible
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    const conversation = await screen.findByText("Fix the login bug");
    fireEvent.click(conversation);

    // The launch is queued with the conversation paired to its worktree
    expect(usePendingLaunchStore.getState().pending).toMatchObject({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: "11111111-2222-3333-4444-555555555555",
      workingDirOverride: "C:\\worktrees\\feat-login",
      branch: "feat/login",
    });
    // The project grid is set to mount, and App is asked to reveal it
    expect(useWorkspaceStore.getState().tabs[0].sessionsLaunched).toBe(true);
    expect(onHistoryLaunch).toHaveBeenCalledWith("tab-1");
  });

  it("History tab launches an agent into a surviving worktree", async () => {
    usePendingLaunchStore.setState({ pending: null });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    // Main worktree is filtered out; only the feature worktree is listed
    const worktreeRow = await screen.findByTitle("Launch an agent in C:\\worktrees\\feat-login");
    fireEvent.click(worktreeRow);

    expect(usePendingLaunchStore.getState().pending).toMatchObject({
      tabId: "tab-1",
      resumeSessionId: null,
      workingDirOverride: "C:\\worktrees\\feat-login",
      branch: "feat/login",
    });
  });

  it("clicking a terminal row in Agents navigates to it", () => {
    useWorkspaceStore.setState({
      tabs: [buildTab({ sessionIds: [1], sessionsLaunched: true })],
    });
    // project_path must match the tab's projectPath or sessionsForTab drops the row.
    useSessionStore.setState({
      sessions: [
        {
          id: 1,
          mode: "Claude",
          name: "My agent",
          branch: null,
          status: "Working",
          worktree_path: null,
          project_path: "C:\\git\\maestro",
        },
      ],
    });
    const onNavigate = vi.fn();
    render(<Sidebar onAgentNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("My agent"));
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 1);
  });
});
