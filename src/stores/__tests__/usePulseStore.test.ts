import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

/* The workspace store and the flow-history persist layer both go through the
   Tauri plugin-store, which has no window internals under vitest. */
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import type { PulseRepoActivity, PulseTranscriptStats } from "@/lib/pulse";
import { usePulseStore } from "@/stores/usePulseStore";
import type { SessionConfig } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/* Fixtures are fully synthetic: this repo is public, so no real project
   paths appear here. */

const EMPTY_TRANSCRIPT: PulseTranscriptStats = {
  edits: 0,
  toolCalls: 0,
  testRuns: 0,
  testsPass: 0,
  testsFail: 0,
  hourly: {},
  repos: [],
  switches: 0,
  events: [],
};

function repoActivity(extra: Partial<PulseRepoActivity> = {}): PulseRepoActivity {
  return {
    repo: "alpha",
    path: "/tmp/alpha",
    commits: [],
    added: 0,
    removed: 0,
    files: [],
    dirty: 0,
    commitsByDate: {},
    ...extra,
  };
}

/** Routes each command to a canned answer; unknown commands reject loudly. */
function respond(handlers: Record<string, unknown>): void {
  invokeMock.mockImplementation((command: string) => {
    if (command in handlers) {
      const value = handlers[command];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    return Promise.reject(new Error(`unexpected command ${command}`));
  });
}

function tab(id: string, projectPath: string, selectedRepoPath: string | null = null) {
  return { id, name: id, projectPath, selectedRepoPath } as ReturnType<
    typeof useWorkspaceStore.getState
  >["tabs"][number];
}

describe("usePulseStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkspaceStore.setState({ tabs: [] });
    useSessionStore.setState({ sessions: [] });
    usePulseStore.setState({
      flowHistory: [],
      metrics: null,
      flow: null,
      activity: [],
      repos: [],
      reposAt: 0,
      reposKey: "",
      transcript: null,
      transcriptAt: 0,
      prs: [],
      prsAt: 0,
      prsKey: "",
      fetchedAt: 0,
      error: null,
      isRefreshing: false,
    });
  });

  it("asks git about one path per distinct checkout", async () => {
    useWorkspaceStore.setState({
      tabs: [
        tab("a", "/tmp/alpha"),
        // Second tab on the same checkout, and a tab whose selected repo wins.
        tab("b", "/tmp/alpha"),
        tab("c", "/tmp/beta-workspace", "/tmp/beta"),
      ],
    });
    respond({
      pulse_git_activity: [],
      pulse_transcript_stats: EMPTY_TRANSCRIPT,
      github_list_prs: [],
    });

    await usePulseStore.getState().refresh();

    const gitCall = invokeMock.mock.calls.find(([command]) => command === "pulse_git_activity");
    expect(gitCall?.[1]).toEqual({ repoPaths: ["/tmp/alpha", "/tmp/beta"], days: 14 });
  });

  it("scores the day and keeps the history the score came from", async () => {
    respond({
      pulse_git_activity: [
        repoActivity({ commits: [{ hash: "abc1234", time: "09:15", branch: "main" }] }),
      ],
      pulse_transcript_stats: { ...EMPTY_TRANSCRIPT, edits: 4, toolCalls: 20 },
      github_list_prs: [],
    });

    await usePulseStore.getState().refresh();

    const { metrics, flow, activity, flowHistory, fetchedAt, error } = usePulseStore.getState();
    expect(metrics?.shipped.commits).toBe(1);
    expect(flow?.today?.factors).toHaveLength(4);
    expect(activity[0].text).toContain("committed abc1234");
    expect(flowHistory).toHaveLength(14);
    expect(fetchedAt).toBeGreaterThan(0);
    expect(error).toBeNull();
  });

  it("counts a session that is blocked on you as waiting", async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 1,
          mode: "Claude",
          branch: null,
          worktree_path: null,
          project_path: "/tmp/alpha",
          status: "NeedsInput",
          needsInputPrompt: "Rebase or merge?",
          lastMcpUpdateTime: Date.now(),
        } as SessionConfig,
      ],
    });
    respond({
      pulse_git_activity: [],
      pulse_transcript_stats: EMPTY_TRANSCRIPT,
      github_list_prs: [],
    });

    await usePulseStore.getState().refresh();

    expect(usePulseStore.getState().metrics?.attention.waiting).toBe(1);
    expect(usePulseStore.getState().activity[0]?.text).toBe(
      "alpha raised a question — Rebase or merge?",
    );
  });

  it("keeps the last good numbers when a required source fails", async () => {
    respond({
      pulse_git_activity: [],
      pulse_transcript_stats: EMPTY_TRANSCRIPT,
      github_list_prs: [],
    });
    await usePulseStore.getState().refresh();
    const good = usePulseStore.getState().metrics;

    respond({ pulse_git_activity: new Error("git is not on PATH") });
    await usePulseStore.getState().refresh({ force: true });

    expect(usePulseStore.getState().metrics).toStrictEqual(good);
    expect(usePulseStore.getState().error).toContain("git is not on PATH");
  });

  it("says so when every repo's PR poll fails, and still scores the day", async () => {
    useWorkspaceStore.setState({ tabs: [tab("a", "/tmp/alpha")] });
    respond({
      pulse_git_activity: [],
      pulse_transcript_stats: EMPTY_TRANSCRIPT,
      github_list_prs: new Error("gh: not authenticated"),
    });

    await usePulseStore.getState().refresh();

    expect(usePulseStore.getState().error).toBe("Pull request counts unavailable (gh)");
    expect(usePulseStore.getState().metrics).not.toBeNull();
  });

  it("never leaves the refreshing flag stuck after a failure", async () => {
    respond({ pulse_git_activity: new Error("boom") });
    await usePulseStore.getState().refresh();
    expect(usePulseStore.getState().isRefreshing).toBe(false);
  });
});
