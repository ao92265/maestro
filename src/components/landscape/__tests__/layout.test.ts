import { describe, expect, it } from "vitest";
import {
  AGENT_H,
  AGENT_W,
  agentNodeId,
  layoutLandscape,
  PROJECT_W,
  projectNodeId,
  TERMINAL_W,
  terminalNodeId,
  type LayoutAgent,
  type LayoutProject,
} from "../layout";

const leaf = (id: string): LayoutAgent => ({ id, children: [] });

const oneProject: LayoutProject[] = [
  {
    tabId: "tab-1",
    terminals: [
      { sessionId: 1, agents: [leaf("a1"), leaf("a2")] },
      { sessionId: 2, agents: [] },
    ],
  },
];

describe("layoutLandscape", () => {
  it("positions a node for every project, terminal and agent", () => {
    const positions = layoutLandscape(oneProject);
    expect(positions.has(projectNodeId("tab-1"))).toBe(true);
    expect(positions.has(terminalNodeId(1))).toBe(true);
    expect(positions.has(terminalNodeId(2))).toBe(true);
    expect(positions.has(agentNodeId(1, "a1"))).toBe(true);
    expect(positions.has(agentNodeId(1, "a2"))).toBe(true);
    expect(positions.size).toBe(5);
  });

  it("is deterministic — the Reorganize button must land nodes in the same place twice", () => {
    const first = layoutLandscape(oneProject);
    const second = layoutLandscape(oneProject);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("orders the columns project -> terminal -> agent, left to right", () => {
    const positions = layoutLandscape(oneProject);
    const project = positions.get(projectNodeId("tab-1"))!;
    const terminal = positions.get(terminalNodeId(1))!;
    const agent = positions.get(agentNodeId(1, "a1"))!;
    expect(terminal.x).toBeGreaterThanOrEqual(project.x + PROJECT_W);
    expect(agent.x).toBeGreaterThanOrEqual(terminal.x + TERMINAL_W);
  });

  it("stacks a terminal's agents without overlapping", () => {
    const positions = layoutLandscape(oneProject);
    const first = positions.get(agentNodeId(1, "a1"))!;
    const second = positions.get(agentNodeId(1, "a2"))!;
    expect(second.x).toBe(first.x);
    expect(second.y - first.y).toBeGreaterThanOrEqual(AGENT_H);
  });

  it("keeps a terminal's own agents beside it and the next terminal below", () => {
    const positions = layoutLandscape(oneProject);
    const busyTerminal = positions.get(terminalNodeId(1))!;
    const idleTerminal = positions.get(terminalNodeId(2))!;
    const lastAgent = positions.get(agentNodeId(1, "a2"))!;
    expect(idleTerminal.x).toBe(busyTerminal.x);
    // The second terminal must clear the first terminal's whole agent stack.
    expect(idleTerminal.y).toBeGreaterThan(lastAgent.y);
  });

  it("nests a child agent one column right of its parent, without overlap", () => {
    const nested: LayoutProject[] = [
      {
        tabId: "tab-1",
        terminals: [
          {
            sessionId: 1,
            agents: [{ id: "parent", children: [leaf("kid1"), leaf("kid2")] }, leaf("solo")],
          },
        ],
      },
    ];
    const positions = layoutLandscape(nested);
    const parent = positions.get(agentNodeId(1, "parent"))!;
    const kid1 = positions.get(agentNodeId(1, "kid1"))!;
    const kid2 = positions.get(agentNodeId(1, "kid2"))!;
    const solo = positions.get(agentNodeId(1, "solo"))!;
    // Children sit one full column to the right of their parent.
    expect(kid1.x).toBeGreaterThanOrEqual(parent.x + AGENT_W);
    expect(kid2.x).toBe(kid1.x);
    expect(kid2.y - kid1.y).toBeGreaterThanOrEqual(AGENT_H);
    // The parent is centered against its two children.
    expect(parent.y).toBeGreaterThan(kid1.y);
    expect(parent.y).toBeLessThan(kid2.y);
    // The next root clears the whole subtree above it.
    expect(solo.x).toBe(parent.x);
    expect(solo.y).toBeGreaterThanOrEqual(kid2.y + AGENT_H);
  });

  it("stacks every project in one column, top to bottom", () => {
    const projects: LayoutProject[] = ["a", "b", "c", "d"].map((tabId) => ({
      tabId,
      terminals: [{ sessionId: Number(tabId.charCodeAt(0)), agents: [] }],
    }));
    const positions = layoutLandscape(projects);
    const xs = projects.map((p) => positions.get(projectNodeId(p.tabId))!.x);
    const ys = projects.map((p) => positions.get(projectNodeId(p.tabId))!.y);
    // Every project node shares the same x; rows descend without overlapping.
    expect(new Set(xs).size).toBe(1);
    expect(new Set(ys).size).toBe(4);
    const sorted = [...ys].sort((m, n) => m - n);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(0);
    }
  });

  it("handles a project with no terminals", () => {
    const positions = layoutLandscape([{ tabId: "empty", terminals: [] }]);
    expect(positions.get(projectNodeId("empty"))).toEqual({ x: 0, y: 0 });
  });

  it("returns nothing for no projects", () => {
    expect(layoutLandscape([]).size).toBe(0);
  });
});
