import { useMemo } from "react";
import { Network } from "lucide-react";
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
const NODE_W = 240;
const NODE_H = 64;
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

/** Badge for a subagent node — same classes as the sidebar's agent rows. */
function agentBadge(agent: SubagentInfo): { label: string; cls: string } {
  return agent.completedAt === null
    ? { label: "RUNNING", cls: "bg-maestro-blue/15 text-maestro-blue animate-pulse" }
    : agent.success === false
      ? { label: "FAILED", cls: "bg-red-500/15 text-red-400" }
      : { label: "DONE", cls: "bg-maestro-green/15 text-maestro-green" };
}

/** Edge color via CSS vars so the light theme (swapped vars) keeps working. */
function edgeStroke(agent: SubagentInfo): string {
  if (agent.completedAt === null) return "rgb(var(--maestro-blue))";
  if (agent.success === false) return "rgb(var(--maestro-red))";
  return "rgb(var(--maestro-border))";
}

/**
 * Live node graph of the agents running inside one terminal session.
 *
 * Structure is the honest one the app actually tracks: a single root node
 * (the main session, from useSessionStore) fanned out to the subagents the
 * transcript watcher reported for that session (useAgentStore — Task tool
 * spawns/completions). No parent->child nesting exists in the events, so the
 * graph is always 1 root -> N children.
 *
 * Self-subscribing (no props beyond sessionId) so mounting one per terminal
 * doesn't re-render every terminal on each agent event. Updates are live via
 * the zustand subscriptions — claude-event -> useAgentStore -> re-render.
 */
export function AgentGraph({ sessionId }: AgentGraphProps) {
  const agents = useAgentStore((s) => s.agents);
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
      style={{ width: ROOT_W, height: NODE_H }}
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

  /* ── Layout: root at left, children stacked in a right column ── */
  const n = sessionAgents.length;
  const stackH = n * NODE_H + (n - 1) * V_GAP;
  const contentW = PAD * 2 + ROOT_W + COL_GAP + NODE_W;
  const contentH = PAD * 2 + Math.max(NODE_H, stackH);
  const rootX = PAD;
  const rootY = PAD + Math.max(0, (stackH - NODE_H) / 2);
  const childX = PAD + ROOT_W + COL_GAP;
  const rootRight = rootX + ROOT_W;
  const rootMidY = rootY + NODE_H / 2;
  const midX = rootRight + COL_GAP / 2;

  return (
    <div className="relative h-full w-full overflow-auto bg-maestro-bg">
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
          return (
            <div
              key={agent.agentId}
              className={`absolute flex flex-col justify-center overflow-hidden rounded-lg border bg-maestro-card px-3 py-2 text-maestro-text ${
                running ? "border-maestro-accent/60" : "border-maestro-border"
              }`}
              style={{
                left: childX,
                top: PAD + i * (NODE_H + V_GAP),
                width: NODE_W,
                height: NODE_H,
              }}
              title={agent.description || agent.agentType}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {agent.agentType}
                </span>
                <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
              </div>
              <p className="mt-1 truncate text-[11px] text-maestro-muted">
                {agent.description || "—"}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
