import { describe, expect, it } from "vitest";
import {
  buildSpark,
  computeActivity,
  computeFlowScore,
  computeMetrics,
  countPrsOn,
  flowTier,
  flowWord,
  type PulseInputs,
  type PulseRepoActivity,
  type PulseSession,
  type PulseTranscriptStats,
  pulseDateString,
  scoreFromCommits,
  toPulseSessions,
} from "@/lib/pulse";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { SessionConfig } from "@/stores/useSessionStore";

/** Empty transcript scan — the shape Rust returns when nothing ran today. */
function transcript(extra: Partial<PulseTranscriptStats> = {}): PulseTranscriptStats {
  return {
    edits: 0,
    toolCalls: 0,
    testRuns: 0,
    testsPass: 0,
    testsFail: 0,
    hourly: {},
    repos: [],
    switches: 0,
    events: [],
    ...extra,
  };
}

function repo(name: string, extra: Partial<PulseRepoActivity> = {}): PulseRepoActivity {
  return {
    repo: name,
    path: `/Users/alex/Repos/${name}`,
    commits: [],
    added: 0,
    removed: 0,
    files: [],
    dirty: 0,
    commitsByDate: {},
    ...extra,
  };
}

function session(id: number, extra: Partial<PulseSession> = {}): PulseSession {
  return {
    id,
    repo: "maestro",
    waiting: false,
    stale: false,
    lastActive: 0,
    lastAction: "",
    ...extra,
  };
}

function inputs(extra: Partial<PulseInputs> = {}): PulseInputs {
  return {
    repos: [],
    transcript: transcript(),
    sessions: [],
    prs: { opened: 0, merged: 0 },
    now: new Date("2026-08-28T14:30:00"),
    ...extra,
  };
}

describe("flow tiers", () => {
  it("names each band at its boundary", () => {
    expect(flowTier(0)).toBe("scattered");
    expect(flowTier(29)).toBe("scattered");
    expect(flowTier(30)).toBe("steady");
    expect(flowTier(59)).toBe("steady");
    expect(flowTier(60)).toBe("flow");
    expect(flowTier(79)).toBe("flow");
    expect(flowTier(80)).toBe("deep");
    expect(flowTier(100)).toBe("deep");
  });

  it("reads the same boundaries out as words", () => {
    expect(flowWord(0)).toBe("Scattered");
    expect(flowWord(30)).toBe("Steady");
    expect(flowWord(60)).toBe("In flow");
    expect(flowWord(80)).toBe("Deep");
  });
});

describe("scoreFromCommits", () => {
  it("scores 15 a commit and caps at 100", () => {
    expect(scoreFromCommits(0)).toBe(0);
    expect(scoreFromCommits(3)).toBe(45);
    expect(scoreFromCommits(7)).toBe(100);
  });
});

describe("buildSpark", () => {
  it("spans the busiest hours, labelled 12-hour", () => {
    const spark = buildSpark([[9, 9, 11]], { 9: 12, 10: 3, 11: 7 });
    expect(spark.hours).toEqual(["9a", "10a", "11a"]);
    expect(spark.activity).toEqual([12, 3, 7]);
    expect(spark.commits).toEqual([2, 0, 1]);
  });

  it("falls back to 7-11 when nothing was logged", () => {
    const spark = buildSpark([], {});
    expect(spark.hours).toEqual(["7a", "8a", "9a", "10a", "11a"]);
    expect(spark.activity).toEqual([0, 0, 0, 0, 0]);
  });

  it("never emits more than 8 columns", () => {
    const hourly: Record<number, number> = {};
    for (let h = 0; h < 20; h++) hourly[h] = h;
    expect(buildSpark([], hourly).hours).toHaveLength(8);
  });

  it("labels afternoon hours with p", () => {
    expect(buildSpark([], { 13: 4 }).hours).toEqual(["1p"]);
  });
});

describe("computeMetrics", () => {
  it("adds up commits, churn and touched files across repos", () => {
    const metrics = computeMetrics(
      inputs({
        repos: [
          repo("maestro", {
            commits: [{ hash: "abc1234", time: "09:15", branch: "main" }],
            added: 40,
            removed: 12,
            files: ["src/a.ts", "src/b.ts"],
            dirty: 3,
          }),
          repo("rohcna", {
            commits: [
              { hash: "def5678", time: "11:02", branch: "feat/x" },
              { hash: "999aaaa", time: "11:40", branch: "feat/x" },
            ],
            added: 5,
            removed: 0,
            // Same relative name as maestro's: paths must keep them apart.
            files: ["src/a.ts"],
            dirty: 0,
          }),
        ],
        prs: { opened: 2, merged: 1 },
        sessions: [session(1, { waiting: true }), session(2)],
        transcript: transcript({
          edits: 6,
          toolCalls: 44,
          testRuns: 2,
          testsPass: 30,
          testsFail: 1,
        }),
      }),
    );

    expect(metrics.shipped).toEqual({ commits: 3, prsOpened: 2, prsMerged: 1 });
    expect(metrics.touched).toEqual({ files: 3, added: 45, removed: 12 });
    expect(metrics.activity).toEqual({
      edits: 6,
      testRuns: 2,
      testsPass: 30,
      testsFail: 1,
      toolCalls: 44,
    });
    expect(metrics.attention).toEqual({ waiting: 1, dirtyTrees: 1 });
    expect(metrics.headline).toEqual({ commits: 3, prs: 2, repos: 2, waiting: 1 });
  });

  it("counts a repo as touched when a transcript saw it but nothing landed", () => {
    const metrics = computeMetrics(
      inputs({
        repos: [repo("maestro")],
        transcript: transcript({ repos: ["nanoclaw", "maestro"], switches: 4 }),
      }),
    );
    expect(metrics.headline.repos).toBe(2);
    expect(metrics.focus).toEqual({ active: 0, repos: 2, switches: 4 });
  });

  it("does not count stale sessions as active", () => {
    const metrics = computeMetrics(inputs({ sessions: [session(1), session(2, { stale: true })] }));
    expect(metrics.focus.active).toBe(1);
  });

  it("dates the report in the local calendar", () => {
    expect(computeMetrics(inputs()).date).toBe("Fri, Aug 28");
  });
});

describe("computeFlowScore", () => {
  /** Two repos with commits on the 27th, for the backfill path. */
  const yesterdayRepos = [repo("maestro", { commitsByDate: { "2026-08-27": 2 } })];

  it("blends the four factors by their published weights", () => {
    const { flow } = computeFlowScore(
      inputs({
        repos: [
          repo("maestro", {
            commits: [
              { hash: "a", time: "09:00", branch: "main" },
              { hash: "b", time: "10:00", branch: "main" },
              { hash: "c", time: "11:00", branch: "main" },
            ],
          }),
        ],
        prs: { opened: 1, merged: 1 },
        sessions: [session(1, { waiting: true }), session(2), session(3), session(4)],
        transcript: transcript({ edits: 5, toolCalls: 30, switches: 2, repos: ["a", "b", "c"] }),
      }),
      [],
    );

    // Focus 100-2*8-1*5=79 · Shipping 3*12+2*20=76 · Responsiveness 100-25%*60=85
    // Momentum 5*4+30=50 → .3*79+.3*76+.2*85+.2*50 = 73.5
    expect(flow.factors.map((f) => f.raw)).toEqual([79, 76, 85, 50]);
    expect(flow.score).toBe(74);
    expect(flow.tier).toBe("flow");
    expect(flow.word).toBe("In flow");
    expect(flow.explain).toBe(
      "Weighted blend: Focus 30%, Shipping 30%, Responsiveness 20%, Momentum 20%.",
    );
  });

  it("explains every factor in words, not just a bar", () => {
    const { flow } = computeFlowScore(
      inputs({
        prs: { opened: 1, merged: 0 },
        repos: [repo("maestro", { commits: [{ hash: "a", time: "09:00", branch: "main" }] })],
        sessions: [session(1, { waiting: true })],
        transcript: transcript({ edits: 2, toolCalls: 9, switches: 1, repos: ["maestro"] }),
      }),
      [],
    );
    expect(flow.factors.map((f) => [f.label, f.detail])).toEqual([
      ["Focus", "1 repo, 1 switch"],
      ["Shipping", "1 commit, 1 PR"],
      ["Responsiveness", "1 waiting"],
      ["Momentum", "2 edits, 9 tool calls"],
    ]);
    expect(flow.factors.map((f) => f.weight)).toEqual([0.3, 0.3, 0.2, 0.2]);
  });

  it("floors focus and responsiveness at zero", () => {
    const { flow } = computeFlowScore(
      inputs({
        sessions: [session(1, { waiting: true }), session(2, { waiting: true })],
        transcript: transcript({ switches: 40, repos: ["a", "b", "c", "d"] }),
      }),
      [],
    );
    expect(flow.factors[0].raw).toBe(0);
    expect(flow.factors[2].raw).toBe(40);
  });

  it("caps shipping and momentum at 100", () => {
    const { flow } = computeFlowScore(
      inputs({
        prs: { opened: 5, merged: 5 },
        transcript: transcript({ edits: 60, toolCalls: 900 }),
      }),
      [],
    );
    expect(flow.factors[1].raw).toBe(100);
    expect(flow.factors[3].raw).toBe(100);
  });

  it("upserts today's score into the history it is handed", () => {
    const { history } = computeFlowScore(
      inputs({ transcript: transcript({ edits: 5, toolCalls: 20 }) }),
      [{ date: "2026-08-28", score: 3 }],
    );
    const today = history.filter((h) => h.date === "2026-08-28");
    expect(today).toHaveLength(1);
    expect(today[0].score).toBeGreaterThan(3);
  });

  it("backfills a missing day from that day's commit count, and keeps it", () => {
    const { flow, history } = computeFlowScore(inputs({ repos: yesterdayRepos }), []);
    // 2 commits on the 27th → 30. An idle today still scores 50 (nothing is
    // switching or blocked), so the day reads as up on yesterday.
    expect(history.find((h) => h.date === "2026-08-27")?.score).toBe(30);
    expect(flow.delta).toBe("+20 vs yest.");
    expect(flow.deltaDirection).toBe("up");
  });

  it("prefers a persisted score over a backfill for the same day", () => {
    const { history } = computeFlowScore(inputs({ repos: yesterdayRepos }), [
      { date: "2026-08-27", score: 88 },
    ]);
    expect(history.filter((h) => h.date === "2026-08-27")).toEqual([
      { date: "2026-08-27", score: 88 },
    ]);
  });

  it("calls the very first run a first day rather than a drop", () => {
    const { flow } = computeFlowScore(inputs(), []);
    expect(flow.delta).toBe("first day");
    expect(flow.deltaDirection).toBe("none");
  });

  it("counts a streak of consecutive scoring days up to today", () => {
    const { flow } = computeFlowScore(
      inputs({
        repos: [repo("maestro", { commits: [{ hash: "a", time: "09:00", branch: "main" }] })],
      }),
      [
        { date: "2026-08-26", score: 40 },
        { date: "2026-08-27", score: 50 },
      ],
    );
    expect(flow.streak).toBe(3);
  });

  it("breaks the streak on a blank day", () => {
    const { flow } = computeFlowScore(
      inputs({
        repos: [repo("maestro", { commits: [{ hash: "a", time: "09:00", branch: "main" }] })],
      }),
      [
        { date: "2026-08-26", score: 40 },
        { date: "2026-08-27", score: 0 },
      ],
    );
    expect(flow.streak).toBe(1);
  });

  it("averages the week over its scoring days only", () => {
    const { flow } = computeFlowScore(inputs(), [
      { date: "2026-08-26", score: 40 },
      { date: "2026-08-27", score: 60 },
    ]);
    expect(flow.wkActive).toBe(3);
    expect(flow.wkAvg).toBe(50);
    expect(flow.wkBest).toBe(60);
  });

  it("returns 7 trend bars and a 14-day heatmap ending today", () => {
    const { flow } = computeFlowScore(inputs(), []);
    expect(flow.trend).toHaveLength(7);
    expect(flow.heat).toHaveLength(14);
    expect(flow.trend[6].date).toBe("2026-08-28");
    expect(flow.heat[13].date).toBe("2026-08-28");
    expect(flow.heat[0].date).toBe("2026-08-15");
  });

  it("scales trend bars against the best day in the window", () => {
    const { flow } = computeFlowScore(inputs(), [
      { date: "2026-08-27", score: 80 },
      { date: "2026-08-26", score: 40 },
    ]);
    expect(flow.trend[5].heightPct).toBe(100);
    expect(flow.trend[4].heightPct).toBe(50);
  });

  it("marks a blank heat cell as having no tier", () => {
    const { flow } = computeFlowScore(inputs(), []);
    expect(flow.heat[0].tier).toBeNull();
    expect(flow.heat[0].ring).toBe(false);
  });

  it("rings a heat cell only from 70 up", () => {
    const { flow } = computeFlowScore(inputs(), [
      { date: "2026-08-27", score: 70 },
      { date: "2026-08-26", score: 69 },
    ]);
    expect(flow.heat[12].ring).toBe(true);
    expect(flow.heat[11].ring).toBe(false);
  });

  it("leads with the shipping insight on a heavy commit day", () => {
    const { flow } = computeFlowScore(
      inputs({
        repos: [
          repo("maestro", {
            commits: [
              { hash: "a", time: "09:00", branch: "main" },
              { hash: "b", time: "10:00", branch: "main" },
              { hash: "c", time: "11:00", branch: "main" },
            ],
          }),
        ],
      }),
      [],
    );
    expect(flow.insight).toBe("Strong shipping day — 3 commits landed.");
  });

  it("falls back to a neutral insight when nothing stands out", () => {
    const { flow } = computeFlowScore(
      inputs({
        repos: [repo("maestro", { commits: [{ hash: "a", time: "09:00", branch: "main" }] })],
        prs: { opened: 1, merged: 1 },
        transcript: transcript({ edits: 8, toolCalls: 20 }),
      }),
      [],
    );
    expect(flow.insight).toBe("Keep your current pace through the rest of the day.");
  });

  it("keeps at most 40 days of history", () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ date: `2026-06-${i}`, score: 10 }));
    const { history } = computeFlowScore(inputs(), long);
    expect(history.length).toBeLessThanOrEqual(40);
    expect(history.some((h) => h.date === "2026-08-28")).toBe(true);
  });
});

describe("computeActivity", () => {
  it("turns today's commits into timeline rows", () => {
    const events = computeActivity(
      inputs({
        repos: [
          repo("maestro", { commits: [{ hash: "abc1234def", time: "09:15", branch: "feat/x" }] }),
        ],
      }),
    );
    expect(events).toEqual([
      { kind: "commit", time: "9:15a", text: "maestro — committed abc1234 on feat/x" },
    ]);
  });

  it("omits the branch when the commit carries no ref", () => {
    const events = computeActivity(
      inputs({
        repos: [repo("maestro", { commits: [{ hash: "abc1234def", time: "13:05", branch: "" }] })],
      }),
    );
    expect(events[0].text).toBe("maestro — committed abc1234");
    expect(events[0].time).toBe("1:05p");
  });

  it("surfaces a waiting session as a question", () => {
    const events = computeActivity(
      inputs({
        sessions: [
          session(1, {
            repo: "nanoclaw",
            waiting: true,
            lastActive: new Date("2026-08-28T10:02:00").getTime(),
            lastAction: "Which branch should this land on?",
          }),
        ],
      }),
    );
    expect(events).toEqual([
      {
        kind: "question",
        time: "10:02a",
        text: "nanoclaw raised a question — Which branch should this land on?",
      },
    ]);
  });

  it("ignores stale sessions and sessions that are not waiting", () => {
    const events = computeActivity(
      inputs({
        sessions: [
          session(1, { waiting: true, stale: true, lastActive: 1 }),
          session(2, { waiting: false, lastActive: 1 }),
        ],
      }),
    );
    expect(events).toEqual([]);
  });

  it("keeps the newest event first", () => {
    const events = computeActivity(
      inputs({
        repos: [
          repo("maestro", {
            commits: [
              { hash: "aaaaaaa", time: "08:00", branch: "main" },
              { hash: "bbbbbbb", time: "16:00", branch: "main" },
            ],
          }),
        ],
        transcript: transcript({
          events: [
            {
              ts: new Date("2026-08-28T12:00:00").getTime(),
              kind: "stopHook",
              text: "Stop hook passed",
            },
          ],
        }),
      }),
    );
    expect(events.map((e) => e.time)).toEqual(["4:00p", "12:00p", "8:00a"]);
  });

  it("caps the timeline at 40 rows", () => {
    const commits = Array.from({ length: 60 }, (_, i) => ({
      hash: `hash${i}`,
      time: `${String(Math.floor(i / 4)).padStart(2, "0")}:0${i % 4}`,
      branch: "main",
    }));
    expect(computeActivity(inputs({ repos: [repo("maestro", { commits })] }))).toHaveLength(40);
  });
});

describe("pulseDateString", () => {
  it("formats a local calendar date, never a UTC one", () => {
    expect(pulseDateString(new Date("2026-01-05T23:30:00"))).toBe("2026-01-05");
  });
});

describe("toPulseSessions", () => {
  const NOW = new Date("2026-08-28T14:30:00").getTime();

  function live(extra: Partial<SessionConfig> = {}): SessionConfig {
    return {
      id: 1,
      mode: "Claude",
      branch: null,
      worktree_path: null,
      project_path: "/Users/alex/Repos/maestro",
      status: "Working",
      ...extra,
    } as SessionConfig;
  }

  it("reads the repo off the directory the shell actually runs in", () => {
    const [session] = toPulseSessions(
      [live({ worktree_path: "/Users/alex/Repos/.worktrees/feat-x", working_directory: null })],
      NOW,
    );
    expect(session.repo).toBe("feat-x");
  });

  it("prefers the working directory in a multi-repo workspace", () => {
    const [session] = toPulseSessions(
      [live({ working_directory: "/Users/alex/Repos/maestro/packages/cli" })],
      NOW,
    );
    expect(session.repo).toBe("cli");
  });

  it("counts only NeedsInput as waiting, and carries the question", () => {
    const [needsInput, done] = toPulseSessions(
      [
        live({ id: 1, status: "NeedsInput", needsInputPrompt: "Rebase or merge?" }),
        live({ id: 2, status: "Done", statusMessage: "Tests green" }),
      ],
      NOW,
    );
    expect(needsInput.waiting).toBe(true);
    expect(needsInput.lastAction).toBe("Rebase or merge?");
    expect(done.waiting).toBe(false);
    expect(done.lastAction).toBe("Tests green");
  });

  it("treats a live session as never stale, and dates a silent one now", () => {
    const [session] = toPulseSessions([live()], NOW);
    expect(session.stale).toBe(false);
    expect(session.lastActive).toBe(NOW);
  });

  it("keeps the MCP timestamp when there is one", () => {
    const [session] = toPulseSessions([live({ lastMcpUpdateTime: 1234 })], NOW);
    expect(session.lastActive).toBe(1234);
  });
});

describe("countPrsOn", () => {
  function pr(number: number, createdAt: string, mergedAt: string | null = null): PullRequestInfo {
    return { number, createdAt, mergedAt } as PullRequestInfo;
  }

  it("counts opens and merges that fall on the given local day", () => {
    const counts = countPrsOn(
      [
        pr(1, "2026-08-28T08:00:00Z"),
        pr(2, "2026-08-27T08:00:00Z", "2026-08-28T09:00:00Z"),
        pr(3, "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z"),
      ],
      "2026-08-28",
    );
    expect(counts).toEqual({ opened: 1, merged: 1 });
  });

  it("counts a PR opened and merged the same day in both", () => {
    const counts = countPrsOn(
      [pr(1, "2026-08-28T08:00:00Z", "2026-08-28T11:00:00Z")],
      "2026-08-28",
    );
    expect(counts).toEqual({ opened: 1, merged: 1 });
  });

  it("ignores an unparseable timestamp rather than counting it", () => {
    expect(countPrsOn([pr(1, "not a date")], "2026-08-28")).toEqual({ opened: 0, merged: 0 });
  });
});
