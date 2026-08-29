import { describe, expect, it } from "vitest";
import type { BandItem, HandoffInfo } from "@/lib/bands";
import {
  bandItemKey,
  CLOSED_BATCH_RETENTION_MS,
  type ClosedBatch,
  isPersistableSnoozeKey,
  MAX_CLOSED_BATCHES,
  parseSnoozeEntries,
  partitionSnoozed,
  projectDisplayName,
  pruneClosedBatches,
  pruneSnoozes,
  recordClosedBatch,
  removeSnooze,
  type SnoozeEntry,
  upsertSnooze,
} from "@/lib/sessionActions";
import type { SessionConfig } from "@/stores/useSessionStore";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function session(id: number): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "NeedsInput",
    worktree_path: null,
    project_path: "/repo",
  };
}

function sessionItem(id: number): BandItem {
  return { kind: "session", session: session(id), tabId: "tab-1", projectName: "repo" };
}

function handoff(slug: string): HandoffInfo {
  return {
    slug,
    path: "/repo",
    repo: "repo",
    branch: "main",
    uncommitted: 0,
    lastCommit: null,
    asks: [],
    lastAction: "Did a thing?",
    waiting: true,
    lastActive: new Date(NOW).toISOString(),
    stale: false,
    orphan: false,
  };
}

function handoffItem(slug: string): BandItem {
  return { kind: "handoff", handoff: handoff(slug) };
}

describe("bandItemKey", () => {
  it("distinguishes the four row kinds so keys never collide", () => {
    const keys = [bandItemKey(sessionItem(7)), bandItemKey(handoffItem("repo-main"))];
    expect(keys[0]).toBe("session:7");
    expect(keys[1]).toBe("handoff:repo-main");
    expect(new Set(keys).size).toBe(2);
  });

  it("is stable for the same row", () => {
    expect(bandItemKey(handoffItem("a"))).toBe(bandItemKey(handoffItem("a")));
  });
});

describe("isPersistableSnoozeKey", () => {
  /* Session ids are reassigned on every app launch — useSessionStore keeps
     parked/flagged ids in memory for exactly this reason. Persisting a
     session snooze would silence an unrelated future session that happens to
     reuse the number. */
  it("refuses session keys and accepts handoff keys", () => {
    expect(isPersistableSnoozeKey("session:7")).toBe(false);
    expect(isPersistableSnoozeKey("handoff:repo-main")).toBe(true);
  });
});

describe("snooze entry list", () => {
  it("upsert replaces an existing key rather than stacking duplicates", () => {
    const first = upsertSnooze([], "handoff:a", NOW + HOUR);
    const second = upsertSnooze(first, "handoff:a", NOW + 3 * HOUR);

    expect(second).toEqual([{ key: "handoff:a", untilMs: NOW + 3 * HOUR }]);
  });

  it("removeSnooze drops just the named key (unsnooze)", () => {
    const entries: SnoozeEntry[] = [
      { key: "handoff:a", untilMs: NOW + HOUR },
      { key: "handoff:b", untilMs: NOW + HOUR },
    ];

    expect(removeSnooze(entries, "handoff:a")).toEqual([{ key: "handoff:b", untilMs: NOW + HOUR }]);
  });

  it("pruneSnoozes drops entries whose deadline has passed, keeps the rest", () => {
    const entries: SnoozeEntry[] = [
      { key: "handoff:expired", untilMs: NOW - 1 },
      { key: "handoff:live", untilMs: NOW + HOUR },
    ];

    expect(pruneSnoozes(entries, NOW)).toEqual([{ key: "handoff:live", untilMs: NOW + HOUR }]);
  });

  it("treats a deadline exactly at now as expired (the row comes back)", () => {
    expect(pruneSnoozes([{ key: "handoff:a", untilMs: NOW }], NOW)).toEqual([]);
  });
});

describe("partitionSnoozed", () => {
  it("splits rows into visible and snoozed instead of hiding them silently", () => {
    const items = [handoffItem("a"), handoffItem("b"), sessionItem(3)];
    const entries: SnoozeEntry[] = [{ key: "handoff:b", untilMs: NOW + HOUR }];

    const { visible, snoozed } = partitionSnoozed(items, entries, NOW);

    expect(visible.map(bandItemKey)).toEqual(["handoff:a", "session:3"]);
    expect(snoozed.map(bandItemKey)).toEqual(["handoff:b"]);
  });

  it("an expired snooze puts the row back in visible", () => {
    const entries: SnoozeEntry[] = [{ key: "handoff:a", untilMs: NOW - 1 }];

    const { visible, snoozed } = partitionSnoozed([handoffItem("a")], entries, NOW);

    expect(visible).toHaveLength(1);
    expect(snoozed).toHaveLength(0);
  });
});

function batch(id: string, closedAtMs: number): ClosedBatch {
  return {
    id,
    closedAtMs,
    projectPath: `/repo-${id}`,
    projectName: `repo-${id}`,
    sessions: [
      {
        id: 1,
        name: null,
        mode: "Claude",
        projectPath: `/repo-${id}`,
        workingDirectory: `/repo-${id}`,
        branch: null,
      },
    ],
  };
}

describe("closed batches", () => {
  it("pruneClosedBatches drops anything past the retention window", () => {
    const fresh = batch("fresh", NOW - 1000);
    const old = batch("old", NOW - CLOSED_BATCH_RETENTION_MS - 1);

    expect(pruneClosedBatches([fresh, old], NOW).map((b) => b.id)).toEqual(["fresh"]);
  });

  it("recordClosedBatch puts the newest batch first", () => {
    const existing = [batch("first", NOW - 1000)];

    const next = recordClosedBatch(existing, batch("second", NOW), NOW);

    expect(next.map((b) => b.id)).toEqual(["second", "first"]);
  });

  it("recordClosedBatch caps the list at MAX_CLOSED_BATCHES", () => {
    let list: ClosedBatch[] = [];
    for (let i = 0; i < MAX_CLOSED_BATCHES + 3; i++) {
      list = recordClosedBatch(list, batch(`b${i}`, NOW), NOW);
    }

    expect(list).toHaveLength(MAX_CLOSED_BATCHES);
    // The oldest are the ones dropped.
    expect(list[0].id).toBe(`b${MAX_CLOSED_BATCHES + 2}`);
  });

  it("recordClosedBatch prunes expired batches while recording a new one", () => {
    const old = batch("old", NOW - CLOSED_BATCH_RETENTION_MS - 1);

    const next = recordClosedBatch([old], batch("new", NOW), NOW);

    expect(next.map((b) => b.id)).toEqual(["new"]);
  });
});

describe("parseSnoozeEntries", () => {
  it("round-trips a valid array", () => {
    const entries: SnoozeEntry[] = [{ key: "handoff:a", untilMs: NOW + HOUR }];
    expect(parseSnoozeEntries(JSON.stringify(entries))).toEqual(entries);
  });

  it("returns empty for null, corrupt JSON, and a non-array", () => {
    expect(parseSnoozeEntries(null)).toEqual([]);
    expect(parseSnoozeEntries("{not json")).toEqual([]);
    expect(parseSnoozeEntries('{"key":"handoff:a"}')).toEqual([]);
  });

  it("drops malformed entries but keeps the good ones alongside them", () => {
    const raw = JSON.stringify([
      { key: "handoff:good", untilMs: NOW + HOUR },
      { key: "handoff:no-deadline" },
      { untilMs: NOW + HOUR },
      { key: "handoff:nan", untilMs: "soon" },
      null,
    ]);

    expect(parseSnoozeEntries(raw)).toEqual([{ key: "handoff:good", untilMs: NOW + HOUR }]);
  });
});

describe("projectDisplayName", () => {
  it("takes the last path component", () => {
    expect(projectDisplayName("/Users/a/Repos/maestro")).toBe("maestro");
  });

  it("tolerates a trailing separator and Windows separators", () => {
    expect(projectDisplayName("/Users/a/Repos/maestro/")).toBe("maestro");
    expect(projectDisplayName("C:\\Users\\a\\maestro")).toBe("maestro");
  });

  it("falls back to the input when there is no component to take", () => {
    expect(projectDisplayName("/")).toBe("/");
    expect(projectDisplayName("")).toBe("");
  });
});
