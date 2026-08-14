/**
 * Deterministic layout for the landscape graph.
 *
 * Same input always produces the same picture — that is the whole point of the
 * "Reorganize" button: after dragging nodes around, one click puts every node
 * back where it belongs and it lands in the *same* place every time. (A
 * force-directed/physics layout would look organic but settle differently on
 * every run, so a second click would never reproduce the first.)
 *
 * Shape per project ("cluster"): the project node on the left, its terminals
 * stacked in the middle column, and each terminal's subagent tree branching
 * to the right beside it — one further column per nesting depth, since an
 * agent can spawn agents of its own. Clusters are stacked in ONE column, so
 * every project node lines up on the left and everything branches out to the
 * right.
 */

export interface XY {
  x: number;
  y: number;
}

/** One agent and the agents it spawned, in render order. */
export interface LayoutAgent {
  id: string;
  children: LayoutAgent[];
}

/** One terminal and its root agents (the ones it spawned), in render order. */
export interface LayoutTerminal {
  sessionId: number;
  agents: LayoutAgent[];
}

/** One project and its terminals, in render order. */
export interface LayoutProject {
  tabId: string;
  terminals: LayoutTerminal[];
}

/* ── Node sizes (px). Exported so the node components and the layout agree. ── */
export const PROJECT_W = 236;
export const PROJECT_H = 84;
export const TERMINAL_W = 232;
export const TERMINAL_H = 76;
export const AGENT_W = 252;
export const AGENT_H = 104;

/* ── Gaps (px) ── */
/** Between the project, terminal and agent columns. */
const COL_GAP = 84;
/** Between two agents of the same terminal. */
const AGENT_GAP = 14;
/** Between two terminal rows of the same project. */
const TERMINAL_GAP = 28;
/** Between neighbouring project clusters. */
const CLUSTER_GAP_Y = 80;

/** Node id helpers — also the identity used to persist manual positions. */
export const projectNodeId = (tabId: string) => `project:${tabId}`;
export const terminalNodeId = (sessionId: number) => `terminal:${sessionId}`;
export const agentNodeId = (sessionId: number, agentId: string) => `agent:${sessionId}:${agentId}`;

/** Height of one agent's whole subtree: itself or its stacked children. */
function agentSubtreeHeight(agent: LayoutAgent): number {
  if (agent.children.length === 0) return AGENT_H;
  const children =
    agent.children.reduce((sum, child) => sum + agentSubtreeHeight(child), 0) +
    (agent.children.length - 1) * AGENT_GAP;
  return Math.max(AGENT_H, children);
}

/** Height of one terminal's row: the taller of the terminal and its agent trees. */
function rowHeight(terminal: LayoutTerminal): number {
  const n = terminal.agents.length;
  const agentsH =
    n === 0
      ? 0
      : terminal.agents.reduce((sum, agent) => sum + agentSubtreeHeight(agent), 0) +
        (n - 1) * AGENT_GAP;
  return Math.max(TERMINAL_H, agentsH);
}

/** Height of a whole project cluster (all its terminal rows stacked). */
function clusterHeight(project: LayoutProject): number {
  const rows = project.terminals.map(rowHeight);
  if (rows.length === 0) return PROJECT_H;
  const sum = rows.reduce((a, b) => a + b, 0);
  return Math.max(PROJECT_H, sum + (rows.length - 1) * TERMINAL_GAP);
}

/**
 * Position every node of every project.
 *
 * Returns a map keyed by the node ids above; a caller that has no position for
 * a node (shouldn't happen) can fall back to the origin.
 */
export function layoutLandscape(projects: LayoutProject[]): Map<string, XY> {
  const positions = new Map<string, XY>();
  if (projects.length === 0) return positions;

  const heights = projects.map(clusterHeight);

  // One cluster per row: every project sits in the same left column and its
  // terminals/agents branch out to the right of it.
  const rowTops: number[] = [];
  let y = 0;
  for (const height of heights) {
    rowTops.push(y);
    y += height + CLUSTER_GAP_Y;
  }

  projects.forEach((project, index) => {
    const originX = 0;
    const originY = rowTops[index];
    const height = heights[index];

    // Project node: vertically centred against its own terminal stack.
    positions.set(projectNodeId(project.tabId), {
      x: originX,
      y: originY + (height - PROJECT_H) / 2,
    });

    const terminalX = originX + PROJECT_W + COL_GAP;
    const agentX = terminalX + TERMINAL_W + COL_GAP;

    let cursorY = originY;
    for (const terminal of project.terminals) {
      const rowH = rowHeight(terminal);
      positions.set(terminalNodeId(terminal.sessionId), {
        x: terminalX,
        y: cursorY + (rowH - TERMINAL_H) / 2,
      });

      const n = terminal.agents.length;
      const agentsH =
        n === 0
          ? 0
          : terminal.agents.reduce((sum, agent) => sum + agentSubtreeHeight(agent), 0) +
            (n - 1) * AGENT_GAP;
      // Nested agents go one column further right per depth, each node
      // centered against its own subtree — same shape as the session graph.
      const placeAgent = (agent: LayoutAgent, depth: number, top: number) => {
        const height = agentSubtreeHeight(agent);
        positions.set(agentNodeId(terminal.sessionId, agent.id), {
          x: agentX + depth * (AGENT_W + COL_GAP),
          y: top + (height - AGENT_H) / 2,
        });
        let childTop = top;
        for (const child of agent.children) {
          placeAgent(child, depth + 1, childTop);
          childTop += agentSubtreeHeight(child) + AGENT_GAP;
        }
      };
      let agentY = cursorY + (rowH - agentsH) / 2;
      for (const agent of terminal.agents) {
        placeAgent(agent, 0, agentY);
        agentY += agentSubtreeHeight(agent) + AGENT_GAP;
      }

      cursorY += rowH + TERMINAL_GAP;
    }
  });

  return positions;
}
