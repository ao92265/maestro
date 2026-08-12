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

// useSessionStore binds Tauri event listeners at call time; nothing in these
// tests listens, but the import must not reach a real event bridge.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { LaunchSection } from "../LaunchSection";
import type { SamuraiPreflight, SamuraiRunConfig } from "@/lib/samurai";
import type { UsageData } from "@/lib/usageParser";
import { useSessionStore, type SamuraiSessionInfo } from "@/stores/useSessionStore";
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

/** A pre-#83 config by default: raw ref in `epic`, both lists empty. */
function run(overrides: Partial<SamuraiRunConfig> = {}): SamuraiRunConfig {
  return {
    project_path: "C:\\git\\maestro",
    epic: "#38",
    epics: [],
    issues: [],
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
        // Since issue #83 the backend answers with the readable label, and
        // the branch/worktree carry the combined slug built from it.
        return {
          epic: "epic #38",
          branch: "samurai-epic-38",
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-epic-38",
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

/** One supervised session, exactly as the supervisor registers it (issue #84). */
function supervised(overrides: Partial<SamuraiSessionInfo> = {}): SamuraiSessionInfo {
  return {
    project: "C:\\git\\maestro",
    // The supervisor registers under the run's identity string, so this is
    // the same field the run config carries.
    epic: "#38",
    generation: 1,
    state: "WORKING",
    ...overrides,
  };
}

/** The per-run "open the agent" button of a run labelled `epic`. */
const OPEN_LABEL = (epic: string) => `Open the agent for run ${epic}`;

describe("LaunchSection (issue #63)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    useSessionStore.setState({ samuraiBySessionId: {} });
  });

  it("renders the form with the active project and a disabled Launch button", async () => {
    render(<LaunchSection />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    // The project is read-only context, shown by name — not an input.
    expect(screen.getByText("maestro")).toBeInTheDocument();
    // Issue #83: epics and issues are separate fields.
    expect(screen.getByLabelText("Epics")).toBeInTheDocument();
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

  it("keeps Launch disabled while both ref fields are empty", async () => {
    render(<LaunchSection />);
    // Let the runs list and the usage poll land first — this test never
    // awaits anything else, and a late resolve would fire outside act().
    await screen.findByText("No active runs. Launch one above.");
    await waitFor(() => expect(callsOf("get_claude_usage").length).toBeGreaterThan(0));

    const button = () => screen.getByRole("button", { name: "Launch" });
    expect(button()).toBeDisabled();

    // Whitespace and bare separators carry no ref — still nothing to run.
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "  , ," } });
    expect(button()).toBeDisabled();

    // Either field on its own is enough.
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "7" } });
    expect(button()).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "" } });
    expect(button()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "5" } });
    expect(button()).toBeEnabled();
  });

  it("runs preflight then launches from the one button, no declaration needed", async () => {
    render(<LaunchSection />);
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "38" } });
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
      epics: ["38"],
      issues: [],
      model: null,
      handoffContextPct: null,
    });
    expect(
      await screen.findByText(/Run launched: epic #38 on samurai-epic-38/),
    ).toBeInTheDocument();
  });

  it("launches from the Issues field alone, with no epic (issue #83)", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "77, 78" } });
    // The summary counts only what was filled in — no phantom epic.
    expect(screen.getByText(/2 issues in one run/).textContent).not.toContain("epic");

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({
      epics: [],
      issues: ["77", "78"],
    });
  });

  it("combines both fields into one run and counts each set", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "7, 9" } });
    // Singular and plural agree per set.
    expect(screen.getByText(/1 epic, 2 issues in one run/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({
      epics: ["5"],
      issues: ["7", "9"],
    });
  });

  it("accepts #-prefixed refs in both fields", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "#5, #12" } });
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: " #7 " } });
    expect(screen.getByText(/2 epics, 1 issue in one run/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    // The `#` rides through — the backend strips it when it normalizes.
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({
      epics: ["#5", "#12"],
      issues: ["#7"],
    });
  });

  it("rejects a non-numeric ref inline and never calls the backend", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "7, feature/login" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByText(/"feature\/login" is not an issue number/)).toBeInTheDocument();
    // Junk never reaches the launch — not even the preflight probe runs.
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
    expect(callsOf("samurai_preflight")).toHaveLength(0);

    // Fixing the field clears the way.
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
  });

  it("rejects junk in the Epics field too", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "epic-5" } });
    // Something IS typed, so the button is clickable — that click is what
    // renders the error a disabled button could never explain.
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByText(/"epic-5" is not an issue number/)).toBeInTheDocument();
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
  });

  it("shows remaining allowance per model and pins the chosen one", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "38" } });

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
    fireEvent.change(screen.getByLabelText("Epics"), { target: { value: "38" } });
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "41" } });
    fireEvent.change(screen.getByLabelText("Handoff at context %"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epics: ["38"],
      issues: ["41"],
      model: null,
      handoffContextPct: 30,
    });
    // Every field clears together after a launch.
    await screen.findByText(/Run launched: epic #38/);
    expect(screen.getByLabelText("Epics")).toHaveValue("");
    expect(screen.getByLabelText("Issues")).toHaveValue("");
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
    fireEvent.click(screen.getByRole("button", { name: "Clean up run #38" }));

    await waitFor(() => expect(callsOf("samurai_cleanup_epic")).toHaveLength(1));
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(String(askMock.mock.calls[0][0])).toContain("cannot be undone");
    expect(callsOf("samurai_cleanup_epic")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
    });
    expect(
      await screen.findByText(/Cleaned up run #38: removed worktree, branch samurai-38/),
    ).toBeInTheDocument();
  });

  it("reads an active run as `epic #5 · issues #7, #9`, legacy configs included", async () => {
    mockInvoke({
      runs: [
        // Post-#83: the backend already stored the readable label.
        run({
          epic: "epic #5 · issues #7, #9",
          epics: ["5"],
          issues: ["7", "9"],
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-epic-5-issues-7-9",
        }),
        // Pre-#83: a single raw ref and two empty lists — must still render.
        run({ project_path: "C:\\git\\other", epic: "#38" }),
      ],
    });
    render(<LaunchSection />);

    expect(await screen.findByText("epic #5 · issues #7, #9")).toBeInTheDocument();
    expect(screen.getByText("#38")).toBeInTheDocument();
  });

  it("never cleans up when the confirm is declined", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(false);
    render(<LaunchSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Clean up run #38" }));
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

  it("opens the newest live generation of a run's agent (issue #84)", async () => {
    mockInvoke({ runs: [run()] });
    useSessionStore.setState({
      samuraiBySessionId: {
        // gen-1, killed when gen-2 replaced it (issue #55 replication).
        4: supervised({ generation: 1, state: "KILLED" }),
        // gen-2, the one actually working — and registered under the
        // backend's canonical `\\?\` spelling of the same directory.
        7: supervised({ project: "\\\\?\\C:\\git\\maestro", generation: 2 }),
        // A higher generation of the same ref in ANOTHER project: never it.
        9: supervised({ project: "C:\\git\\other", generation: 3 }),
      },
    });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    const button = await screen.findByRole("button", { name: OPEN_LABEL("#38") });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 7);
  });

  it("disables the open button and says why when no agent is registered", async () => {
    mockInvoke({ runs: [run()] });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    const button = await screen.findByRole("button", { name: OPEN_LABEL("#38") });
    expect(button).toBeDisabled();
    // The reason hangs off the wrapper — a disabled button never gets hovered.
    expect(screen.getByTitle(/not running in this Maestro session/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("names parking as the reason when the run's tile was closed", async () => {
    mockInvoke({ runs: [run()] });
    useSessionStore.setState({
      samuraiBySessionId: { 3: supervised({ generation: 2, state: "PARKED" }) },
    });
    render(<LaunchSection onNavigate={vi.fn()} />);

    expect(await screen.findByRole("button", { name: OPEN_LABEL("#38") })).toBeDisabled();
    expect(screen.getByTitle(/it was parked/)).toBeInTheDocument();
  });

  it("never cross-focuses two projects running the same epic ref", async () => {
    mockInvoke({ runs: [run(), run({ project_path: "C:\\git\\other" })] });
    // Only the second project has a live agent under `#38`.
    useSessionStore.setState({
      samuraiBySessionId: { 12: supervised({ project: "C:\\git\\other" }) },
    });
    useWorkspaceStore.setState({
      tabs: [
        buildTab(),
        buildTab({ id: "tab-2", name: "other", projectPath: "C:\\git\\other", active: false }),
      ],
    });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    // Rows keep samurai_list_runs order: [0] is maestro, [1] is other.
    const buttons = await screen.findAllByRole("button", { name: OPEN_LABEL("#38") });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();

    fireEvent.click(buttons[1]);
    expect(onNavigate).toHaveBeenCalledWith("tab-2", 12);
  });
});
