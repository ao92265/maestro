import { describe, expect, it } from "vitest";
import type { SubagentInfo } from "@/stores/useAgentStore";
import { buildAgentTree, flattenAgentTree } from "../agentTree";

function agent(agentId: string, overrides?: Partial<SubagentInfo>): SubagentInfo {
  return {
    agentId,
    sessionId: 1,
    agentType: "Explore",
    description: "",
    prompt: "",
    runInBackground: false,
    parentAgentId: null,
    spawnedAt: "2026-08-07T10:00:00.000Z",
    completedAt: null,
    success: null,
    report: "",
    status: null,
    model: null,
    durationMs: null,
    totalTokens: null,
    toolUseCount: null,
    toolStats: null,
    agentRunId: null,
    ...overrides,
  };
}

describe("buildAgentTree", () => {
  it("nests children under their parent, to any depth", () => {
    const tree = buildAgentTree([
      agent("root"),
      agent("child", { parentAgentId: "root", spawnedAt: "2026-08-07T10:01:00.000Z" }),
      agent("grandchild", { parentAgentId: "child", spawnedAt: "2026-08-07T10:02:00.000Z" }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent.agentId).toBe("root");
    expect(tree[0].depth).toBe(1);
    expect(tree[0].children[0].agent.agentId).toBe("child");
    expect(tree[0].children[0].depth).toBe(2);
    expect(tree[0].children[0].children[0].agent.agentId).toBe("grandchild");
    expect(tree[0].children[0].children[0].depth).toBe(3);
  });

  it("orders siblings by spawn time", () => {
    const tree = buildAgentTree([
      agent("late", { spawnedAt: "2026-08-07T10:05:00.000Z" }),
      agent("early", { spawnedAt: "2026-08-07T10:01:00.000Z" }),
    ]);
    expect(tree.map((n) => n.agent.agentId)).toEqual(["early", "late"]);
  });

  it("parks a child whose parent is not on the graph at the root", () => {
    const tree = buildAgentTree([agent("lost", { parentAgentId: "dismissed" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent.agentId).toBe("lost");
    expect(tree[0].depth).toBe(1);
  });

  it("degrades corrupt linkage (self-parent, cycles) to root placement", () => {
    const tree = buildAgentTree([
      agent("selfie", { parentAgentId: "selfie" }),
      agent("ouro", { parentAgentId: "boros", spawnedAt: "2026-08-07T10:01:00.000Z" }),
      agent("boros", { parentAgentId: "ouro", spawnedAt: "2026-08-07T10:02:00.000Z" }),
    ]);
    // Every agent renders exactly once, whatever the linkage claims.
    const ids = flattenAgentTree(tree).map((n) => n.agent.agentId);
    expect([...ids].sort()).toEqual(["boros", "ouro", "selfie"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("flattens depth-first, parents before children", () => {
    const flat = flattenAgentTree(
      buildAgentTree([
        agent("a"),
        agent("a1", { parentAgentId: "a", spawnedAt: "2026-08-07T10:01:00.000Z" }),
        agent("b", { spawnedAt: "2026-08-07T10:02:00.000Z" }),
      ]),
    );
    expect(flat.map((n) => n.agent.agentId)).toEqual(["a", "a1", "b"]);
  });
});
