import { describe, expect, it } from "vitest";
import {
  AGENT_H,
  agentNodeId,
  CLUSTER_W,
  layoutLandscape,
  PROJECT_W,
  projectNodeId,
  TERMINAL_W,
  terminalNodeId,
  type LayoutProject,
} from "../layout";

const oneProject: LayoutProject[] = [
  {
    tabId: "tab-1",
    terminals: [
      { sessionId: 1, agentIds: ["a1", "a2"] },
      { sessionId: 2, agentIds: [] },
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

  it("tiles several projects into a grid rather than one endless column", () => {
    const projects: LayoutProject[] = ["a", "b", "c", "d"].map((tabId) => ({
      tabId,
      terminals: [{ sessionId: Number(tabId.charCodeAt(0)), agentIds: [] }],
    }));
    const positions = layoutLandscape(projects);
    const xs = projects.map((p) => positions.get(projectNodeId(p.tabId))!.x);
    const ys = projects.map((p) => positions.get(projectNodeId(p.tabId))!.y);
    // 4 projects -> 2 columns, so two distinct x values and two distinct y values.
    expect(new Set(xs).size).toBe(2);
    expect(new Set(ys).size).toBe(2);
    // Neighbouring clusters never overlap horizontally.
    const [left, right] = [...new Set(xs)].sort((m, n) => m - n);
    expect(right - left).toBeGreaterThanOrEqual(CLUSTER_W);
  });

  it("handles a project with no terminals", () => {
    const positions = layoutLandscape([{ tabId: "empty", terminals: [] }]);
    expect(positions.get(projectNodeId("empty"))).toEqual({ x: 0, y: 0 });
  });

  it("returns nothing for no projects", () => {
    expect(layoutLandscape([]).size).toBe(0);
  });
});
