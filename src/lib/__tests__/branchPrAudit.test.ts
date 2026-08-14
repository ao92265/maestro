import { describe, expect, it } from "vitest";
import { type BranchPr, findPrForBranch, formatRelativeTime, prBadge } from "../branchPrAudit";

function pr(overrides: Partial<BranchPr> = {}): BranchPr {
  return {
    number: 1,
    state: "OPEN",
    headRefName: "feature-x",
    authorLogin: "octocat",
    createdAt: "2026-01-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    url: "https://example.com/pr/1",
    ...overrides,
  };
}

describe("findPrForBranch", () => {
  it("matches a local branch by exact name", () => {
    const prs = [pr({ headRefName: "feature-x" })];
    expect(findPrForBranch(prs, "feature-x", false)?.number).toBe(1);
  });

  it("matches a remote branch by stripping the remote prefix", () => {
    const prs = [pr({ headRefName: "feature-x" })];
    expect(findPrForBranch(prs, "origin/feature-x", true)?.number).toBe(1);
  });

  it("returns undefined when no PR matches", () => {
    const prs = [pr({ headRefName: "other-branch" })];
    expect(findPrForBranch(prs, "feature-x", false)).toBeUndefined();
  });

  it("prefers the open PR when a branch has multiple PRs", () => {
    const prs = [
      pr({
        number: 1,
        headRefName: "feature-x",
        state: "CLOSED",
        createdAt: "2026-01-02T00:00:00Z",
      }),
      pr({ number: 2, headRefName: "feature-x", state: "OPEN", createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(findPrForBranch(prs, "feature-x", false)?.number).toBe(2);
  });

  it("falls back to the most recently created match when none are open", () => {
    const prs = [
      pr({
        number: 1,
        headRefName: "feature-x",
        state: "CLOSED",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      pr({
        number: 2,
        headRefName: "feature-x",
        state: "MERGED",
        createdAt: "2026-01-05T00:00:00Z",
      }),
    ];
    expect(findPrForBranch(prs, "feature-x", false)?.number).toBe(2);
  });

  it("does not match a remote branch's short name against an unrelated local PR head", () => {
    // "upstream/feature-x" strips to "feature-x" — must not accidentally
    // match a PR head named "x" or the literal "upstream/feature-x".
    const prs = [pr({ headRefName: "upstream/feature-x" })];
    expect(findPrForBranch(prs, "upstream/feature-x", true)).toBeUndefined();
  });
});

describe("prBadge", () => {
  const noopRelative = () => "3d ago";

  it("labels a merged PR with the relative merge date and author", () => {
    const badge = prBadge(
      pr({ number: 42, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", authorLogin: "alice" }),
      noopRelative,
    );
    expect(badge).toEqual({ label: "PR #42 merged 3d ago by alice", tone: "merged" });
  });

  it("labels an open PR with the author, no date", () => {
    const badge = prBadge(pr({ number: 7, state: "OPEN", authorLogin: "bob" }), noopRelative);
    expect(badge).toEqual({ label: "PR #7 open by bob", tone: "open" });
  });

  it("labels a closed (not merged) PR with just the number", () => {
    const badge = prBadge(pr({ number: 9, state: "CLOSED" }), noopRelative);
    expect(badge).toEqual({ label: "PR #9 closed", tone: "closed" });
  });

  it("is case-insensitive on state", () => {
    const badge = prBadge(
      pr({ number: 3, state: "merged", mergedAt: "2026-01-01T00:00:00Z" }),
      noopRelative,
    );
    expect(badge.tone).toBe("merged");
  });
});

describe("formatRelativeTime", () => {
  it("returns an empty string for an unparsable date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });

  it("returns 'just now' for a timestamp in the last minute", () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe("just now");
  });

  it("returns a day-granularity age for a multi-day-old timestamp", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe("3d ago");
  });
});
