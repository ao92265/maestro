import { describe, expect, it } from "vitest";

import {
  buildGoalPrompt,
  buildOrchestratorBrief,
  buildScopeNote,
  isProposalExpired,
  isTargetInScope,
  PROPOSAL_TTL_MS,
  type Proposal,
  proposalPreview,
  type ScopeEntry,
} from "../orchestrator";

const SCOPE: ScopeEntry[] = [
  { sessionId: 7, label: "maestro — feat/orchestrator" },
  { sessionId: 9, label: "vanguard — main" },
];

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    targetSessionId: 7,
    text: "run the tests",
    key: null,
    note: "its suite has been red since the last commit",
    status: "pending",
    at: new Date("2026-08-28T10:00:00.000Z").toISOString(),
    error: null,
    ...over,
  };
}

describe("proposal expiry", () => {
  const at = Date.parse("2026-08-28T10:00:00.000Z");

  it("leaves a pending proposal alive inside its TTL", () => {
    expect(isProposalExpired(proposal(), at + PROPOSAL_TTL_MS - 1)).toBe(false);
  });

  it("expires a pending proposal once the TTL has passed", () => {
    expect(isProposalExpired(proposal(), at + PROPOSAL_TTL_MS + 1)).toBe(true);
  });

  it("never expires a proposal that already left the pending state", () => {
    // An approved-but-undispatched proposal is the frontend's to finish; the
    // TTL only governs how long a decision may be OUTSTANDING.
    for (const status of ["approved", "sent", "rejected", "blocked", "error"] as const) {
      expect(isProposalExpired(proposal({ status }), at + PROPOSAL_TTL_MS * 10)).toBe(false);
    }
  });

  it("keeps an unparseable timestamp visible rather than guessing it stale", () => {
    expect(isProposalExpired(proposal({ at: "not a date" }), at + PROPOSAL_TTL_MS * 10)).toBe(
      false,
    );
  });
});

describe("scope enforcement", () => {
  it("admits a target the operator ticked", () => {
    expect(isTargetInScope(7, SCOPE)).toBe(true);
  });

  it("refuses a target the operator did not tick", () => {
    expect(isTargetInScope(4, SCOPE)).toBe(false);
  });

  it("admits every target when no scope is set", () => {
    // Empty scope is "all sessions", matching the rohcna contract — it is not
    // a deny-all, or the first goal of every session would be undeliverable.
    expect(isTargetInScope(4, [])).toBe(true);
  });
});

describe("buildScopeNote", () => {
  it("is empty when nothing is scoped", () => {
    expect(buildScopeNote([])).toBe("");
  });

  it("names every scoped session and its id", () => {
    const note = buildScopeNote(SCOPE);
    expect(note).toContain("maestro — feat/orchestrator");
    expect(note).toContain("vanguard — main");
    expect(note).toContain("7");
    expect(note).toContain("9");
    expect(note).toMatch(/only/i);
  });
});

describe("buildOrchestratorBrief", () => {
  const brief = buildOrchestratorBrief("/Users/x/.maestro/orchestrator/proposals", SCOPE);

  it("tells the agent where to drop proposals", () => {
    expect(brief).toContain("/Users/x/.maestro/orchestrator/proposals");
  });

  it("documents the write-then-rename drop so a half-written file is never read", () => {
    expect(brief).toMatch(/\.tmp/);
    expect(brief).toMatch(/rename|mv\b/i);
  });

  it("states that a proposal is queued for approval, not sent", () => {
    expect(brief).toMatch(/approve/i);
  });

  it("forbids driving sessions by any route other than a proposal", () => {
    expect(brief).toMatch(/never/i);
    expect(brief).toContain("targetSessionId");
  });

  it("carries the scope roster so the agent knows which ids exist", () => {
    expect(brief).toContain("maestro — feat/orchestrator");
  });
});

describe("buildGoalPrompt", () => {
  it("passes an unscoped goal through with no scope preamble", () => {
    expect(buildGoalPrompt("get PR 12 merged", [])).toBe("get PR 12 merged");
  });

  it("prefixes a scoped goal with the scope restriction", () => {
    const prompt = buildGoalPrompt("get PR 12 merged", SCOPE);
    expect(prompt).toContain("get PR 12 merged");
    expect(prompt).toMatch(/only/i);
    expect(prompt.indexOf("maestro — feat/orchestrator")).toBeLessThan(
      prompt.indexOf("get PR 12 merged"),
    );
  });

  it("trims the operator's goal", () => {
    expect(buildGoalPrompt("  tidy up  ", [])).toBe("tidy up");
  });
});

describe("proposalPreview", () => {
  it("renders message text as-is", () => {
    expect(proposalPreview(proposal())).toBe("run the tests");
  });

  it("marks a control key so it is never mistaken for typed text", () => {
    expect(proposalPreview(proposal({ text: "", key: "Escape" }))).toContain("Escape");
    expect(proposalPreview(proposal({ text: "", key: "Escape" }))).not.toBe("Escape");
  });
});
