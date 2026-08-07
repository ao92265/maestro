import type { SubagentInfo } from "@/stores/useAgentStore";

/** One agent with the agents it spawned, in spawn order. */
export interface AgentTreeNode {
  agent: SubagentInfo;
  children: AgentTreeNode[];
  /** 1 for agents the session itself spawned, +1 per nesting level. */
  depth: number;
}

/**
 * Arrange one session's agents into their spawn tree.
 *
 * `parentAgentId` names the spawning agent's tool_use id. A parent that is
 * not on the graph — dismissed, or its spawn simply not seen yet, since
 * subagent transcripts are discovered in arbitrary order — parks the child at
 * the root rather than hiding it; the tree self-corrects once the parent's
 * spawn arrives. Corrupt linkage (self-parent, cycles) degrades to root
 * placement the same way, so every agent is always rendered exactly once.
 *
 * Siblings are ordered by spawn timestamp, so positions stay stable as new
 * agents append.
 */
export function buildAgentTree(agents: SubagentInfo[]): AgentTreeNode[] {
  const sorted = [...agents].sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
  const ids = new Set(sorted.map((a) => a.agentId));

  const roots: SubagentInfo[] = [];
  const childrenOf = new Map<string, SubagentInfo[]>();
  for (const agent of sorted) {
    const parent = agent.parentAgentId;
    if (parent === null || parent === agent.agentId || !ids.has(parent)) {
      roots.push(agent);
    } else {
      const siblings = childrenOf.get(parent);
      if (siblings) siblings.push(agent);
      else childrenOf.set(parent, [agent]);
    }
  }

  const visited = new Set<string>();
  const build = (agent: SubagentInfo, depth: number): AgentTreeNode => {
    visited.add(agent.agentId);
    return {
      agent,
      depth,
      children: (childrenOf.get(agent.agentId) ?? [])
        .filter((child) => !visited.has(child.agentId))
        .map((child) => build(child, depth + 1)),
    };
  };

  const nodes = roots.map((root) => build(root, 1));
  // Agents trapped in a parent cycle are reachable from no root; show them
  // at the root instead of silently dropping them.
  for (const agent of sorted) {
    if (!visited.has(agent.agentId)) nodes.push(build(agent, 1));
  }
  return nodes;
}

/** Depth-first flatten, parents before children — the graphs' render order. */
export function flattenAgentTree(roots: AgentTreeNode[]): AgentTreeNode[] {
  const out: AgentTreeNode[] = [];
  const walk = (node: AgentTreeNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}
