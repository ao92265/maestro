import type { SamuraiWorkflowEdge, SamuraiWorkflowGraph, SamuraiWorkflowNode } from "@/lib/samurai";

/**
 * Pure graph edits behind the workflow editor canvas
 * (`src/components/workflows/WorkflowsView.tsx`), kept in their own
 * module so consumers that only need the walk rule — the PR monitor's step
 * checkboxes, for one — do not pull React Flow into their bundle.
 *
 * They mirror the backend compile rule
 * (`src-tauri/src/core/samurai_workflow.rs`): the walk starts at `start`,
 * follows the FIRST outgoing edge in edge-list order, and stops at a missing
 * target or a revisit. That rule is why:
 *  - deleting a NODE bridges its incoming edges to its first outgoing target
 *    (prev → next) — removal skips the step instead of truncating the walk;
 *  - deleting an EDGE deliberately truncates: everything past the cut stays
 *    visible but leaves the run (rendered dimmed, "not in run").
 */

/** Node ids the compile walk reaches, in walk order (the backend rule). */
export function workflowWalkOrder(graph: SamuraiWorkflowGraph): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = graph.start;
  while (current !== undefined) {
    const node = graph.nodes.find((n) => n.id === current);
    if (!node || visited.has(node.id)) break;
    visited.add(node.id);
    order.push(node.id);
    current = graph.edges.find((e) => e.from === node.id)?.to;
  }
  return order;
}

/**
 * Removes a node and auto-bridges around it: every edge INTO the node is
 * rewritten to the node's first outgoing target (the edge the compile walk
 * would have left through), in place, so edge-list order — and with it the
 * walk — is preserved. Bridges that would self-loop or duplicate an
 * existing pair are dropped. A removed start node hands `start` to its
 * bridge target (else the first remaining node), keeping the walk alive.
 */
export function removeWorkflowNode(graph: SamuraiWorkflowGraph, id: string): SamuraiWorkflowGraph {
  const next = graph.edges.find((e) => e.from === id)?.to ?? null;
  const edges: SamuraiWorkflowEdge[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    let kept: SamuraiWorkflowEdge | null;
    if (edge.from === id) kept = null;
    else if (edge.to === id) {
      kept = next !== null && next !== edge.from ? { from: edge.from, to: next } : null;
    } else kept = edge;
    if (!kept) continue;
    const key = `${kept.from}\0${kept.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(kept);
  }
  const nodes = graph.nodes.filter((n) => n.id !== id);
  const start = graph.start === id ? (next ?? nodes[0]?.id ?? "") : graph.start;
  return { nodes, edges, start };
}

/** Removes one edge — the user's explicit "cut the run short here". */
export function removeWorkflowEdge(
  graph: SamuraiWorkflowGraph,
  from: string,
  to: string,
): SamuraiWorkflowGraph {
  const index = graph.edges.findIndex((e) => e.from === from && e.to === to);
  if (index === -1) return graph;
  return { ...graph, edges: graph.edges.filter((_, i) => i !== index) };
}

/**
 * Rewires `from` to point at `to`. Any previous outgoing edges of `from`
 * are dropped: the compile walk only ever follows the first one, so keeping
 * extras would be invisible state the editor cannot show honestly.
 */
export function connectWorkflow(
  graph: SamuraiWorkflowGraph,
  from: string,
  to: string,
): SamuraiWorkflowGraph {
  if (from === to) return graph;
  return { ...graph, edges: [...graph.edges.filter((e) => e.from !== from), { from, to }] };
}

/** Points the walk's entry at another node (the START pill was rewired). */
export function setWorkflowStart(graph: SamuraiWorkflowGraph, id: string): SamuraiWorkflowGraph {
  return graph.start === id ? graph : { ...graph, start: id };
}

/** Replaces one node's text. */
export function setWorkflowNodeText(
  graph: SamuraiWorkflowGraph,
  id: string,
  text: string,
): SamuraiWorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, text } : n)),
  };
}

/** Replaces one node's short label (PR review workflow boxes only). */
export function setWorkflowNodeLabel(
  graph: SamuraiWorkflowGraph,
  id: string,
  label: string,
): SamuraiWorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
  };
}

/**
 * Appends an empty step box, wired from the current end of the walk so the
 * new step joins the run immediately (empty text contributes no step until
 * typed — the compile skips it). `label` is only passed in the PR review
 * mode; omitting it leaves the field off the node entirely, so Samurai
 * graphs serialize exactly as before.
 */
export function addWorkflowNode(graph: SamuraiWorkflowGraph, label?: string): SamuraiWorkflowGraph {
  let n = 1;
  while (graph.nodes.some((node) => node.id === `step-${n}`)) n += 1;
  const id = `step-${n}`;
  const walk = workflowWalkOrder(graph);
  const tail: string | undefined = walk[walk.length - 1];
  const node: SamuraiWorkflowNode =
    label === undefined ? { id, text: "" } : { id, text: "", label };
  return {
    nodes: [...graph.nodes, node],
    edges: tail !== undefined ? [...graph.edges, { from: tail, to: id }] : graph.edges,
    start: graph.nodes.length === 0 ? id : graph.start,
  };
}
