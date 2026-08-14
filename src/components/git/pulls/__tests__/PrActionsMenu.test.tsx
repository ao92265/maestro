import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The PR workflow store hydrates through the Tauri store plugin at import
// time; happy-dom has no Tauri backend, so stub it out.
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

import { DEFAULT_PR_WORKFLOW } from "@/lib/prWorkflow";
import type { SamuraiWorkflowGraph } from "@/lib/samurai";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { prWorkflowGraphForLaunch, usePrWorkflowStore } from "@/stores/usePrWorkflowStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { PrActionsMenu } from "../PrActionsMenu";

const REPO_PATH = "C:\\git\\maestro";

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: REPO_PATH,
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

function buildPr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 123,
    title: "feat(pr): monitoring tower",
    state: "OPEN",
    author: { login: "nachogl1" },
    createdAt: "2026-08-13T10:00:00Z",
    updatedAt: "2026-08-13T12:00:00Z",
    headRefName: "feat/pr-monitor",
    baseRefName: "main",
    isDraft: false,
    additions: 12,
    deletions: 3,
    url: "https://github.com/nachogl1/maestro/pull/123",
    labels: [],
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

/** The default chain plus a user-added fifth step, wired onto the end. */
function graphWithExtraStep(): SamuraiWorkflowGraph {
  return {
    nodes: [
      ...DEFAULT_PR_WORKFLOW.nodes,
      { id: "announce", label: "Announce result", text: "Post the outcome to the team channel." },
    ],
    edges: [...DEFAULT_PR_WORKFLOW.edges, { from: "merge", to: "announce" }],
    start: DEFAULT_PR_WORKFLOW.start,
  };
}

function openMenu() {
  fireEvent.click(screen.getByLabelText("Actions for PR #123"));
}

function checkboxFor(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe("PrActionsMenu", () => {
  beforeEach(async () => {
    // Let the persisted store finish hydrating before seeding it, so a late
    // rehydration cannot overwrite the graph a test just set.
    await prWorkflowGraphForLaunch();
    usePrWorkflowStore.setState({ graph: null });
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("derives one checkbox per workflow step, with only the first ticked", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    expect(checkboxFor("Check status").checked).toBe(true);
    expect(checkboxFor("Review & post").checked).toBe(false);
    expect(checkboxFor("Fix issues").checked).toBe(false);
    expect(checkboxFor("Merge if green").checked).toBe(false);
    expect(screen.getByRole("button", { name: /Launch 1 step/ })).toBeInTheDocument();
  });

  it("shows a step the user added to the workflow graph", () => {
    usePrWorkflowStore.setState({ graph: graphWithExtraStep() });
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    expect(checkboxFor("Announce result")).toBeInTheDocument();
  });

  it("ticks every earlier step and unticks every later one", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    // Ticking "Fix issues" pulls the two steps before it in with it.
    fireEvent.click(checkboxFor("Fix issues"));
    expect(checkboxFor("Check status").checked).toBe(true);
    expect(checkboxFor("Review & post").checked).toBe(true);
    expect(checkboxFor("Fix issues").checked).toBe(true);
    expect(checkboxFor("Merge if green").checked).toBe(false);
    expect(screen.getByRole("button", { name: /Launch 3 steps/ })).toBeInTheDocument();

    // Unticking "Review & post" drops it and everything after it.
    fireEvent.click(checkboxFor("Review & post"));
    expect(checkboxFor("Check status").checked).toBe(true);
    expect(checkboxFor("Review & post").checked).toBe(false);
    expect(checkboxFor("Fix issues").checked).toBe(false);
    expect(screen.getByRole("button", { name: /Launch 1 step/ })).toBeInTheDocument();
  });

  it("disables Launch when nothing is ticked", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Check status"));
    const launch = screen.getByRole("button", { name: /Launch 0 steps/ });
    expect(launch).toBeDisabled();
    fireEvent.click(launch);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
  });

  it("requests a pending launch carrying the compiled prompt, and closes", async () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Review & post"));
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 steps/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    const launch = usePendingLaunchStore.getState().pending[0];
    expect(launch.tabId).toBe("tab-1");
    expect(launch.mode).toBe("Claude");
    expect(launch.workingDirOverride).toBe(REPO_PATH);
    expect(launch.customName).toBe("PR #123 check+review");
    expect(launch.initialPrompt).toContain('PR: #123 "feat(pr): monitoring tower"');
    expect(launch.initialPrompt).toContain("--repo nachogl1/maestro");
    expect(launch.initialPrompt).toContain("Step 1:");
    expect(launch.initialPrompt).toContain("Step 2:");
    // Only check+review are ticked, so the run stays read-only.
    expect(launch.initialPrompt).toContain("READ-ONLY");

    // The grid must be mounted to consume the request.
    expect(useWorkspaceStore.getState().tabs[0].sessionsLaunched).toBe(true);
    await waitFor(() => expect(screen.queryByLabelText("Check status")).not.toBeInTheDocument());
  });

  it("asks for a project tab instead of launching when none is active", async () => {
    useWorkspaceStore.setState({ tabs: [buildTab({ active: false })] });
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: /Launch 1 step/ }));

    expect(
      await screen.findByText("Open a project tab to launch a PR action."),
    ).toBeInTheDocument();
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
  });

  it("closes on Escape and on an outside click", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);

    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Check status")).not.toBeInTheDocument();

    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByLabelText("Check status")).not.toBeInTheDocument();
  });
});
