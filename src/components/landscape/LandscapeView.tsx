import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bell,
  Download,
  LayoutGrid,
  Maximize2,
  Search,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import {
  AgentExchangeDrawer,
  agentMarkdownLines,
  edgeStroke,
} from "@/components/session/agentPresentation";
import { useAgentStore, type SubagentInfo } from "@/stores/useAgentStore";
import { useLandscapeLayoutStore } from "@/stores/useLandscapeLayoutStore";
import {
  useSessionStore,
  type BackendSessionStatus,
  type SessionConfig,
} from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import {
  agentNodeId,
  layoutLandscape,
  projectNodeId,
  terminalNodeId,
  type LayoutProject,
  type XY,
} from "./layout";
import {
  landscapeNodeTypes,
  LandscapeActionsProvider,
  type AgentNodeData,
  type LandscapeActions,
  type ProjectNodeData,
  type TerminalNodeData,
} from "./LandscapeNodes";

interface LandscapeViewProps {
  /** Leave the landscape and focus a terminal (or just its project). */
  onNavigate: (tabId: string, sessionId?: number) => void;
  onClose: () => void;
}

/** One terminal with the subagents hanging off it. */
interface TerminalModel {
  session: SessionConfig;
  agents: SubagentInfo[];
  title: string;
  description: string;
}

/** One project with its terminals — the unit the layout tiles. */
interface ClusterModel {
  tab: WorkspaceTab;
  color: string;
  status: BackendSessionStatus;
  terminals: TerminalModel[];
  runningAgentCount: number;
}

/**
 * Rollup status for a project node.
 *
 * Same priority as the project tab strip (see `useProjectStatus`), so a project
 * never reads one way on its tab and another way here.
 */
function rollupStatus(sessions: SessionConfig[]): BackendSessionStatus {
  const has = (status: BackendSessionStatus) => sessions.some((s) => s.status === status);
  if (has("NeedsInput")) return "NeedsInput";
  if (has("Working")) return "Working";
  if (has("Error")) return "Error";
  if (has("Timeout")) return "Timeout";
  if (sessions.length > 0 && sessions.every((s) => s.status === "Done")) return "Done";
  if (has("Starting")) return "Starting";
  return "Idle";
}

/** Same wording the per-terminal graph puts under its root node. */
function terminalDescription(session: SessionConfig): string {
  return (
    (session.status === "NeedsInput" && session.needsInputPrompt) ||
    session.statusMessage ||
    (session.status === "Working" ? "Working…" : "Idle")
  );
}

/** Whether a session is doing something (used by the "active only" filter). */
function sessionActive(session: SessionConfig): boolean {
  return (
    session.status === "Working" ||
    session.status === "NeedsInput" ||
    session.status === "Starting"
  );
}

/**
 * Did anything about this node's data actually change?
 *
 * React Flow keys its internals off the *identity* of the node object it is
 * handed, so a rebuilt-but-identical node re-renders the whole card for nothing.
 * Every field of a node's data is a plain value or a store object that is
 * replaced rather than mutated when it changes (see `useAgentStore`), so an
 * `Object.is` per field is an exact answer — an agent whose counters ticked is a
 * new object and compares unequal, as it must.
 */
function sameNodeData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/** Same question for a node's position — the same spot is the same spot. */
function samePosition(a: XY, b: XY): boolean {
  return a === b || (a.x === b.x && a.y === b.y);
}

/** Same question for an edge's inline style (stroke/width/opacity is all we set). */
function sameEdgeStyle(a: Edge["style"], b: Edge["style"]): boolean {
  return a?.stroke === b?.stroke && a?.strokeWidth === b?.strokeWidth && a?.opacity === b?.opacity;
}

/** Markdown of the whole landscape, grouped project → terminal → agent. */
function buildLandscapeMarkdown(clusters: ClusterModel[]): string {
  const agentCount = clusters.reduce(
    (n, c) => n + c.terminals.reduce((m, t) => m + t.agents.length, 0),
    0,
  );
  const lines: string[] = [
    "# Agent landscape",
    "",
    `${clusters.length} project(s), ` +
      `${clusters.reduce((n, c) => n + c.terminals.length, 0)} terminal(s), ` +
      `${agentCount} subagent(s).`,
    "",
  ];
  for (const cluster of clusters) {
    lines.push(`## Project: ${cluster.tab.name}`, "", `Path: \`${cluster.tab.projectPath}\``, "");
    for (const terminal of cluster.terminals) {
      lines.push(
        `### Terminal: ${terminal.title} (session ${terminal.session.id}) — ${terminal.session.status}`,
        "",
      );
      if (terminal.agents.length === 0) {
        lines.push("_No subagents recorded._", "");
        continue;
      }
      terminal.agents.forEach((agent, index) => {
        lines.push(
          ...agentMarkdownLines(
            agent,
            `#### ${index + 1}. ${agent.agentType} — ${agent.description || "(no description)"}`,
          ),
        );
      });
    }
  }
  return lines.join("\n");
}

/**
 * The whole development landscape on one canvas: every open project, every
 * terminal inside it, and every subagent those terminals spawned.
 *
 * Three levels is all the data honestly supports — a subagent's own transcript
 * is never written into its parent's file, so Maestro cannot see agents spawned
 * by an agent. See the note in [`AgentGraph`].
 *
 * Nodes can be dragged freely; "Reorganize" throws every manual position away
 * and restores the deterministic layout.
 */
function LandscapeCanvas({ onNavigate, onClose }: LandscapeViewProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const agents = useAgentStore((s) => s.agents);
  const dismissAgent = useAgentStore((s) => s.dismiss);
  const clearFinishedAndDead = useAgentStore((s) => s.clearFinishedAndDead);
  const projectColors = useProjectColors();
  const manualPositions = useLandscapeLayoutStore((s) => s.positions);
  const setManualPosition = useLandscapeLayoutStore((s) => s.setPosition);
  const resetManualPositions = useLandscapeLayoutStore((s) => s.reset);
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [openAgentKey, setOpenAgentKey] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /* ── Model: projects → terminals → agents ── */
  const clusters = useMemo<ClusterModel[]>(() => {
    const bySession = new Map<number, SubagentInfo[]>();
    for (const agent of agents) {
      const list = bySession.get(agent.sessionId);
      if (list) list.push(agent);
      else bySession.set(agent.sessionId, [agent]);
    }
    // ISO timestamps sort lexicographically, so this is spawn order.
    for (const list of bySession.values()) {
      list.sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
    }

    return tabs.map((tab) => {
      // Ascending session id = launch order, so a project's terminals keep the
      // same vertical order for as long as they live.
      const tabSessions = sessionsForTab(tab, sessions).sort((a, b) => a.id - b.id);
      const terminals = tabSessions.map((session) => ({
        session,
        agents: bySession.get(session.id) ?? [],
        title: session.name?.trim() || session.mode,
        description: terminalDescription(session),
      }));
      return {
        tab,
        color: projectColors.get(tab.name) ?? projectColorFor(tab.name),
        status: rollupStatus(tabSessions),
        terminals,
        runningAgentCount: terminals.reduce(
          (n, t) => n + t.agents.filter((a) => a.completedAt === null).length,
          0,
        ),
      };
    });
  }, [tabs, sessions, agents, projectColors]);

  /* ── Filter: matches stay lit, the rest fade (the map keeps its shape) ── */
  const dimmed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dim = new Set<string>();
    if (!q && !activeOnly) return dim;

    const hit = (...fields: (string | null | undefined)[]) =>
      !q || fields.some((f) => f?.toLowerCase().includes(q));

    for (const cluster of clusters) {
      // A project name match lights up everything inside it.
      const projectText = hit(cluster.tab.name, cluster.tab.projectPath);
      let anyTerminalKept = false;

      for (const terminal of cluster.terminals) {
        const terminalText = projectText || hit(terminal.title, terminal.description);
        let anyAgentKept = false;

        for (const agent of terminal.agents) {
          const agentText = terminalText || hit(agent.agentType, agent.description);
          const keep = agentText && (!activeOnly || agent.completedAt === null);
          if (keep) anyAgentKept = true;
          else dim.add(agentNodeId(terminal.session.id, agent.agentId));
        }

        const keepTerminal =
          (terminalText && (!activeOnly || sessionActive(terminal.session))) || anyAgentKept;
        if (keepTerminal) anyTerminalKept = true;
        else dim.add(terminalNodeId(terminal.session.id));
      }

      const keepProject = (projectText || anyTerminalKept) && (!activeOnly || anyTerminalKept);
      if (!keepProject) dim.add(projectNodeId(cluster.tab.id));
    }
    return dim;
  }, [clusters, query, activeOnly]);

  /* ── Nodes and edges ── */
  // The layout only depends on the *shape* of the graph — which projects hold
  // which terminals hold which agents. `clusters` is rebuilt on every status
  // event, so laying out on it alone would re-run the whole tiling (and hand
  // every node a fresh position object) just because one terminal went
  // Working → Idle. Cache on the id structure instead: same structure, same
  // Map, same position objects.
  const layoutCache = useRef<{ key: string; positions: Map<string, XY> } | null>(null);
  const layout = useMemo(() => {
    const projects: LayoutProject[] = clusters.map((cluster) => ({
      tabId: cluster.tab.id,
      terminals: cluster.terminals.map((terminal) => ({
        sessionId: terminal.session.id,
        agentIds: terminal.agents.map((a) => a.agentId),
      })),
    }));
    const key = projects
      .map(
        (p) =>
          `${p.tabId}[${p.terminals
            .map((t) => `${t.sessionId}:${t.agentIds.join(",")}`)
            .join("|")}]`,
      )
      .join(";");
    const cached = layoutCache.current;
    if (cached && cached.key === key) return cached.positions;
    const positions = layoutLandscape(projects);
    layoutCache.current = { key, positions };
    return positions;
  }, [clusters]);

  const model = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const at = (id: string) => manualPositions[id] ?? layout.get(id) ?? { x: 0, y: 0 };

    for (const cluster of clusters) {
      const pId = projectNodeId(cluster.tab.id);
      const projectData: ProjectNodeData = {
        kind: "project",
        tabId: cluster.tab.id,
        name: cluster.tab.name,
        path: cluster.tab.projectPath,
        color: cluster.color,
        status: cluster.status,
        terminalCount: cluster.terminals.length,
        runningAgentCount: cluster.runningAgentCount,
        dimmed: dimmed.has(pId),
      };
      nodes.push({ id: pId, type: "project", position: at(pId), data: projectData });

      for (const terminal of cluster.terminals) {
        const tId = terminalNodeId(terminal.session.id);
        const terminalData: TerminalNodeData = {
          kind: "terminal",
          tabId: cluster.tab.id,
          sessionId: terminal.session.id,
          title: terminal.title,
          description: terminal.description,
          status: terminal.session.status,
          color: cluster.color,
          agentCount: terminal.agents.length,
          dimmed: dimmed.has(tId),
        };
        nodes.push({ id: tId, type: "terminal", position: at(tId), data: terminalData });
        edges.push({
          id: `e:${pId}->${tId}`,
          source: pId,
          target: tId,
          animated: terminal.session.status === "Working",
          style: { stroke: cluster.color, strokeWidth: 1.5, opacity: dimmed.has(tId) ? 0.15 : 0.65 },
        });

        for (const agent of terminal.agents) {
          const aId = agentNodeId(terminal.session.id, agent.agentId);
          const agentData: AgentNodeData = { kind: "agent", agent, dimmed: dimmed.has(aId) };
          nodes.push({ id: aId, type: "agent", position: at(aId), data: agentData });
          edges.push({
            id: `e:${tId}->${aId}`,
            source: tId,
            target: aId,
            animated: agent.completedAt === null,
            style: {
              stroke: edgeStroke(agent),
              strokeWidth: 1.5,
              opacity: dimmed.has(aId) ? 0.15 : 1,
            },
          });
        }
      }
    }
    return { nodes, edges };
  }, [clusters, layout, manualPositions, dimmed]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Push the rebuilt model into React Flow.
  //
  // Positions come from the model (a dragged node's saved spot, otherwise the
  // tidy layout), so the graph reflows as agents appear and snaps back when
  // Reorganize clears the saved spots. The one exception is a node being
  // dragged right now: agent events arrive every few seconds, and rebuilding
  // over a live drag would yank the node out from under the pointer.
  //
  // A node whose data and position are unchanged is handed back *as the very
  // same object*: React Flow reuses its internal node when the one it is given
  // is identical (`adoptUserNodes`), and only then does the node component skip
  // its re-render. One terminal flipping status must cost one card, not the
  // whole canvas — so when nothing at all moved we return the previous array
  // and React drops the update entirely.
  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      let changed = previous.length !== model.nodes.length;
      const next = model.nodes.map((node, index) => {
        const existing = byId.get(node.id);
        if (!existing) {
          changed = true;
          return node;
        }
        const position = existing.dragging ? existing.position : node.position;
        if (
          existing.type === node.type &&
          samePosition(existing.position, position) &&
          sameNodeData(existing.data, node.data)
        ) {
          // Same node, same place — but it may have moved in the ordering.
          if (previous[index] !== existing) changed = true;
          return existing;
        }
        changed = true;
        return { ...existing, ...node, position };
      });
      return changed ? next : previous;
    });
  }, [model.nodes, setNodes]);

  // Same deal for the edges: an edge object React Flow already holds is left
  // alone unless its ends, its animation or its stroke actually changed.
  useEffect(() => {
    setEdges((previous) => {
      const byId = new Map(previous.map((e) => [e.id, e]));
      let changed = previous.length !== model.edges.length;
      const next = model.edges.map((edge, index) => {
        const existing = byId.get(edge.id);
        if (
          existing &&
          existing.source === edge.source &&
          existing.target === edge.target &&
          existing.animated === edge.animated &&
          sameEdgeStyle(existing.style, edge.style)
        ) {
          if (previous[index] !== existing) changed = true;
          return existing;
        }
        changed = true;
        return edge;
      });
      return changed ? next : previous;
    });
  }, [model.edges, setEdges]);

  /* ── Camera ── */
  const zoomToNode = useCallback(
    (id: string) => {
      fitView({ nodes: [{ id }], duration: 450, maxZoom: 1.5, padding: 0.35 });
    },
    [fitView],
  );

  const fitAll = useCallback(() => {
    fitView({ duration: 450, padding: 0.12 });
  }, [fitView]);

  // Stable on purpose. React Flow threads this handler down to every node
  // wrapper, and those wrappers are memoized on their props — a fresh arrow
  // function per render would break that memo and re-render every card on every
  // store event, however carefully the nodes themselves are diffed above.
  const handleNodeDoubleClick = useCallback<NodeMouseHandler>(
    (_, node) => zoomToNode(node.id),
    [zoomToNode],
  );

  // Fit once, and only after React Flow has measured the nodes — fitting before
  // that leaves the graph at zoom 1 with half the landscape off-screen.
  const nodesInitialized = useNodesInitialized();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !nodesInitialized) return;
    fittedRef.current = true;
    fitView({ padding: 0.12 });
  }, [nodesInitialized, fitView]);

  /* ── "Next needs input": jump the camera through what's waiting on you ── */
  const attentionIds = useMemo(
    () =>
      clusters.flatMap((cluster) =>
        cluster.terminals
          .filter((t) => t.session.status === "NeedsInput")
          .map((t) => terminalNodeId(t.session.id)),
      ),
    [clusters],
  );
  const attentionCursor = useRef(0);
  const focusNextAttention = useCallback(() => {
    if (attentionIds.length === 0) return;
    const index = attentionCursor.current % attentionIds.length;
    attentionCursor.current = index + 1;
    zoomToNode(attentionIds[index]);
  }, [attentionIds, zoomToNode]);

  /* ── Actions the nodes can trigger ── */
  const openAgent = useCallback((agent: SubagentInfo) => {
    setOpenAgentKey(agentNodeId(agent.sessionId, agent.agentId));
  }, []);

  const handleNavigate = useCallback(
    (tabId: string, sessionId?: number) => {
      onNavigate(tabId, sessionId);
      onClose();
    },
    [onNavigate, onClose],
  );

  const actions = useMemo<LandscapeActions>(
    () => ({
      openAgent,
      dismissAgent,
      openTerminal: (tabId, sessionId) => handleNavigate(tabId, sessionId),
      openProject: (tabId) => handleNavigate(tabId),
    }),
    [openAgent, dismissAgent, handleNavigate],
  );

  /* ── The agent whose drawer is open (may vanish if it gets dismissed) ── */
  const openAgentEntry = useMemo(() => {
    if (!openAgentKey) return null;
    for (const cluster of clusters) {
      for (const terminal of cluster.terminals) {
        for (const agent of terminal.agents) {
          if (agentNodeId(terminal.session.id, agent.agentId) === openAgentKey) {
            return { agent, subtitle: `${cluster.tab.name} · ${terminal.title}` };
          }
        }
      }
    }
    return null;
  }, [openAgentKey, clusters]);

  // Esc backs out one level: close the drawer, else leave the landscape.
  // Capture phase, because a terminal underneath still holds DOM focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (openAgentKey) setOpenAgentKey(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [openAgentKey, onClose]);

  /* ── Toolbar actions ── */
  const handleReorganize = useCallback(() => {
    resetManualPositions();
    requestAnimationFrame(fitAll);
  }, [resetManualPositions, fitAll]);

  // A session whose Claude process is still alive. An agent of any other
  // session (ended, errored, or closed entirely) can never complete — it is
  // "dead" and clearable even though it still reads as running.
  const liveSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter(
            (s) =>
              s.status === "Working" ||
              s.status === "NeedsInput" ||
              s.status === "Starting" ||
              s.status === "Idle",
          )
          .map((s) => s.id),
      ),
    [sessions],
  );

  const clearableCount = useMemo(
    () =>
      agents.filter((a) => a.completedAt !== null || !liveSessionIds.has(a.sessionId)).length,
    [agents, liveSessionIds],
  );

  const handleClearFinished = useCallback(() => {
    clearFinishedAndDead(liveSessionIds);
    setOpenAgentKey(null);
  }, [clearFinishedAndDead, liveSessionIds]);

  const handleExport = useCallback(async () => {
    setExportError(null);
    try {
      const path = await save({
        defaultPath: "agent-landscape.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await invoke("export_agent_run", { path, content: buildLandscapeMarkdown(clusters) });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }, [clusters]);

  const terminalCount = clusters.reduce((n, c) => n + c.terminals.length, 0);
  const runningAgents = clusters.reduce((n, c) => n + c.runningAgentCount, 0);
  // shrink-0 + nowrap: a narrow window must scroll the toolbar sideways, not
  // wrap the buttons into a second row the 40px-tall bar can't show.
  const toolbarButton =
    "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-maestro-border bg-maestro-card px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40";

  return (
    /* z-50: the eagle view's zoomed pane sits at z-40 in the same stacking
       context (App's <main>), so anything lower leaves the landscape invisible
       whenever a terminal is zoomed. */
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-maestro-border px-2">
        <span className="mr-1 shrink-0 whitespace-nowrap text-[11px] text-maestro-muted">
          {clusters.length} project{clusters.length === 1 ? "" : "s"} · {terminalCount} terminal
          {terminalCount === 1 ? "" : "s"} · {runningAgents} agent{runningAgents === 1 ? "" : "s"}{" "}
          running
        </span>

        <div className="relative shrink-0">
          <Search
            size={11}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-maestro-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter projects, terminals, agents"
            aria-label="Filter the landscape"
            className="w-48 rounded border border-maestro-border bg-maestro-card py-1 pl-6 pr-2 text-[11px] text-maestro-text placeholder:text-maestro-muted/70 focus:border-maestro-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setActiveOnly((v) => !v)}
          title="Show only terminals and agents that are still working"
          className={`${toolbarButton} ${
            activeOnly ? "border-maestro-accent/60 text-maestro-accent" : ""
          }`}
        >
          Active only
        </button>

        <div className="min-w-[8px] flex-1" />

        {exportError && (
          <span className="max-w-[220px] shrink-0 truncate text-[10px] text-red-400" title={exportError}>
            Export failed: {exportError}
          </span>
        )}

        <button
          type="button"
          onClick={focusNextAttention}
          disabled={attentionIds.length === 0}
          title="Jump to the next terminal waiting for your input"
          className={`${toolbarButton} ${
            attentionIds.length > 0 ? "border-maestro-accent/60 text-maestro-accent" : ""
          }`}
        >
          <Bell size={11} />
          Needs input{attentionIds.length > 0 ? ` (${attentionIds.length})` : ""}
        </button>
        <button type="button" onClick={handleReorganize} title="Undo every drag — re-run the tidy layout" className={toolbarButton}>
          <LayoutGrid size={11} />
          Reorganize
        </button>
        <button type="button" onClick={fitAll} title="Zoom out to the whole landscape" className={toolbarButton}>
          <Maximize2 size={11} />
          Overview
        </button>
        <button type="button" onClick={() => zoomIn({ duration: 200 })} aria-label="Zoom in" title="Zoom in" className={toolbarButton}>
          <ZoomIn size={11} />
        </button>
        <button type="button" onClick={() => zoomOut({ duration: 200 })} aria-label="Zoom out" title="Zoom out" className={toolbarButton}>
          <ZoomOut size={11} />
        </button>
        <button
          type="button"
          onClick={handleClearFinished}
          disabled={clearableCount === 0}
          title="Remove every done agent, plus dead ones whose terminal ended"
          className={toolbarButton}
        >
          <Trash2 size={11} />
          Clear done{clearableCount > 0 ? ` (${clearableCount})` : ""}
        </button>
        <button type="button" onClick={handleExport} title="Export every brief, report and counter to markdown" className={toolbarButton}>
          <Download size={11} />
          Export
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close landscape"
          title="Close (Esc)"
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <X size={14} />
        </button>
      </div>

      {/* Canvas */}
      <div className="relative min-h-0 flex-1">
        {clusters.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-maestro-muted">
            No projects open — open one to see it on the landscape.
          </div>
        ) : (
          <LandscapeActionsProvider value={actions}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={landscapeNodeTypes}
              onNodeDragStop={(_, node) => setManualPosition(node.id, node.position)}
              onNodeDoubleClick={handleNodeDoubleClick}
              // Double-click is "zoom into this node", so the canvas must not
              // also treat it as a plain zoom step.
              zoomOnDoubleClick={false}
              nodesConnectable={false}
              edgesFocusable={false}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgb(var(--maestro-border))" />
              <MiniMap
                pannable
                zoomable
                ariaLabel="Landscape minimap"
                bgColor="rgb(var(--maestro-surface))"
                maskColor="rgb(var(--maestro-bg) / 0.7)"
                nodeColor={(node) => {
                  const data = node.data as { kind?: string; color?: string; status?: string };
                  if (data.status === "NeedsInput") return "rgb(var(--maestro-accent))";
                  if (data.kind === "project") return data.color ?? "rgb(var(--maestro-muted))";
                  if (data.status === "Working") return "rgb(var(--maestro-blue))";
                  return "rgb(var(--maestro-muted))";
                }}
                className="!bottom-3 !right-3 rounded border border-maestro-border"
              />
            </ReactFlow>
          </LandscapeActionsProvider>
        )}

        {openAgentEntry && (
          <AgentExchangeDrawer
            agent={openAgentEntry.agent}
            subtitle={openAgentEntry.subtitle}
            onClose={() => setOpenAgentKey(null)}
          />
        )}
      </div>
    </div>
  );
}

/** React Flow's camera API needs a provider above the component that uses it. */
export function LandscapeView(props: LandscapeViewProps) {
  return (
    <ReactFlowProvider>
      <LandscapeCanvas {...props} />
    </ReactFlowProvider>
  );
}
