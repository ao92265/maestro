import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  Check,
  Copy,
  Download,
  PencilLine,
  Network,
  Search,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ThinkingIndicator } from "@/components/terminal/ThinkingIndicator";
import { useAgentStore, type SubagentInfo } from "@/stores/useAgentStore";
import { type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";

interface AgentGraphProps {
  sessionId: number;
}

/* ── Layout constants (px) ── */
const PAD = 24;
const ROOT_W = 220;
const ROOT_H = 64;
const NODE_W = 250;
const NODE_H = 96;
const V_GAP = 14;
const COL_GAP = 80;

/** Word badge per session status (local map — mirrors the sidebar's badges). */
const SESSION_STATUS_BADGES: Record<BackendSessionStatus, { label: string; cls: string }> = {
  Starting: { label: "STARTING", cls: "bg-orange-500/15 text-orange-400" },
  Idle: { label: "IDLE", cls: "bg-maestro-muted/15 text-maestro-muted" },
  Working: { label: "WORKING", cls: "bg-maestro-blue/15 text-maestro-blue" },
  NeedsInput: { label: "NEEDS INPUT", cls: "bg-maestro-accent/15 text-maestro-accent" },
  Done: { label: "DONE", cls: "bg-maestro-green/15 text-maestro-green" },
  Error: { label: "ERROR", cls: "bg-red-500/15 text-red-400" },
  Timeout: { label: "TIMEOUT", cls: "bg-red-500/15 text-red-400" },
};

const badgeBaseClass =
  "shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide";

/**
 * Badge for a subagent node.
 *
 * A status the transcript reports but we don't recognise is shown verbatim
 * rather than folded into DONE — better an unfamiliar word than a wrong one.
 */
function agentBadge(agent: SubagentInfo): { label: string; cls: string } {
  if (agent.completedAt === null) {
    return { label: "RUNNING", cls: "bg-maestro-blue/15 text-maestro-blue animate-pulse" };
  }
  if (agent.success === false) {
    return { label: "FAILED", cls: "bg-red-500/15 text-red-400" };
  }
  if (agent.status && agent.status !== "completed") {
    return {
      label: agent.status.replace(/_/g, " ").toUpperCase(),
      cls: "bg-maestro-muted/15 text-maestro-muted",
    };
  }
  return { label: "DONE", cls: "bg-maestro-green/15 text-maestro-green" };
}

/** Edge color via CSS vars so the light theme (swapped vars) keeps working. */
function edgeStroke(agent: SubagentInfo): string {
  if (agent.completedAt === null) return "rgb(var(--maestro-blue))";
  if (agent.success === false) return "rgb(var(--maestro-red))";
  return "rgb(var(--maestro-border))";
}

/* ── Formatting ── */

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Model id shortened for a 250px node: "claude-fable-5" -> "fable-5". */
function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

/** The one-line summary under a node's description: model, cost, effort. */
function statsLine(agent: SubagentInfo): string {
  const parts: string[] = [];
  if (agent.model) parts.push(shortModel(agent.model));
  if (agent.durationMs !== null) parts.push(formatDuration(agent.durationMs));
  if (agent.totalTokens !== null) parts.push(`${formatTokens(agent.totalTokens)} tok`);
  if (agent.toolUseCount !== null) parts.push(`${agent.toolUseCount} tools`);
  return parts.join(" · ");
}

/**
 * Markdown of every agent in the session — brief, report and counters.
 *
 * Kept whole: an export exists to be read outside Maestro, so truncating it
 * would defeat the point.
 */
export function buildExportMarkdown(agents: SubagentInfo[], sessionTitle: string): string {
  const lines: string[] = [`# Agent run — ${sessionTitle}`, "", `${agents.length} subagent(s).`, ""];
  for (const [index, agent] of agents.entries()) {
    const badge = agentBadge(agent);
    lines.push(
      `## ${index + 1}. ${agent.agentType} — ${agent.description || "(no description)"}`,
      "",
      `- Status: ${badge.label}`,
      `- Tool use id: ${agent.agentId}`,
    );
    if (agent.agentRunId) lines.push(`- Agent run id: ${agent.agentRunId}`);
    if (agent.model) lines.push(`- Model: ${agent.model}`);
    lines.push(`- Spawned: ${agent.spawnedAt}`);
    if (agent.completedAt !== null) {
      lines.push(`- Completed: ${new Date(agent.completedAt).toISOString()}`);
    }
    if (agent.runInBackground) lines.push("- Ran in the background");
    if (agent.durationMs !== null) lines.push(`- Duration: ${formatDuration(agent.durationMs)}`);
    if (agent.totalTokens !== null) lines.push(`- Tokens: ${agent.totalTokens}`);
    if (agent.toolUseCount !== null) lines.push(`- Tool calls: ${agent.toolUseCount}`);
    const s = agent.toolStats;
    if (s) {
      lines.push(
        `- Tool breakdown: ${s.read_count} read, ${s.search_count} search, ` +
          `${s.bash_count} bash, ${s.edit_file_count} edit ` +
          `(+${s.lines_added}/-${s.lines_removed} lines), ${s.other_tool_count} other`,
      );
    }
    lines.push("", "### Brief sent", "", agent.prompt || "_(none recorded)_", "", "### Report back", "");
    lines.push(agent.report || "_(none recorded)_", "");
  }
  return lines.join("\n");
}

/** A copy-to-clipboard button that confirms itself for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (err) {
          console.error("Failed to copy to clipboard:", err);
        }
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** The tool-call breakdown, rendered as icon + count pairs. */
function ToolStatsRow({ agent }: { agent: SubagentInfo }) {
  const s = agent.toolStats;
  if (!s) return null;
  const items: { icon: typeof BookOpen; count: number; label: string }[] = [
    { icon: BookOpen, count: s.read_count, label: "files read" },
    { icon: Search, count: s.search_count, label: "searches" },
    { icon: TerminalIcon, count: s.bash_count, label: "shell commands" },
    { icon: PencilLine, count: s.edit_file_count, label: "file edits" },
  ];
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-maestro-muted">
      {items.map(({ icon: Icon, count, label }) => (
        <span key={label} className="flex items-center gap-0.5" title={`${count} ${label}`}>
          <Icon size={9} className="shrink-0" />
          {count}
        </span>
      ))}
      {(s.lines_added > 0 || s.lines_removed > 0) && (
        <span title={`${s.lines_added} lines added, ${s.lines_removed} removed`}>
          <span className="text-maestro-green">+{s.lines_added}</span>
          <span className="text-red-400">/-{s.lines_removed}</span>
        </span>
      )}
    </div>
  );
}

/** One labelled block of the drawer: a heading, a char count, copy, the text. */
function ExchangeBlock({
  title,
  text,
  empty,
}: {
  title: string;
  text: string;
  empty: string;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 border-b border-maestro-border pb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-maestro-muted">
          {title}
        </span>
        <div className="flex-1" />
        {text && (
          <span className="shrink-0 text-[10px] text-maestro-muted">
            {text.length.toLocaleString()} chars
          </span>
        )}
        <CopyButton text={text} label={title.toLowerCase()} />
      </div>
      {text ? (
        <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-maestro-text">
          {text}
        </pre>
      ) : (
        <p className="mt-1.5 text-[11px] italic text-maestro-muted">{empty}</p>
      )}
    </div>
  );
}

/**
 * Live node graph of the agents running inside one terminal session.
 *
 * Structure is the honest one the app actually tracks: a single root node
 * (the main session, from useSessionStore) fanned out to the subagents the
 * transcript watcher reported for that session (useAgentStore — Agent/Task tool
 * spawns and completions). No parent->child nesting exists in the transcript —
 * a subagent's own tool calls are never written to the parent's file — so the
 * graph is always 1 root -> N children.
 *
 * Nodes persist with their final status until dismissed, so a finished run can
 * be read back; clicking one opens the exchange drawer with the full brief the
 * orchestrator sent and the full report the agent returned.
 *
 * Self-subscribing (no props beyond sessionId) so mounting one per terminal
 * doesn't re-render every terminal on each agent event. Updates are live via
 * the zustand subscriptions — claude-event -> useAgentStore -> re-render.
 */
export function AgentGraph({ sessionId }: AgentGraphProps) {
  const agents = useAgentStore((s) => s.agents);
  const dismiss = useAgentStore((s) => s.dismiss);
  const clearFinished = useAgentStore((s) => s.clearFinished);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Sort by spawn timestamp (ISO strings sort lexicographically) so node
  // positions stay stable as new agents append.
  const sessionAgents = useMemo(
    () =>
      agents
        .filter((a) => a.sessionId === sessionId)
        .sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt)),
    [agents, sessionId]
  );

  const session = useSessionStore(
    useShallow((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      if (!sess) return null;
      return {
        name: sess.name,
        mode: sess.mode,
        status: sess.status,
        statusMessage: sess.statusMessage,
        needsInputPrompt: sess.needsInputPrompt,
      };
    })
  );

  if (!session) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-maestro-bg">
        <div className="flex flex-col items-center gap-2 text-maestro-muted">
          <Network size={24} className="opacity-60" />
          <p className="text-xs">No active agent session</p>
        </div>
      </div>
    );
  }

  const rootBadge = SESSION_STATUS_BADGES[session.status] ?? SESSION_STATUS_BADGES.Idle;
  const rootTitle = session.name?.trim() || session.mode;
  const rootDescription =
    (session.status === "NeedsInput" && session.needsInputPrompt) ||
    session.statusMessage ||
    (session.status === "Working" ? "Working…" : "Idle");

  const rootNode = (
    <div
      className="flex flex-col justify-center overflow-hidden rounded-lg border border-maestro-border bg-maestro-card px-3 py-2 text-maestro-text"
      style={{ width: ROOT_W, height: ROOT_H }}
      title={rootDescription}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{rootTitle}</span>
        <ThinkingIndicator sessionId={sessionId} />
        <span className={`${badgeBaseClass} ${rootBadge.cls}`}>{rootBadge.label}</span>
      </div>
      <p className="mt-1 truncate text-[11px] text-maestro-muted">{rootDescription}</p>
    </div>
  );

  if (sessionAgents.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-maestro-bg p-6">
        {rootNode}
        <p className="max-w-[280px] text-center text-[11px] italic text-maestro-muted">
          No subagents running — agents spawned via the Task tool will appear here.
        </p>
      </div>
    );
  }

  const finishedCount = sessionAgents.filter((a) => a.completedAt !== null).length;
  const openAgent = sessionAgents.find((a) => a.agentId === openAgentId) ?? null;

  const handleExport = async () => {
    setExportError(null);
    try {
      const path = await save({
        defaultPath: `agent-run-session-${sessionId}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await invoke("export_agent_run", {
        path,
        content: buildExportMarkdown(sessionAgents, rootTitle),
      });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  /* ── Layout: root at left, children stacked in a right column ── */
  const n = sessionAgents.length;
  const stackH = n * NODE_H + (n - 1) * V_GAP;
  const contentW = PAD * 2 + ROOT_W + COL_GAP + NODE_W;
  const contentH = PAD * 2 + Math.max(ROOT_H, stackH);
  const rootX = PAD;
  const rootY = PAD + Math.max(0, (stackH - ROOT_H) / 2);
  const childX = PAD + ROOT_W + COL_GAP;
  const rootRight = rootX + ROOT_W;
  const rootMidY = rootY + ROOT_H / 2;
  const midX = rootRight + COL_GAP / 2;

  return (
    <div className="relative h-full w-full overflow-auto bg-maestro-bg">
      {/* Toolbar: floats over the scrolling canvas, top-right. */}
      <div className="sticky top-0 z-10 flex items-center justify-end gap-1 px-2 py-1.5">
        {exportError && (
          <span className="mr-auto truncate text-[10px] text-red-400" title={exportError}>
            Export failed: {exportError}
          </span>
        )}
        <button
          type="button"
          onClick={handleExport}
          title="Export this run (briefs, reports and counters) to a markdown file"
          className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:text-maestro-text"
        >
          <Download size={10} />
          Export run
        </button>
        <button
          type="button"
          onClick={() => {
            clearFinished(sessionId);
            setOpenAgentId(null);
          }}
          disabled={finishedCount === 0}
          title="Remove every finished agent from this graph"
          className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40"
        >
          <Trash2 size={10} />
          Clear finished{finishedCount > 0 ? ` (${finishedCount})` : ""}
        </button>
      </div>

      <div className="relative" style={{ width: contentW, height: contentH }}>
        {/* Edge overlay */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={contentW}
          height={contentH}
          aria-hidden="true"
        >
          {sessionAgents.map((agent, i) => {
            const childMidY = PAD + i * (NODE_H + V_GAP) + NODE_H / 2;
            const running = agent.completedAt === null;
            return (
              <path
                key={agent.agentId}
                d={`M ${rootRight} ${rootMidY} C ${midX} ${rootMidY}, ${midX} ${childMidY}, ${childX} ${childMidY}`}
                fill="none"
                stroke={edgeStroke(agent)}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={running ? "6 6" : undefined}
                className={running ? "animate-edge-dash" : undefined}
              />
            );
          })}
        </svg>

        {/* Root node (main session) */}
        <div className="absolute" style={{ left: rootX, top: rootY }}>
          {rootNode}
        </div>

        {/* Subagent nodes */}
        {sessionAgents.map((agent, i) => {
          const badge = agentBadge(agent);
          const running = agent.completedAt === null;
          const stats = statsLine(agent);
          return (
            <button
              type="button"
              key={agent.agentId}
              onClick={() => setOpenAgentId(agent.agentId)}
              title="Show the brief sent and the report returned"
              className={`absolute flex flex-col overflow-hidden rounded-lg border bg-maestro-card px-3 py-2 text-left text-maestro-text transition-colors hover:border-maestro-accent ${
                running ? "border-maestro-accent/60" : "border-maestro-border"
              }`}
              style={{
                left: childX,
                top: PAD + i * (NODE_H + V_GAP),
                width: NODE_W,
                height: NODE_H,
              }}
            >
              <div className="flex w-full items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {agent.agentType}
                </span>
                {agent.runInBackground && (
                  <span
                    className={`${badgeBaseClass} bg-maestro-muted/15 text-maestro-muted`}
                    title="Launched in the background"
                  >
                    BG
                  </span>
                )}
                <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Dismiss ${agent.agentType}`}
                  title="Remove from the graph"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openAgentId === agent.agentId) setOpenAgentId(null);
                    dismiss(agent.agentId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.stopPropagation();
                    e.preventDefault();
                    dismiss(agent.agentId);
                  }}
                  className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
                >
                  <X size={11} />
                </span>
              </div>
              <p className="mt-1 w-full truncate text-[11px] text-maestro-muted">
                {agent.description || "—"}
              </p>
              {stats && (
                <p className="mt-1 w-full truncate text-[10px] text-maestro-muted">{stats}</p>
              )}
              <ToolStatsRow agent={agent} />
            </button>
          );
        })}
      </div>

      {/* Exchange drawer: the full brief and report for one agent. */}
      {openAgent && (
        <div className="absolute inset-0 z-20 flex flex-col bg-maestro-bg/98 backdrop-blur-sm">
          <div className="flex items-start gap-2 border-b border-maestro-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-maestro-text">
                {openAgent.agentType}
                {openAgent.description ? ` — ${openAgent.description}` : ""}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-maestro-muted">
                {[
                  agentBadge(openAgent).label,
                  openAgent.agentRunId,
                  openAgent.model,
                  openAgent.durationMs !== null ? formatDuration(openAgent.durationMs) : null,
                  openAgent.totalTokens !== null
                    ? `${openAgent.totalTokens.toLocaleString()} tok`
                    : null,
                  openAgent.toolUseCount !== null ? `${openAgent.toolUseCount} tool calls` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpenAgentId(null)}
              aria-label="Close agent detail"
              title="Close"
              className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <ExchangeBlock
              title="Brief sent ↓"
              text={openAgent.prompt}
              empty="This spawn recorded no prompt."
            />
            <ExchangeBlock
              title="Report back ↑"
              text={openAgent.report}
              empty={
                openAgent.completedAt === null
                  ? "Still running — the report arrives when it finishes."
                  : "No report was recorded for this agent."
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
