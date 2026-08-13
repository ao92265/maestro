import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// The section subscribes to the live test-gate channel on mount (issue
// #90b) — the AuditSection test's listen-capture pattern.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import type {
  SamuraiPreflight,
  SamuraiRunListEntry,
  SamuraiRunOrchestrator,
  SamuraiTestGateProgress,
  SamuraiWorkflowGraph,
} from "@/lib/samurai";
import type { UsageData } from "@/lib/usageParser";
import { useSamuraiWorkflowStore } from "@/stores/useSamuraiWorkflowStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { LaunchSection } from "../LaunchSection";

/**
 * The section now embeds the React Flow workflow editor (issue #91), which
 * measures through browser APIs happy-dom lacks — the LandscapeView test's
 * stub block.
 */
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
      constructor(_transform?: string) {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => {},
    }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
});

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);
const listenMock = vi.mocked(listen);

/** Captured `samurai-test-gate-event` handler, so tests can stream ticks. */
let emitGateEvent: (payload: SamuraiTestGateProgress) => void;

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

/** Default orchestrator: nothing known yet — every field absent. */
function orchestrator(overrides: Partial<SamuraiRunOrchestrator> = {}): SamuraiRunOrchestrator {
  return {
    generation: null,
    session_id: null,
    model: null,
    context_window: null,
    context_percent: null,
    ...overrides,
  };
}

function run(overrides: Partial<SamuraiRunListEntry> = {}): SamuraiRunListEntry {
  return {
    project_path: "C:\\git\\maestro",
    epic: "#38",
    repo_pin: "nachogl1/maestro",
    worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
    model: null,
    thresholds: null,
    workflow: null,
    status: "ACTIVE",
    created_at: "2026-08-06T10:00:00Z",
    orchestrator: orchestrator(),
    ...overrides,
  };
}

/** A minimal workflow graph, for the editor fallback and edited-graph cases. */
function workflowGraph(): SamuraiWorkflowGraph {
  return {
    nodes: [
      { id: "implement", text: "Implement the issue." },
      { id: "verify", text: "Verify and push." },
    ],
    edges: [{ from: "implement", to: "verify" }],
    start: "implement",
  };
}

/** Routes the invoke mock by command; unknown commands resolve empty. */
function mockInvoke({
  preflight = passPreflight(),
  runs = [] as SamuraiRunListEntry[],
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
      // The embedded workflow editor's display fallback (issue #91).
      case "samurai_default_workflow":
        return workflowGraph();
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
    listenMock.mockReset();
    emitGateEvent = () => {};
    listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
      if (event === "samurai-test-gate-event") {
        emitGateEvent = (payload) => handler({ payload });
      }
      return Promise.resolve(() => {});
    }) as typeof listen);
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // Untouched workflow editor by default — launches send workflow: null.
    useSamuraiWorkflowStore.setState({ graph: null });
  });

  it("renders the form with the active project and a disabled Launch button", async () => {
    render(<LaunchSection />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    // The project is read-only context, shown by name — not an input.
    expect(screen.getByText("maestro")).toBeInTheDocument();
    expect(screen.getByLabelText("Issues")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Handoff at context %")).toBeInTheDocument();
    // The agent-readiness declaration is gone — it is the model's call now.
    // The only checkbox is the test-gate skip toggle (issue #90b), OFF by
    // default: the gate runs unless the user explicitly opts out.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "Skip test-suite gate" })).not.toBeChecked();
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
      skipTestGate: false,
      // Issue #91: the workflow editor is untouched — null lets the backend
      // fall back to (and snapshot) the default template.
      workflow: null,
    });
    expect(await screen.findByText(/Run launched: #38 on samurai-38/)).toBeInTheDocument();
  });

  it("sends the edited workflow graph with the launch (issue #91)", async () => {
    // A persisted edit (here: the chain cut after "implement") rides the
    // launch verbatim — the backend snapshots exactly what the editor holds.
    const edited: SamuraiWorkflowGraph = { ...workflowGraph(), edges: [] };
    useSamuraiWorkflowStore.setState({ graph: edited });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ workflow: edited });
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
      skipTestGate: false,
      workflow: null,
    });
    // The field clears with the rest of the form after a launch.
    await screen.findByText(/Run launched: #38/);
    expect(screen.getByLabelText("Handoff at context %")).toHaveValue(null);
  });

  it("sends the skip test-gate toggle with the launch args (issue #90b)", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Skip test-suite gate" }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ skipTestGate: true });
  });

  it("renders live test-gate progress with elapsed time during a launch (issue #90b)", async () => {
    let resolveLaunch: (result: unknown) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_launch_run":
          return new Promise((resolve) => {
            resolveLaunch = resolve;
          });
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Issues"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));

    // A backend tick lands: the button shows the step with elapsed time.
    act(() => {
      emitGateEvent({
        project: "C:\\git\\maestro",
        epic: "#38",
        step: "cargo_test",
        detail: "cargo test: running the workspace suite…",
        elapsed_secs: 12,
      });
    });
    expect(screen.getByText(/cargo test: running the workspace suite… · \d+s/)).toBeInTheDocument();

    // Another project's tick must not repaint this launcher.
    act(() => {
      emitGateEvent({
        project: "C:\\git\\other",
        epic: "#9",
        step: "bootstrap_npm",
        detail: "bootstrap: npm install…",
        elapsed_secs: 3,
      });
    });
    expect(screen.queryByText(/npm install… ·/)).not.toBeInTheDocument();
    expect(screen.getByText(/cargo test: running the workspace suite…/)).toBeInTheDocument();

    // The launch resolves: the progress line clears with the phase.
    await act(async () => {
      resolveLaunch({
        epic: "#38",
        branch: "samurai-38",
        worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
        repo_pin: null,
        stale_timer_cancelled: false,
      });
    });
    expect(await screen.findByText(/Run launched: #38/)).toBeInTheDocument();
    expect(screen.queryByText(/cargo test: running/)).not.toBeInTheDocument();
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

  it("shows a COMPLETED run as finished-awaiting-cleanup, distinct from live (issue #96)", async () => {
    mockInvoke({ runs: [run(), run({ epic: "#39", status: "COMPLETED" })] });
    render(<LaunchSection />);

    // The live run keeps its ACTIVE badge; the verified-complete one gets
    // the distinct FINISHED badge naming the awaiting-cleanup state.
    expect(await screen.findByText("FINISHED")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("FINISHED").getAttribute("title")).toContain("Awaiting cleanup");
    // Cleanup stays the separate manual step (PRD §5.9) — still offered.
    expect(screen.getByRole("button", { name: "Clean up epic #39" })).toBeInTheDocument();
  });

  it("shows the orchestrator's live details on a run row (issue #102)", async () => {
    mockInvoke({
      runs: [
        run({
          orchestrator: orchestrator({
            generation: 3,
            session_id: 42,
            model: "claude-opus-4-6[1m]",
            context_window: 1_000_000,
            context_percent: 38.5,
          }),
        }),
      ],
    });
    render(<LaunchSection />);

    expect(await screen.findByText("claude-opus-4-6[1m]")).toBeInTheDocument();
    expect(screen.getByText("Gen 3")).toBeInTheDocument();
    expect(screen.getByText("Session 42")).toBeInTheDocument();
    expect(screen.getByText("38.5% / 1M")).toBeInTheDocument();
  });

  it("renders absent orchestrator fields as dashes, never a guess (issue #102)", async () => {
    // The default run() has no session registered yet: every orchestrator
    // field is null.
    mockInvoke({ runs: [run()] });
    render(<LaunchSection />);

    expect(await screen.findByText("Gen —")).toBeInTheDocument();
    expect(screen.getByText("Session —")).toBeInTheDocument();
    // The model slot and the context slot both render a bare dash.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("hides the live context % on a COMPLETED run (issue #102)", async () => {
    // Even if the backend still reports a frozen reading for a run whose
    // terminal already tore down, the panel must not present it as live.
    mockInvoke({
      runs: [
        run({
          epic: "#39",
          status: "COMPLETED",
          orchestrator: orchestrator({
            generation: 2,
            session_id: 7,
            model: "claude-opus-4-6",
            context_window: 200_000,
            context_percent: 90,
          }),
        }),
      ],
    });
    render(<LaunchSection />);

    // The identity facts still show for a finished run…
    expect(await screen.findByText("claude-opus-4-6")).toBeInTheDocument();
    expect(screen.getByText("Gen 2")).toBeInTheDocument();
    expect(screen.getByText("Session 7")).toBeInTheDocument();
    // …but the live context reading does not.
    expect(screen.queryByText(/90%/)).not.toBeInTheDocument();
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
