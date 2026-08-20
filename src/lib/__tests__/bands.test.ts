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

  it("excludes a handoff when an externally-running claude cwd sits at or under its path", () => {
    const bands = assembleBands({
      sessions: [],
      tabs: TABS,
      handoffs: [handoff("nested"), handoff("exact")],
      repoPrs: [],
      watermarkMs: 0,
      activeDirs: new Set(["/repo/nested/subdir", "/repo/exact"]),
    });
    const slugs = bands.blocked
      .filter((i) => i.kind === "handoff")
      .map((i) => (i.kind === "handoff" ? i.handoff.slug : ""));
    expect(slugs).toEqual([]);
  });

  it("does not exclude a handoff for an unrelated activeDirs cwd", () => {
    const bands = assembleBands({
      sessions: [],
      tabs: TABS,
      handoffs: [handoff("fresh")],
      repoPrs: [],
      watermarkMs: 0,
      activeDirs: new Set(["/repo/unrelated"]),
    });
    const slugs = bands.blocked
      .filter((i) => i.kind === "handoff")
      .map((i) => (i.kind === "handoff" ? i.handoff.slug : ""));
    expect(slugs).toEqual(["fresh"]);
  });

  it("ignores a null or empty cwd entry in activeDirs", () => {
    const bands = assembleBands({
      sessions: [],
      tabs: TABS,
      handoffs: [handoff("fresh")],
      repoPrs: [],
      watermarkMs: 0,
      activeDirs: new Set([null as unknown as string, ""]),
    });
    const slugs = bands.blocked
      .filter((i) => i.kind === "handoff")
      .map((i) => (i.kind === "handoff" ? i.handoff.slug : ""));
    expect(slugs).toEqual(["fresh"]);
  });

  it("preserves current behaviour with an empty activeDirs set (regression guard)", () => {
    const input = {
      sessions: [],
      tabs: TABS,
      handoffs: [handoff("fresh")],
      repoPrs: [],
      watermarkMs: 0,
    };
    const withoutField = assembleBands(input);
    const withEmptySet = assembleBands({ ...input, activeDirs: new Set<string>() });
    expect(withEmptySet).toEqual(withoutField);
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

  it("keeps only the newest handoff per path and caps the band at 10", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      handoff(`h${i}`, { lastActive: `2026-08-0${(i % 9) + 1}T08:00:00Z` }),
    );
    // Three snapshots of the same directory, different ages: newest wins.
    const dupes = [
      handoff("dupe-old", { path: "/repo/same", lastActive: "2026-08-01T08:00:00Z" }),
      handoff("dupe-new", { path: "/repo/same", lastActive: "2026-08-18T08:00:00Z" }),
      handoff("dupe-mid", { path: "/repo/same", lastActive: "2026-08-10T08:00:00Z" }),
    ];
    const bands = assembleBands({
      sessions: [],
      tabs: TABS,
      handoffs: [...many, ...dupes],
      repoPrs: [],
      watermarkMs: 0,
    });
    const shown = bands.blocked.filter((i) => i.kind === "handoff");
    expect(shown.length).toBe(10);
    const slugs = shown.map((i) => (i.kind === "handoff" ? i.handoff.slug : ""));
    expect(slugs).toContain("dupe-new");
    expect(slugs).not.toContain("dupe-old");
    expect(slugs).not.toContain("dupe-mid");
    // 15 distinct paths survive dedup; 10 shown, 5 counted as hidden.
    expect(bands.moreHandoffs).toBe(5);
  });

  it("puts confidence-gated ACT runs in blocked, after sessions, before PRs", () => {
    const gated = [
      {
        id: "run-1",
        title: "Build the widget",
        status: "running",
        stage: "verify",
        stages: [],
        createdAt: null,
        updatedAt: null,
        repoUrl: null,
        error: null,
      },
    ];
    const bands = assembleBands({
      sessions: [session(1, "NeedsInput")],
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
      gatedRuns: gated,
      watermarkMs: 0,
    });
    expect(bands.blocked.map((i) => i.kind)).toEqual(["session", "run", "pr", "handoff"]);
    const runItem = bands.blocked[1];
    expect(runItem.kind === "run" && runItem.run.id).toBe("run-1");
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
