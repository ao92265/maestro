import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Connection,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Loader2,
  Maximize2,
  Plus,
  RotateCcw,
  Trash2,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type SamuraiWorkflowEdge,
  type SamuraiWorkflowGraph,
  samuraiDefaultWorkflow,
} from "@/lib/samurai";
import { useSamuraiWorkflowStore } from "@/stores/useSamuraiWorkflowStore";

/**
 * Full-screen editor for the run workflow graph (issue #91 Part B, promoted
 * out of the Launch tab's sidebar card to its own overlay): the steps whose
 * compiled list rides every orchestrator brief. Step text is edited in
 * place; steps can be added, removed and rewired. The edited graph persists
 * across restarts (`useSamuraiWorkflowStore`) and the launch sends it
 * verbatim. Opened from `LaunchSection` via `useWorkflowsViewStore`, rendered
 * by `App` next to `LandscapeView` — same overlay shell (`absolute inset-0
 * z-50`), same "toolbar + React Flow canvas" shape.
 *
 * The graph mutations below mirror the backend compile rule
 * (`src-tauri/src/core/samurai_workflow.rs`): the walk starts at `start`,
 * follows the FIRST outgoing edge in edge-list order, and stops at a missing
 * target or a revisit. That rule is why:
 *  - deleting a NODE bridges its incoming edges to its first outgoing target
 *    (prev → next) — removal skips the step instead of truncating the walk;
 *  - deleting an EDGE deliberately truncates: everything past the cut stays
 *    visible but leaves the run (rendered dimmed, "not in run").
 */

/* ── Pure graph edits (exported for tests) ───────────────────────────── */

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
    const key = `${kept.from} ${kept.to}`;
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

/**
 * Appends an empty step box, wired from the current end of the walk so the
 * new step joins the run immediately (empty text contributes no step until
 * typed — the compile skips it).
 */
export function addWorkflowNode(graph: SamuraiWorkflowGraph): SamuraiWorkflowGraph {
  let n = 1;
  while (graph.nodes.some((node) => node.id === `step-${n}`)) n += 1;
  const id = `step-${n}`;
  const walk = workflowWalkOrder(graph);
  const tail: string | undefined = walk[walk.length - 1];
  return {
    nodes: [...graph.nodes, { id, text: "" }],
    edges: tail !== undefined ? [...graph.edges, { from: tail, to: id }] : graph.edges,
    start: graph.nodes.length === 0 ? id : graph.start,
  };
}

/* ── React Flow scaffolding ──────────────────────────────────────────── */

/** Pseudo-node: where the walk enters. Not part of the wire graph. */
const START_ID = "__workflow_start__";

const NODE_W = 320;
const NODE_H = 190;
const V_GAP = 48;
const START_W = 100;
const START_H = 36;
const PAD = 40;

interface WorkflowActions {
  setText: (id: string, text: string) => void;
  removeNode: (id: string) => void;
  removeEdge: (from: string, to: string) => void;
}

const noop = () => {};
const WorkflowActionsContext = createContext<WorkflowActions>({
  setText: noop,
  removeNode: noop,
  removeEdge: noop,
});

type StepData = {
  text: string;
  /** Compiled step number; null when the compile emits no step for it. */
  step: number | null;
  /** On the walk from START. Off-walk boxes are excluded from the run. */
  reachable: boolean;
};

const handleClass =
  "!h-2.5 !w-2.5 !rounded-full !border !border-maestro-border !bg-maestro-accent/70";

/** The walk's entry point — drag from its handle to choose the first step. */
function StartNode(_: NodeProps) {
  return (
    <div
      title="Where the run's workflow starts. Drag from the dot to make another step the first one."
      className="flex items-center justify-center rounded-full border border-maestro-accent/60 bg-maestro-accent/15 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-maestro-accent"
    >
      Start
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </div>
  );
}

/**
 * One workflow step card: a status badge (doubling as the card's title),
 * an editable instruction body, and a clearly-labelled delete action —
 * roomier than the sidebar's compact version, same editing semantics.
 */
function StepNode({ id, data }: NodeProps) {
  const d = data as StepData;
  const { setText, removeNode } = useContext(WorkflowActionsContext);
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      className={`flex flex-col rounded-lg border bg-maestro-card p-3 shadow-[0_1px_4px_rgb(0_0_0/0.15),0_0_0_1px_rgb(255_255_255/0.03)_inset] transition-opacity ${
        d.reachable ? "border-maestro-border" : "border-maestro-border/40 opacity-40"
      }`}
    >
      <Handle type="target" position={Position.Top} className={handleClass} />
      <div className="mb-2 flex items-center gap-2">
        {d.step !== null ? (
          <span className="rounded bg-maestro-accent/20 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-maestro-accent">
            Step {d.step}
          </span>
        ) : d.reachable ? (
          <span
            className="rounded bg-maestro-surface px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-maestro-muted"
            title="Empty text contributes no step — type an instruction to include it."
          >
            Empty — skipped
          </span>
        ) : (
          <span
            className="rounded bg-maestro-surface px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-maestro-muted"
            title="No connection from Start reaches this box, so the run excludes it. Reconnect it or remove it."
          >
            Not in run
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => removeNode(id)}
          aria-label={`Remove step ${id}`}
          title="Remove this step — its neighbours are re-connected around it"
          className="nodrag flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>
      <textarea
        value={d.text}
        onChange={(e) => setText(id, e.target.value)}
        rows={6}
        aria-label={`Edit step ${id}`}
        placeholder="Describe this step's instructions…"
        className="nodrag nowheel w-full flex-1 resize-none rounded border border-maestro-border/40 bg-maestro-surface px-2.5 py-2 text-[13px] leading-snug text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
      />
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </div>
  );
}

/**
 * An edge with a mid-point delete button. The START pill's edge carries
 * `fixed` and gets no button — the walk must enter somewhere; rewire it by
 * dragging from the pill instead.
 */
function WorkflowEdgeView({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const { removeEdge } = useContext(WorkflowActionsContext);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {!data?.fixed && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={() => removeEdge(source, target)}
            aria-label={`Disconnect ${source} from ${target}`}
            title="Remove this connection — the run then stops before the disconnected steps"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-maestro-border bg-maestro-bg text-maestro-muted transition-colors hover:border-maestro-red hover:text-maestro-red"
          >
            <X size={11} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { start: StartNode, step: StepNode };
const edgeTypes = { workflow: WorkflowEdgeView };

interface WorkflowsViewProps {
  onClose: () => void;
}

/** Derived React Flow model for one graph, laid out as a single column. */
function buildModel(graph: SamuraiWorkflowGraph): { nodes: Node[]; edges: Edge[] } {
  const order = workflowWalkOrder(graph);
  const reachable = new Set(order);
  const rest = graph.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  let step = 0;
  const stepOf = new Map<string, number | null>();
  for (const id of order) {
    const hasText = (byId.get(id)?.text ?? "").trim().length > 0;
    stepOf.set(id, hasText ? ++step : null);
  }

  const nodes: Node[] = [
    {
      id: START_ID,
      type: "start",
      position: { x: PAD + NODE_W / 2 - START_W / 2, y: PAD },
      data: {},
      deletable: false,
      width: START_W,
      height: START_H,
      handles: [{ type: "source", position: Position.Bottom, x: START_W / 2, y: START_H }],
    },
    ...[...order, ...rest].map(
      (id, index): Node => ({
        id,
        type: "step",
        position: { x: PAD, y: PAD + START_H + V_GAP + index * (NODE_H + V_GAP) },
        data: {
          text: byId.get(id)?.text ?? "",
          step: stepOf.get(id) ?? null,
          reachable: reachable.has(id),
        } satisfies StepData,
        deletable: false,
        width: NODE_W,
        height: NODE_H,
        handles: [
          { type: "target", position: Position.Top, x: NODE_W / 2, y: 0 },
          { type: "source", position: Position.Bottom, x: NODE_W / 2, y: NODE_H },
        ],
      }),
    ),
  ];

  // The traversed pairs — only these edges carry the run.
  const walked = new Set(order.slice(0, -1).map((id, i) => `${id} ${order[i + 1]}`));
  const edges: Edge[] = graph.edges.map((edge, index) => {
    const active = walked.has(`${edge.from} ${edge.to}`);
    return {
      id: `e${index}:${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "workflow",
      data: { fixed: false },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.5, opacity: active ? 0.9 : 0.3 },
    };
  });
  if (byId.has(graph.start)) {
    edges.unshift({
      id: `e:start->${graph.start}`,
      source: START_ID,
      target: graph.start,
      type: "workflow",
      data: { fixed: true },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.5, opacity: 0.9 },
    });
  }

  return { nodes, edges };
}

const toolbarButton =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-maestro-border bg-maestro-card px-2 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40";

function WorkflowsCanvas({ onClose }: WorkflowsViewProps) {
  const stored = useSamuraiWorkflowStore((s) => s.graph);
  const setGraph = useSamuraiWorkflowStore((s) => s.setGraph);
  const resetGraph = useSamuraiWorkflowStore((s) => s.resetGraph);
  // The backend default template, fetched only while nothing is stored —
  // it is the display fallback AND what the first edit is applied to.
  const [fallback, setFallback] = useState<SamuraiWorkflowGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stored !== null) return;
    let disposed = false;
    samuraiDefaultWorkflow()
      .then((graph) => {
        if (!disposed) setFallback(graph);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
    };
  }, [stored]);

  const graph = stored ?? fallback;

  // Every edit lands in the persisted store, whichever graph it started from.
  const actions = useMemo<WorkflowActions>(
    () => ({
      setText: (id, text) => graph && setGraph(setWorkflowNodeText(graph, id, text)),
      removeNode: (id) => graph && setGraph(removeWorkflowNode(graph, id)),
      removeEdge: (from, to) => graph && setGraph(removeWorkflowEdge(graph, from, to)),
    }),
    [graph, setGraph],
  );

  const handleConnect = (connection: Connection) => {
    if (!graph || !connection.source || !connection.target) return;
    if (connection.target === START_ID) return;
    setGraph(
      connection.source === START_ID
        ? setWorkflowStart(graph, connection.target)
        : connectWorkflow(graph, connection.source, connection.target),
    );
  };

  const handleAdd = () => {
    if (graph) setGraph(addWorkflowNode(graph));
  };

  const handleReset = () => {
    // Reset returns to "never edited" (null): the backend default GOVERNS
    // again — the launch sends `workflow: null` and future changes to the
    // default template apply. Storing a materialized copy of today's default
    // would silently pin the user to it forever. The effect above refetches
    // it for display the moment `stored` flips back to null.
    setError(null);
    resetGraph();
  };

  // Walk order first (the run's actual sequence), then the disconnected
  // boxes. Positions are only the STARTING point for a fresh node — see the
  // sync effects below, which preserve wherever the user has dragged a node.
  const model = useMemo(() => (graph ? buildModel(graph) : null), [graph]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Re-derive nodes from the store on every edit, but never yank a node the
  // user already positioned: an existing node keeps its current (possibly
  // dragged) position, only its `data` is refreshed. Only a brand-new node
  // (added via "Add step") gets the computed layout position.
  useEffect(() => {
    if (!model) return;
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return model.nodes.map((node) => {
        const existing = byId.get(node.id);
        return existing ? { ...node, position: existing.position } : node;
      });
    });
  }, [model, setNodes]);

  useEffect(() => {
    if (!model) return;
    setEdges(model.edges);
  }, [model, setEdges]);

  const { fitView, zoomIn, zoomOut } = useReactFlow();

  // Fit once, and only after React Flow has measured the nodes — fitting
  // before that leaves the graph at zoom 1 with steps off-screen.
  const nodesInitialized = useNodesInitialized();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !nodesInitialized) return;
    fittedRef.current = true;
    fitView({ padding: 0.2 });
  }, [nodesInitialized, fitView]);

  // Esc closes the overlay (same convention as LandscapeView). Capture
  // phase, because a focused textarea inside a step card would otherwise
  // absorb the key first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  return (
    // z-50: matches LandscapeView, the other full-screen overlay App can show.
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-maestro-border px-2">
        <Workflow size={13} className="shrink-0 text-maestro-accent" />
        <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          Workflow Editor
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-muted">
          The step-by-step process every run follows, compiled into each orchestrator brief.
          Removing a step re-connects its neighbours; removing an arrow cuts the run short.
        </span>

        {error && (
          <span
            className="max-w-[220px] shrink-0 truncate text-[10px] text-maestro-red"
            title={error}
          >
            {error}
          </span>
        )}

        <button
          type="button"
          onClick={handleAdd}
          disabled={!graph}
          title="Add an empty step box at the end of the run"
          className={toolbarButton}
        >
          <Plus size={12} />
          Add step
        </button>
        <button
          type="button"
          onClick={handleReset}
          title="Throw away every edit and restore the default workflow"
          className={toolbarButton}
        >
          <RotateCcw size={12} />
          Reset
        </button>
        <button
          type="button"
          onClick={() => zoomOut({ duration: 200 })}
          aria-label="Zoom out"
          title="Zoom out"
          className={toolbarButton}
        >
          <ZoomOut size={12} />
        </button>
        <button
          type="button"
          onClick={() => zoomIn({ duration: 200 })}
          aria-label="Zoom in"
          title="Zoom in"
          className={toolbarButton}
        >
          <ZoomIn size={12} />
        </button>
        <button
          type="button"
          onClick={() => fitView({ duration: 200, padding: 0.2 })}
          title="Zoom to fit every step"
          className={toolbarButton}
        >
          <Maximize2 size={12} />
          Fit view
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workflow editor"
          title="Close (Esc)"
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <X size={14} />
        </button>
      </div>

      {/* Canvas */}
      <div className="relative min-h-0 flex-1">
        {model === null ? (
          !error && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-maestro-muted">
              <Loader2 size={14} className="animate-spin" />
              Loading workflow…
            </div>
          )
        ) : (
          <WorkflowActionsContext.Provider value={actions}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              nodesConnectable
              edgesFocusable={false}
              deleteKeyCode={null}
              minZoom={0.25}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={26}
                size={1}
                color="rgb(var(--maestro-border))"
              />
            </ReactFlow>
          </WorkflowActionsContext.Provider>
        )}
      </div>
    </div>
  );
}

/** React Flow's camera API needs a provider above the component that uses it. */
export function WorkflowsView(props: WorkflowsViewProps) {
  return (
    <ReactFlowProvider>
      <WorkflowsCanvas {...props} />
    </ReactFlowProvider>
  );
}
