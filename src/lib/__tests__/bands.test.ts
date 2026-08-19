import { describe, expect, it } from "vitest";
import { assembleBands, type BandTab, type HandoffInfo, type RepoPrs } from "@/lib/bands";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/** Minimal live session; bands only read id/status/paths/prompt fields. */
function session(
  id: number,
  status: BackendSessionStatus,
  projectPath = "/repo/a",
  extra: Partial<SessionConfig> = {},
): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    worktree_path: null,
    project_path: projectPath,
    status,
    ...extra,
  } as SessionConfig;
}

function handoff(slug: string, extra: Partial<HandoffInfo> = {}): HandoffInfo {
  return {
    slug,
    path: `/repo/${slug}`,
    repo: slug,
    branch: "main",
    uncommitted: 0,
    lastCommit: null,
    asks: ["do the thing"],
    lastAction: "did a step",
    waiting: false,
    lastActive: "2026-08-19T08:00:00Z",
    stale: false,
    orphan: false,
    ...extra,
  };
}

function pr(number: number, extra: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number,
    title: `PR ${number}`,
    state: "OPEN",
    author: { login: "alex", name: null },
    createdAt: "2026-08-19T07:00:00Z",
    updatedAt: "2026-08-19T07:30:00Z",
    headRefName: "feat/x",
    baseRefName: "main",
    isDraft: false,
    additions: 1,
    deletions: 1,
    url: "https://example.test/pr",
    labels: [],
    mergedAt: null,
    closedAt: null,
    ...extra,
  } as PullRequestInfo;
}

const TABS: BandTab[] = [
  { id: "t1", name: "repo-a", projectPath: "/repo/a" },
  { id: "t2", name: "repo-b", projectPath: "/repo/b" },
];

describe("assembleBands", () => {
  it("routes session statuses to the right bands and counts the fleet", () => {
    const sessions = [
      session(1, "NeedsInput", "/repo/a", { needsInputPrompt: "pick one" }),
      session(2, "Working", "/repo/a"),
      session(3, "Done", "/repo/b"),
      session(4, "Error", "/repo/b"),
      session(5, "Idle", "/repo/b"),
      session(6, "Starting", "/repo/b"),
    ];
    const bands = assembleBands({
      sessions,
      tabs: TABS,
      handoffs: [],
      repoPrs: [],
      watermarkMs: 0,
    });

    expect(bands.blocked.map((i) => (i.kind === "session" ? i.session.id : -1))).toEqual([1, 4]);
    expect(bands.running.map((i) => (i.kind === "session" ? i.session.id : -1))).toEqual([2, 6]);
    expect(bands.landed.map((i) => (i.kind === "session" ? i.session.id : -1))).toEqual([3]);
    expect(bands.counts.NeedsInput).toBe(1);
    expect(bands.counts.Idle).toBe(1);
    // Idle sessions appear in no band, only in the counts.
    const allIds = [...bands.blocked, ...bands.running, ...bands.landed]
      .filter((i) => i.kind === "session")
      .map((i) => (i.kind === "session" ? i.session.id : -1));
    expect(allIds).not.toContain(5);
  });

  it("names the session's project via the tab list", () => {
    const bands = assembleBands({
      sessions: [session(1, "NeedsInput", "/repo/b")],
      tabs: TABS,
      handoffs: [],
      repoPrs: [],
      watermarkMs: 0,
    });
    const item = bands.blocked[0];
    expect(item.kind).toBe("session");
    if (item.kind === "session") {
      expect(item.projectName).toBe("repo-b");
      expect(item.tabId).toBe("t2");
    }
  });

  it("shows parked handoffs but drops stale, orphaned and session-covered ones", () => {
    const bands = assembleBands({
      sessions: [session(1, "Working", "/repo/covered")],
      tabs: TABS,
      handoffs: [
        handoff("fresh"),
        handoff("old", { stale: true }),
        handoff("gone", { orphan: true }),
        handoff("covered", { path: "/repo/covered" }),
      ],
      repoPrs: [],
      watermarkMs: 0,
    });
    const slugs = bands.blocked
      .filter((i) => i.kind === "handoff")
      .map((i) => (i.kind === "handoff" ? i.handoff.slug : ""));
    expect(slugs).toEqual(["fresh"]);
  });

  it("puts changes-requested PRs in blocked and fresh merges in landed, honouring the watermark", () => {
    const repoPrs: RepoPrs[] = [
      {
        repoPath: "/repo/a",
        projectName: "repo-a",
        changesRequested: [pr(10, { reviewDecision: "CHANGES_REQUESTED" })],
        merged: [
          pr(11, { state: "MERGED", mergedAt: "2026-08-19T09:00:00Z" }),
          pr(12, { state: "MERGED", mergedAt: "2026-08-01T09:00:00Z" }),
        ],
      },
    ];
    const bands = assembleBands({
      sessions: [],
      tabs: TABS,
      handoffs: [],
      repoPrs,
      watermarkMs: Date.parse("2026-08-10T00:00:00Z"),
    });
    const blockedPrs = bands.blocked
      .filter((i) => i.kind === "pr")
      .map((i) => (i.kind === "pr" ? i.pr.number : -1));
    const landedPrs = bands.landed
      .filter((i) => i.kind === "pr")
      .map((i) => (i.kind === "pr" ? i.pr.number : -1));
    expect(blockedPrs).toEqual([10]);
    expect(landedPrs).toEqual([11]);
  });

  it("orders blocked: needs-input, then errors, then PRs, then handoffs", () => {
    const bands = assembleBands({
      sessions: [session(2, "Error"), session(1, "NeedsInput")],
      tabs: TABS,
      handoffs: [handoff("h1")],
      repoPrs: [
        {
          repoPath: "/repo/a",
          projectName: "repo-a",
          changesRequested: [pr(10, { reviewDecision: "CHANGES_REQUESTED" })],
          merged: [],
        },
      ],
      watermarkMs: 0,
    });
    expect(bands.blocked.map((i) => i.kind)).toEqual(["session", "session", "pr", "handoff"]);
    const first = bands.blocked[0];
    expect(first.kind === "session" && first.session.status).toBe("NeedsInput");
  });
});
