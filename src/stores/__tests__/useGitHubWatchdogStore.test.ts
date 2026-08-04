import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// The persisted store hydrates through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out.
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

import type { IssueInfo, PullRequestInfo } from "../useGitHubStore";
import {
  diffNewItems,
  useGitHubWatchdogStore,
  type WatchdogProjectResult,
  type WatchdogSnapshot,
} from "../useGitHubWatchdogStore";

const invokeMock = vi.mocked(invoke);

function pr(number: number, title = `PR ${number}`): PullRequestInfo {
  return {
    number,
    title,
    state: "OPEN",
    author: { login: "someone" },
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    headRefName: "feature",
    baseRefName: "main",
    isDraft: false,
    additions: 1,
    deletions: 1,
    url: `https://github.com/o/r/pull/${number}`,
    labels: [],
    mergedAt: null,
    closedAt: null,
  };
}

function issue(number: number, title = `Issue ${number}`): IssueInfo {
  return {
    number,
    title,
    state: "OPEN",
    author: { login: "someone" },
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    closedAt: null,
  };
}

function project(
  repoPath: string,
  reviewRequests: PullRequestInfo[] = [],
  assignedIssues: IssueInfo[] = []
): WatchdogProjectResult {
  return { name: repoPath.split("/").pop() ?? repoPath, repoPath, reviewRequests, assignedIssues };
}

function snapshot(
  projects: WatchdogProjectResult[],
  polledAt = 1000
): WatchdogSnapshot {
  return { status: "ok", projects, polledAt };
}

describe("diffNewItems", () => {
  it("reports nothing when there is no previous result (first poll)", () => {
    const next = project("C:/git/maestro", [pr(1)], [issue(2)]);
    expect(diffNewItems(undefined, next)).toEqual({ newPrs: [], newIssues: [] });
  });

  it("reports only items absent from the previous result", () => {
    const prev = project("C:/git/maestro", [pr(1)], [issue(10)]);
    const next = project("C:/git/maestro", [pr(1), pr(2)], [issue(10), issue(11)]);
    const diff = diffNewItems(prev, next);
    expect(diff.newPrs.map((p) => p.number)).toEqual([2]);
    expect(diff.newIssues.map((i) => i.number)).toEqual([11]);
  });

  it("reports nothing when items only disappear", () => {
    const prev = project("C:/git/maestro", [pr(1), pr(2)], [issue(10)]);
    const next = project("C:/git/maestro", [pr(1)], []);
    expect(diffNewItems(prev, next)).toEqual({ newPrs: [], newIssues: [] });
  });
});

describe("useGitHubWatchdogStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useGitHubWatchdogStore.setState({
      notificationsEnabled: true,
      status: "ok",
      projects: [],
      lastPolledAt: null,
      toasts: [],
    });
  });

  it("stores the snapshot without toasts on the first poll", () => {
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(2)])]));

    const state = useGitHubWatchdogStore.getState();
    expect(state.projects).toHaveLength(1);
    expect(state.lastPolledAt).toBe(1000);
    expect(state.toasts).toEqual([]);
  });

  it("queues toasts only for items that appeared since the previous poll", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(10)])]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(
        snapshot([project("C:/git/maestro", [pr(1), pr(2, "New PR")], [issue(10)])], 2000)
      );

    const { toasts } = useGitHubWatchdogStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: "pr",
      number: 2,
      title: "New PR",
      projectName: "maestro",
      url: "https://github.com/o/r/pull/2",
    });
  });

  it("does not toast for a project seen for the first time mid-run", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])]));
    // A second project appears (tab opened): its items are not "new work".
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(
        snapshot(
          [project("C:/git/maestro", [pr(1)]), project("C:/git/other", [pr(7)], [issue(8)])],
          2000
        )
      );
    expect(useGitHubWatchdogStore.getState().toasts).toEqual([]);
  });

  it("mutes toasts when notifications are disabled but still updates data", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])]));
    store.setNotificationsEnabled(false);
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1), pr(2)])], 2000));

    const state = useGitHubWatchdogStore.getState();
    expect(state.toasts).toEqual([]);
    expect(state.projects[0].reviewRequests).toHaveLength(2);
    expect(state.lastPolledAt).toBe(2000);
  });

  it("disabling notifications clears queued toasts", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro")]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])], 2000));
    expect(useGitHubWatchdogStore.getState().toasts).toHaveLength(1);

    useGitHubWatchdogStore.getState().setNotificationsEnabled(false);
    expect(useGitHubWatchdogStore.getState().toasts).toEqual([]);
  });

  it("dismissToast removes only the given toast", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro")]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(2)])], 2000));
    const { toasts } = useGitHubWatchdogStore.getState();
    expect(toasts).toHaveLength(2);

    useGitHubWatchdogStore.getState().dismissToast(toasts[0].id);
    const remaining = useGitHubWatchdogStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(toasts[1].id);
  });

  it("records the gh status from the snapshot", () => {
    useGitHubWatchdogStore
      .getState()
      .applySnapshot({ status: "gh-missing", projects: [], polledAt: 500 });
    expect(useGitHubWatchdogStore.getState().status).toBe("gh-missing");
  });

  it("syncProjects forwards the project set to the backend command", async () => {
    const projects = [{ name: "maestro", repoPath: "C:/git/maestro" }];
    await useGitHubWatchdogStore.getState().syncProjects(projects);
    expect(invokeMock).toHaveBeenCalledWith("github_watchdog_set_projects", { projects });
  });
});
