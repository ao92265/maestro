import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

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

import { LaunchSection } from "../LaunchSection";
import type { SamuraiPreflight, SamuraiRunConfig } from "@/lib/samurai";
import type { UsageData } from "@/lib/usageParser";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

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

function passPreflight(overrides: Partial<SamuraiPreflight> = {}): SamuraiPreflight {
  return {
    gh_auth: { ok: true, username: "nachogl1", error: null },
    windows_reported: true,
    ...overrides,
  };
}

/** Opus 38% used → 62% left; Fable rides the `limits`-derived list. */
function buildUsage(overrides: Partial<UsageData> = {}): UsageData {
  return {
    sessionPercent: 10,
    sessionResetsAt: null,
    weeklyPercent: 20,
    weeklyResetsAt: null,
    weeklyOpusPercent: 38,
    weeklyOpusResetsAt: null,
    weeklySonnetPercent: 5,
    weeklySonnetResetsAt: null,
    weeklyOauthAppsPercent: null,
    weeklyOauthAppsResetsAt: null,
    spendPercent: null,
    spendResetsAt: null,
    spendUsedDollars: null,
    spendLimitDollars: null,
    modelWindows: [{ label: "Fable", percent: 91, resetsAt: null }],
    errorMessage: null,
    needsAuth: false,
    ...overrides,
  };
}

function run(overrides: Partial<SamuraiRunConfig> = {}): SamuraiRunConfig {
  return {
    project_path: "C:\\git\\maestro",
    epic: "#38",
    repo_pin: "nachogl1/maestro",
    worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
    model: null,
    thresholds: null,
    status: "ACTIVE",
    created_at: "2026-08-06T10:00:00Z",
    ...overrides,
  };
}

/** Routes the invoke mock by command; unknown commands resolve empty. */
function mockInvoke({
  preflight = passPreflight(),
  runs = [] as SamuraiRunConfig[],
  usage = buildUsage(),
} = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "samurai_preflight":
        return preflight;
      case "samurai_list_runs":
        return runs;
      case "get_claude_usage":
        return usage;
      case "samurai_launch_run":
        return {
          epic: "#38",
          branch: "samurai-38",
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
          repo_pin: "nachogl1/maestro",
          stale_timer_cancelled: false,
        };
      case "samurai_cleanup_epic":
        return {
          epic: "#38",
          branch: "samurai-38",
          timer_cancelled: true,
          config_archived: true,
          worktree_removed: true,
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
          branch_deleted: true,
        };
      default:
        return undefined;
    }
  });
}

/** Calls of one command name, for argument assertions. */
function callsOf(cmd: string) {
  return invokeMock.mock.calls.filter(([name]) => name === cmd);
}

describe("LaunchSection (issue #63)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
  });

  it("renders the form with the active project and a disabled Launch button", async () => {
    render(<LaunchSection />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    // The project is read-only context, shown by name — not an input.
    expect(screen.getByText("maestro")).toBeInTheDocument();
    expect(screen.getByLabelText("Issues")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Handoff at context %")).toBeInTheDocument();
    // The agent-readiness declaration is gone — it is the model's call now,
    // and all that is left is the warning.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Make sure the issues are agent-ready/)).toBeInTheDocument();
    // Nothing to work yet → Launch stays disabled.
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(await screen.findByText("No active runs. Launch one above.")).toBeInTheDocument();
  });

  it("runs preflight then launches from the one button, no declaration needed", async () => {
    render(<LaunchSection />);
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    // Preflight runs as phase 1 of the launch, not as a separate click, and
    // strictly before it — the launch must never start on an unchecked env.
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_preflight")).toHaveLength(1);
    const order = invokeMock.mock.calls.map(([name]) => name);
    expect(order.indexOf("samurai_preflight")).toBeLessThan(order.indexOf("samurai_launch_run"));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
      model: null,
      handoffContextPct: null,
    });
    expect(await screen.findByText(/Run launched: #38 on samurai-38/)).toBeInTheDocument();
  });

  it("accepts a comma-separated issue list as one run", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "77, 78" } });
    expect(screen.getByText(/2 issues in one run/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ epic: "77, 78" });
  });

  it("shows remaining allowance per model and pins the chosen one", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });

    // Wait for the usage poll to land before opening the picker.
    await waitFor(() => expect(callsOf("get_claude_usage").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("Model"));

    const listbox = await screen.findByRole("listbox", { name: "Model" });
    // 38% used → 62% left; Fable 91% used → 9% left; Haiku has no window.
    expect(within(listbox).getByText("62% left")).toBeInTheDocument();
    expect(within(listbox).getByText("9% left")).toBeInTheDocument();
    // Default (no model pinned) and Haiku (no window reported) both show the
    // unknown dash — "no data" must never render as 0% left.
    expect(within(listbox).getAllByText("—")).toHaveLength(2);

    fireEvent.click(within(listbox).getByRole("option", { name: /Opus 5/ }));
    fireEvent.click(screen.getByRole("button", { name: /Launch/ }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ model: "claude-opus-5" });
  });

  it("passes the per-run handoff % override to the launch (review F4)", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.change(screen.getByLabelText("Handoff at context %"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
      model: null,
      handoffContextPct: 30,
    });
    // The field clears with the rest of the form after a launch.
    await screen.findByText(/Run launched: #38/);
    expect(screen.getByLabelText("Handoff at context %")).toHaveValue(null);
  });

  it("stops at failing preflight rows and never reaches the launch", async () => {
    mockInvoke({
      preflight: {
        gh_auth: { ok: false, username: null, error: "gh is not authenticated" },
        windows_reported: false,
      },
    });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByText(/gh auth failed/)).toBeInTheDocument();
    expect(screen.getByText(/gh is not authenticated/)).toBeInTheDocument();
    expect(screen.getByText(/No governing allowance window/)).toBeInTheDocument();
    expect(screen.getByText(/Preflight failed/)).toBeInTheDocument();
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
    // Still launchable once the user fixes the environment.
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();
  });

  it("lists active runs and cleans one up after the ask() confirm", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(true);
    render(<LaunchSection />);

    expect(await screen.findByText("#38")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean up epic #38" }));

    await waitFor(() => expect(callsOf("samurai_cleanup_epic")).toHaveLength(1));
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(String(askMock.mock.calls[0][0])).toContain("cannot be undone");
    expect(callsOf("samurai_cleanup_epic")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
    });
    expect(
      await screen.findByText(/Cleaned up epic #38: removed worktree, branch samurai-38/),
    ).toBeInTheDocument();
  });

  it("never cleans up when the confirm is declined", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(false);
    render(<LaunchSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Clean up epic #38" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(callsOf("samurai_cleanup_epic")).toHaveLength(0);
  });

  it("drops a preflight result that lands after a project switch", async () => {
    let resolvePreflight: (result: SamuraiPreflight) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return new Promise<SamuraiPreflight>((resolve) => {
            resolvePreflight = resolve;
          });
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    // Switch projects while the probe (gh auth status subprocess) is still out.
    act(() => {
      useWorkspaceStore.setState({
        tabs: [buildTab({ id: "tab-2", name: "other", projectPath: "C:\\git\\other" })],
      });
    });
    expect(await screen.findByText("other")).toBeInTheDocument();

    // The old project's answer lands — it must not launch into the new one.
    await act(async () => {
      resolvePreflight(passPreflight());
    });

    expect(screen.queryByText("gh authenticated as nachogl1")).not.toBeInTheDocument();
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
    // The phase cleared, so the button is usable again for the new project.
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();
  });

  it("shows a backend launch refusal as an error", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_launch_run":
          throw "launch refused: this epic already has a live supervised session";
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(
      await screen.findByText(/launch refused: this epic already has a live supervised session/),
    ).toBeInTheDocument();
  });
});
