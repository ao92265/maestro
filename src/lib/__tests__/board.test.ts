import { describe, expect, it } from "vitest";
import type { ActRun } from "@/lib/act";
import type { BandTab, HandoffInfo, RepoPrs } from "@/lib/bands";
import {
  ACT_STAGE_KEYWORDS,
  assembleBoard,
  type BoardCardItem,
  type BoardColumnKey,
  type BoardReviewRequests,
  inferActColumn,
  inferSessionColumn,
  needsYou,
} from "@/lib/board";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/** Minimal live session; board only reads id/status/paths/prompt fields. */
function session(
  id: number,
  status: BackendSessionStatus,
  projectPath = "/tmp/proj-a",
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
    path: `/tmp/proj-${slug}`,
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
    author: { login: "octo", name: null },
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

function run(id: string, extra: Partial<ActRun> = {}): ActRun {
  return {
    id,
    title: `Run ${id}`,
    status: "running",
    stage: null,
    stages: [],
    createdAt: "2026-08-19T06:00:00Z",
    updatedAt: "2026-08-19T06:30:00Z",
    repoUrl: null,
    error: null,
    ...extra,
  };
}

const TABS: BandTab[] = [
  { id: "t1", name: "proj-a", projectPath: "/tmp/proj-a" },
  { id: "t2", name: "proj-b", projectPath: "/tmp/proj-b" },
];

function cardsOf(
  columns: ReturnType<typeof assembleBoard>,
  column: BoardColumnKey,
): BoardCardItem[] {
  return columns[column];
}

const EMPTY = { sessions: [], tabs: [], handoffs: [], repoPrs: [], runs: [], watermarkMs: 0 };

describe("inferSessionColumn", () => {
  it.each([
    ["Starting", "planning"],
    ["Working", "building"],
    ["NeedsInput", "building"],
    ["Error", "building"],
    ["Timeout", "building"],
    ["Done", "done"],
    ["Idle", null],
  ] as [BackendSessionStatus, BoardColumnKey | null][])("%s -> %s", (status, expected) => {
    expect(inferSessionColumn(status)).toBe(expected);
  });
});

describe("inferActColumn", () => {
  // Table-driven against the exported keyword map itself, so the test can
  // never drift from the data the lib actually uses.
  for (const { column, keywords } of ACT_STAGE_KEYWORDS) {
    for (const keyword of keywords) {
      it(`"${keyword}" -> ${column}`, () => {
        expect(inferActColumn(keyword)).toBe(column);
      });
    }
  }

  it("falls back to building with an unrecognized stage name", () => {
    expect(inferActColumn("mystery-stage")).toBe("building");
  });

  it("falls back to building with a null stage", () => {
    expect(inferActColumn(null)).toBe("building");
  });

  it("matches case-insensitively", () => {
    expect(inferActColumn("PLAN")).toBe("planning");
  });

  // Realistic stage names, hardcoded on purpose: this table must NOT import
  // ACT_STAGE_KEYWORDS, so an edit that breaks the keyword map fails here
  // instead of auto-passing (review finding #2 on commit 024c112).
  it.each([
    ["implementation", "building"],
    ["code-review", "review"],
    ["qa-verify", "checking"],
    ["unit-tests", "checking"],
    ["pr-merge", "review"],
    ["PR", "review"],
    ["architect-spec", "planning"],
  ] as [string, BoardColumnKey][])("realistic stage %s -> %s", (stage, expected) => {
    expect(inferActColumn(stage)).toBe(expected);
  });

  // Two-letter keywords ("pr", "qa") must match whole tokens only: a stage
  // merely containing the letters inside a word is not that stage, and the
  // honest answer is the Building fallback with the raw text on the card.
  it.each([
    ["prepare"],
    ["preflight"],
    ["process"],
    ["quality"],
  ])("within-word hit %s stays in the building fallback", (stage) => {
    expect(inferActColumn(stage)).toBe("building");
  });
});

describe("needsYou", () => {
  it.each([
    ["NeedsInput", true],
    ["Error", true],
    ["Timeout", true],
    ["Working", false],
    ["Starting", false],
    ["Done", false],
    ["Idle", false],
  ] as [BackendSessionStatus, boolean][])("session %s -> %s", (status, expected) => {
    expect(needsYou({ kind: "session", status })).toBe(expected);
  });

  it("run: only a gated run needs you", () => {
    expect(needsYou({ kind: "run", gated: true })).toBe(true);
    expect(needsYou({ kind: "run", gated: false })).toBe(false);
  });

  it("pr: only changes-requested needs you, not a review request", () => {
    expect(needsYou({ kind: "pr", changesRequested: true })).toBe(true);
    expect(needsYou({ kind: "pr", changesRequested: false })).toBe(false);
  });

  it("handoff never needs you", () => {
    expect(needsYou({ kind: "handoff" })).toBe(false);
  });
});

describe("assembleBoard", () => {
  it("produces empty columns and zeroed counts on empty input", () => {
    const columns = assembleBoard(EMPTY);
    for (const key of [
      "suggested",
      "planning",
      "building",
      "checking",
      "review",
      "done",
    ] as const) {
      expect(columns[key]).toEqual([]);
    }
    expect(columns.moreHandoffs).toBe(0);
    expect(Object.values(columns.counts).every((n) => n === 0)).toBe(true);
  });

  it("routes session statuses to the right columns and counts the fleet, Idle producing no card", () => {
    const sessions = [
      session(1, "Starting"),
      session(2, "Working"),
      session(3, "NeedsInput"),
      session(4, "Error"),
      session(5, "Timeout"),
      session(6, "Done"),
      session(7, "Idle"),
    ];
    const columns = assembleBoard({ ...EMPTY, sessions, tabs: TABS });

    expect(
      cardsOf(columns, "planning").map((c) => (c.kind === "session" ? c.session.id : -1)),
    ).toEqual([1]);
    expect(
      cardsOf(columns, "building")
        .map((c) => (c.kind === "session" ? c.session.id : -1))
        .sort((a, b) => a - b),
    ).toEqual([2, 3, 4, 5]);
    expect(cardsOf(columns, "done").map((c) => (c.kind === "session" ? c.session.id : -1))).toEqual(
      [6],
    );

    const needsYouIds = [
      ...cardsOf(columns, "building"),
      ...cardsOf(columns, "planning"),
      ...cardsOf(columns, "done"),
    ]
      .filter((c) => c.kind === "session" && c.needsYou)
      .map((c) => (c.kind === "session" ? c.session.id : -1))
      .sort((a, b) => a - b);
    expect(needsYouIds).toEqual([3, 4, 5]);

    expect(columns.counts.Idle).toBe(1);
    const allCardIds = (
      ["suggested", "planning", "building", "checking", "review", "done"] as const
    )
      .flatMap((k) => columns[k])
      .filter((c): c is Extract<BoardCardItem, { kind: "session" }> => c.kind === "session")
      .map((c) => c.session.id);
    expect(allCardIds).not.toContain(7);
  });

  it("names the session's project via the tab list", () => {
    const columns = assembleBoard({
      ...EMPTY,
      sessions: [session(1, "Working", "/tmp/proj-b")],
      tabs: TABS,
    });
    const card = columns.building[0];
    expect(card.kind).toBe("session");
    expect(card.projectName).toBe("proj-b");
    if (card.kind === "session") expect(card.tabId).toBe("t2");
  });

  it("builds the session objective from needsInputPrompt, falling back to statusMessage then name", () => {
    const columns = assembleBoard({
      ...EMPTY,
      sessions: [
        session(1, "NeedsInput", "/tmp/proj-a", { needsInputPrompt: "pick a plan" }),
        session(2, "Working", "/tmp/proj-a", { statusMessage: "running tests" }),
        session(3, "Working", "/tmp/proj-a", { name: "custom-name" }),
      ],
      tabs: TABS,
    });
    const byId = (id: number) =>
      cardsOf(columns, "building")
        .concat()
        .find((c) => c.kind === "session" && c.session.id === id);
    expect(byId(1)?.objective).toBe("pick a plan");
    expect(byId(2)?.objective).toBe("running tests");
    expect(byId(3)?.objective).toBe("custom-name");
  });

  it("shows handoffs on disk in Suggested but drops stale, orphaned and session-covered ones", () => {
    const columns = assembleBoard({
      ...EMPTY,
      sessions: [session(1, "Working", "/tmp/proj-covered")],
      handoffs: [
        handoff("fresh"),
        handoff("old", { stale: true }),
        handoff("gone", { orphan: true }),
        handoff("covered", { path: "/tmp/proj-covered" }),
      ],
      tabs: TABS,
    });
    const slugs = columns.suggested.map((c) => (c.kind === "handoff" ? c.handoff.slug : ""));
    expect(slugs).toEqual(["fresh"]);
  });

  it("moves a handoff out of Suggested when an externally-running claude cwd sits at or under its path", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [handoff("nested"), handoff("exact")],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-nested/subdir", "/tmp/proj-exact"]),
    });
    expect(columns.suggested).toEqual([]);
    // Not hidden: the running work shows as a live card in Building (WP7).
    expect(columns.building.filter((c) => c.kind === "external").length).toBe(2);
  });

  it("does not exclude a handoff for an unrelated activeDirs cwd", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [handoff("fresh")],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-unrelated"]),
    });
    const slugs = columns.suggested.map((c) => (c.kind === "handoff" ? c.handoff.slug : ""));
    expect(slugs).toEqual(["fresh"]);
  });

  it("ignores a null or empty cwd entry in activeDirs", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [handoff("fresh")],
      tabs: TABS,
      activeDirs: new Set([null as unknown as string, ""]),
    });
    const slugs = columns.suggested.map((c) => (c.kind === "handoff" ? c.handoff.slug : ""));
    expect(slugs).toEqual(["fresh"]);
  });

  it("preserves current behaviour with an empty activeDirs set (regression guard)", () => {
    const input = { ...EMPTY, handoffs: [handoff("fresh")], tabs: TABS };
    const withoutField = assembleBoard(input);
    const withEmptySet = assembleBoard({ ...input, activeDirs: new Set<string>() });
    expect(withEmptySet).toEqual(withoutField);
  });

  it("keeps only the newest handoff per path and caps Suggested at 10", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      handoff(`h${i}`, {
        path: `/tmp/proj-h${i}`,
        lastActive: `2026-08-0${(i % 9) + 1}T08:00:00Z`,
      }),
    );
    const dupes = [
      handoff("dupe-old", { path: "/tmp/proj-same", lastActive: "2026-08-01T08:00:00Z" }),
      handoff("dupe-new", { path: "/tmp/proj-same", lastActive: "2026-08-18T08:00:00Z" }),
      handoff("dupe-mid", { path: "/tmp/proj-same", lastActive: "2026-08-10T08:00:00Z" }),
    ];
    const columns = assembleBoard({ ...EMPTY, handoffs: [...many, ...dupes], tabs: TABS });
    expect(columns.suggested.length).toBe(10);
    const slugs = columns.suggested.map((c) => (c.kind === "handoff" ? c.handoff.slug : ""));
    expect(slugs).toContain("dupe-new");
    expect(slugs).not.toContain("dupe-old");
    expect(slugs).not.toContain("dupe-mid");
    // 15 distinct paths survive dedup; 10 shown, 5 counted as hidden.
    expect(columns.moreHandoffs).toBe(5);
  });

  it("builds the handoff objective from the last ask while waiting, otherwise lastAction", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [
        handoff("waiting-one", {
          waiting: true,
          asks: ["first ask", "second ask"],
          lastAction: "stopped mid-step",
        }),
        handoff("not-waiting", { waiting: false, lastAction: "committed the fix" }),
      ],
      tabs: TABS,
    });
    const byslug = (slug: string) =>
      columns.suggested.find((c) => c.kind === "handoff" && c.handoff.slug === slug);
    expect(byslug("waiting-one")?.objective).toBe("second ask");
    expect(byslug("not-waiting")?.objective).toBe("committed the fix");
  });

  it("routes ACT runs by stage keyword across all four buckets", () => {
    const runs = [
      run("r-plan", { stage: "plan" }),
      run("r-build", { stage: "build" }),
      run("r-check", { stage: "test" }),
      run("r-review", { stage: "review" }),
    ];
    const columns = assembleBoard({ ...EMPTY, runs });
    expect(columns.planning.map((c) => (c.kind === "run" ? c.run.id : ""))).toEqual(["r-plan"]);
    expect(columns.building.map((c) => (c.kind === "run" ? c.run.id : ""))).toEqual(["r-build"]);
    expect(columns.checking.map((c) => (c.kind === "run" ? c.run.id : ""))).toEqual(["r-check"]);
    expect(columns.review.map((c) => (c.kind === "run" ? c.run.id : ""))).toEqual(["r-review"]);
  });

  it("falls back an unknown ACT stage to Building carrying the raw stage text", () => {
    const columns = assembleBoard({ ...EMPTY, runs: [run("r-mystery", { stage: "frobnicate" })] });
    expect(columns.building.length).toBe(1);
    const card = columns.building[0];
    expect(card.kind).toBe("run");
    expect(card.stageLabel).toBe("frobnicate");
  });

  it("falls back a null ACT stage to Building carrying the run status as the stage text", () => {
    const columns = assembleBoard({
      ...EMPTY,
      runs: [run("r-nostage", { stage: null, status: "running" })],
    });
    expect(columns.building.length).toBe(1);
    expect(columns.building[0].stageLabel).toBe("running");
  });

  it("flags a gated ACT run as needs-you without moving it out of its stage column", () => {
    const gated = run("r-gated", { stage: "test" });
    const columns = assembleBoard({ ...EMPTY, runs: [gated], gatedRuns: [gated] });
    expect(columns.checking.length).toBe(1);
    const card = columns.checking[0];
    expect(card.kind).toBe("run");
    expect(card.needsYou).toBe(true);
  });

  it("bounds Done ACT runs by the watermark and excludes non-success terminal runs", () => {
    const watermarkMs = Date.parse("2026-08-10T00:00:00Z");
    const runs = [
      run("r-old-done", { status: "completed", updatedAt: "2026-08-01T00:00:00Z" }),
      run("r-new-done", { status: "completed", updatedAt: "2026-08-19T00:00:00Z" }),
      run("r-failed", { status: "failed", updatedAt: "2026-08-19T00:00:00Z" }),
      run("r-cancelled", { status: "cancelled", updatedAt: "2026-08-19T00:00:00Z" }),
    ];
    const columns = assembleBoard({ ...EMPTY, runs, watermarkMs });
    expect(columns.done.map((c) => (c.kind === "run" ? c.run.id : ""))).toEqual(["r-new-done"]);
    const allCards = (
      ["suggested", "planning", "building", "checking", "review", "done"] as const
    ).flatMap((k) => columns[k]);
    expect(allCards.some((c) => c.kind === "run" && c.run.id === "r-old-done")).toBe(false);
    expect(allCards.some((c) => c.kind === "run" && c.run.id === "r-failed")).toBe(false);
    expect(allCards.some((c) => c.kind === "run" && c.run.id === "r-cancelled")).toBe(false);
  });

  it("puts changes-requested PRs in Review with needs-you, watchdog review-requests in Review without it", () => {
    const repoPrs: RepoPrs[] = [
      {
        repoPath: "/tmp/proj-a",
        projectName: "proj-a",
        changesRequested: [pr(10, { reviewDecision: "CHANGES_REQUESTED" })],
        merged: [],
      },
    ];
    const reviewRequests: BoardReviewRequests[] = [
      { repoPath: "/tmp/proj-b", projectName: "proj-b", reviewRequests: [pr(20)] },
    ];
    const columns = assembleBoard({ ...EMPTY, repoPrs, reviewRequests });
    expect(columns.review.length).toBe(2);
    const changesReq = columns.review.find((c) => c.kind === "pr" && c.pr.number === 10);
    const reviewReq = columns.review.find((c) => c.kind === "pr" && c.pr.number === 20);
    expect(changesReq?.needsYou).toBe(true);
    expect(reviewReq?.needsYou).toBe(false);
  });

  it("renders one Review card when the same PR is both changes-requested and review-requested", () => {
    // Both polls can surface the same PR (changesRequested is not
    // author-filtered; the watchdog lists review-requested:@me). One PR,
    // one card, and the needs-you version wins (review finding #1).
    const repoPrs: RepoPrs[] = [
      {
        repoPath: "/tmp/proj-a",
        projectName: "proj-a",
        changesRequested: [pr(10, { reviewDecision: "CHANGES_REQUESTED" })],
        merged: [],
      },
    ];
    const reviewRequests: BoardReviewRequests[] = [
      { repoPath: "/tmp/proj-a", projectName: "proj-a", reviewRequests: [pr(10)] },
    ];
    const columns = assembleBoard({ ...EMPTY, repoPrs, reviewRequests });
    expect(columns.review.length).toBe(1);
    expect(columns.review[0]?.needsYou).toBe(true);
  });

  it("keeps a same-numbered PR from a different repo as its own Review card", () => {
    const repoPrs: RepoPrs[] = [
      {
        repoPath: "/tmp/proj-a",
        projectName: "proj-a",
        changesRequested: [pr(10, { reviewDecision: "CHANGES_REQUESTED" })],
        merged: [],
      },
    ];
    const reviewRequests: BoardReviewRequests[] = [
      { repoPath: "/tmp/proj-b", projectName: "proj-b", reviewRequests: [pr(10)] },
    ];
    const columns = assembleBoard({ ...EMPTY, repoPrs, reviewRequests });
    expect(columns.review.length).toBe(2);
  });

  it("puts merged PRs in Done only once they cross the watermark", () => {
    const repoPrs: RepoPrs[] = [
      {
        repoPath: "/tmp/proj-a",
        projectName: "proj-a",
        changesRequested: [],
        merged: [
          pr(11, { state: "MERGED", mergedAt: "2026-08-19T09:00:00Z" }),
          pr(12, { state: "MERGED", mergedAt: "2026-08-01T09:00:00Z" }),
        ],
      },
    ];
    const columns = assembleBoard({
      ...EMPTY,
      repoPrs,
      watermarkMs: Date.parse("2026-08-10T00:00:00Z"),
    });
    expect(columns.done.map((c) => (c.kind === "pr" ? c.pr.number : -1))).toEqual([11]);
  });
});

describe("assembleBoard live outside-Maestro cards (WP7)", () => {
  it("shows a covered handoff as a Building card carrying its own last action", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [handoff("live", { lastAction: "rewiring the exporter" })],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-live"]),
    });
    expect(columns.suggested).toEqual([]);
    expect(columns.building.length).toBe(1);
    const card = columns.building[0];
    expect(card.kind).toBe("external");
    if (card.kind !== "external") return;
    expect(card.stageLabel).toBe("Live outside Vanguard");
    expect(card.objective).toBe("rewiring the exporter");
    expect(card.projectName).toBe("live");
    expect(card.needsYou).toBe(false);
    expect(card.since).toBe("2026-08-19T08:00:00Z");
    expect(card.dir).toBe("/tmp/proj-live");
    expect(card.handoff?.slug).toBe("live");
  });

  it("uses the last ask as the objective when the covered handoff stopped on a question", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [
        handoff("live", {
          waiting: true,
          asks: ["first ask", "second ask"],
          lastAction: "stopped mid-step",
        }),
      ],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-live"]),
    });
    const card = columns.building[0];
    expect(card.kind).toBe("external");
    expect(card.objective).toBe("second ask");
  });

  it("shows a live cwd with no handoff as a minimal card inventing nothing", () => {
    const columns = assembleBoard({
      ...EMPTY,
      tabs: TABS,
      activeDirs: new Set(["/tmp/mystery-dir"]),
    });
    expect(columns.building.length).toBe(1);
    const card = columns.building[0];
    expect(card.kind).toBe("external");
    if (card.kind !== "external") return;
    expect(card.projectName).toBe("mystery-dir");
    expect(card.objective).toBe("Working outside Vanguard");
    expect(card.stageLabel).toBe("Live outside Vanguard");
    expect(card.handoff).toBeNull();
    expect(card.since).toBeNull();
    expect(card.dir).toBe("/tmp/mystery-dir");
  });

  it("names a root-directory cwd by the directory itself, never blank", () => {
    const columns = assembleBoard({
      ...EMPTY,
      tabs: TABS,
      activeDirs: new Set(["/"]),
    });
    const card = columns.building[0];
    expect(card.kind).toBe("external");
    expect(card.projectName).toBe("/");
  });

  it("emits one card per live cwd when handoff paths nest, keeping the deepest", () => {
    /* One live process must not read as two live pieces of work. */
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [
        handoff("parent", { path: "/tmp/proj-a" }),
        handoff("child", { path: "/tmp/proj-a/sub" }),
      ],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-a/sub"]),
    });
    const externals = columns.building.filter((c) => c.kind === "external");
    expect(externals.length).toBe(1);
    const card = externals[0];
    if (card.kind !== "external") return;
    expect(card.dir).toBe("/tmp/proj-a/sub");
    expect(card.handoff?.slug).toBe("child");
    /* The parent handoff stays covered: not waiting in Suggested either. */
    expect(columns.suggested).toEqual([]);
  });

  it("shows one card when two live cwds sit under the same handoff", () => {
    /* Two processes in one project (a session and its subagent) are one
       piece of work; the header note still counts directories. */
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [handoff("shared", { path: "/tmp/proj-a" })],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-a/x", "/tmp/proj-a/y"]),
    });
    const externals = columns.building.filter((c) => c.kind === "external");
    expect(externals.length).toBe(1);
    if (externals[0].kind === "external") {
      expect(externals[0].handoff?.slug).toBe("shared");
      /* Both live cwds ride on the card so the peek can scope transcripts
         to the outside work, not the whole repo's. */
      expect(externals[0].cwds).toEqual(["/tmp/proj-a/x", "/tmp/proj-a/y"]);
    }
  });

  it("emits one card per covered handoff even when the cwd sits deeper than its path", () => {
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [handoff("deep")],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-deep/sub/dir"]),
    });
    const externals = columns.building.filter((c) => c.kind === "external");
    expect(externals.length).toBe(1);
    if (externals[0].kind === "external") expect(externals[0].dir).toBe("/tmp/proj-deep");
  });

  it("keeps moreHandoffs counting only handoffs actually waiting in Suggested", () => {
    const waiting = Array.from({ length: 12 }, (_, i) =>
      handoff(`w${i}`, { path: `/tmp/proj-w${i}` }),
    );
    const columns = assembleBoard({
      ...EMPTY,
      handoffs: [...waiting, handoff("live")],
      tabs: TABS,
      activeDirs: new Set(["/tmp/proj-live"]),
    });
    expect(columns.suggested.length).toBe(10);
    expect(columns.moreHandoffs).toBe(2);
    expect(columns.building.filter((c) => c.kind === "external").length).toBe(1);
  });
});
