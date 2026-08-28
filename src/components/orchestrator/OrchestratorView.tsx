import { Check, Play, RadioTower, RefreshCw, Send, ShieldCheck, ShieldOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  isProposalExpired,
  type Proposal,
  type ProposalStatus,
  proposalPreview,
  type ScopeEntry,
} from "@/lib/orchestrator";
import { ORCHESTRATOR_SESSION_NAME, useOrchestratorStore } from "@/stores/useOrchestratorStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

interface OrchestratorViewProps {
  onClose: () => void;
}

/**
 * The queue is a file drop, so it only changes as fast as the orchestrator
 * writes. Matches rohcna's panel cadence — fast enough that an approval feels
 * immediate, slow enough to be free.
 */
const POLL_INTERVAL_MS = 1500;

const STATUS_BADGES: Record<ProposalStatus, string> = {
  pending: "bg-maestro-blue/15 text-maestro-blue",
  approved: "bg-maestro-blue/15 text-maestro-blue",
  sent: "bg-maestro-green/15 text-maestro-green",
  rejected: "bg-maestro-muted/15 text-maestro-muted",
  expired: "bg-maestro-muted/15 text-maestro-muted",
  blocked: "bg-amber-500/15 text-amber-400",
  error: "bg-red-500/15 text-red-400",
};

const labelClass = "text-[10px] font-semibold uppercase tracking-wider text-maestro-muted";
const fieldClass =
  "w-full rounded border border-maestro-border bg-maestro-card px-2 py-1.5 text-[12px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent/50 focus:outline-none";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** How a session reads in the scope list and on a proposal. */
export function sessionLabel(session: SessionConfig): string {
  const name = session.name?.trim();
  const where = basename(session.worktree_path ?? session.project_path);
  const base = name && name.length > 0 ? name : where;
  return session.branch ? `${base} — ${session.branch}` : base;
}

/** One proposal awaiting (or past) a decision. */
function ProposalRow({
  proposal,
  targetLabel,
  onDecide,
}: {
  proposal: Proposal;
  targetLabel: string;
  onDecide: (approve: boolean) => void;
}) {
  const decidable = proposal.status === "pending";
  return (
    <div className="rounded border border-maestro-border bg-maestro-card p-2">
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_BADGES[proposal.status]}`}
        >
          {proposal.status}
        </span>
        <span className="truncate text-[11px] text-maestro-text">→ {targetLabel}</span>
      </div>
      {proposal.note && <p className="mt-1 text-[11px] text-maestro-muted">{proposal.note}</p>}
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-maestro-text">
        {proposalPreview(proposal)}
      </p>
      {proposal.error && <p className="mt-1 text-[11px] text-red-400">{proposal.error}</p>}
      {decidable && (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={() => onDecide(true)}
            className="rounded bg-maestro-green/15 px-2 py-1 text-[11px] font-semibold text-maestro-green transition-colors hover:bg-maestro-green/25"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide(false)}
            className="rounded bg-maestro-card px-2 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Orchestrator — a goal box over one headless session, scoped to the sessions
 * you tick, with everything it wants to say to them held in an approval queue.
 *
 * The orchestrator itself is an ordinary Maestro session (launched down the
 * normal `PendingLaunch` path), so it shows up as a terminal you can watch and
 * close like any other. It has no route into the other sessions except this
 * queue.
 */
export function OrchestratorView({ onClose }: OrchestratorViewProps) {
  const { proposals, safeMode, scope, sessionId, error, refresh, setSafeMode, setScope, decide } =
    useOrchestratorStore();
  const setSessionId = useOrchestratorStore((s) => s.setSessionId);
  const launch = useOrchestratorStore((s) => s.launch);
  const sendGoal = useOrchestratorStore((s) => s.sendGoal);
  const clear = useOrchestratorStore((s) => s.clear);

  const sessions = useSessionStore((s) => s.sessions);
  const activeTab = useWorkspaceStore((s) => s.tabs.find((t) => t.active) ?? null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The orchestrator is found by the name it launches under, so closing and
  // reopening this panel — or restarting the app — re-attaches to the running
  // one instead of starting a second.
  const orchestratorSession = useMemo(
    () => sessions.find((s) => s.name === ORCHESTRATOR_SESSION_NAME) ?? null,
    [sessions],
  );
  useEffect(() => {
    setSessionId(orchestratorSession?.id ?? null);
  }, [orchestratorSession, setSessionId]);

  /** Everything the orchestrator could be pointed at — never itself. */
  const drivable = useMemo(
    () => sessions.filter((s) => s.id !== orchestratorSession?.id),
    [sessions, orchestratorSession],
  );

  const labelFor = useCallback(
    (targetSessionId: number): string => {
      const session = sessions.find((s) => s.id === targetSessionId);
      return session ? sessionLabel(session) : `session ${targetSessionId}`;
    },
    [sessions],
  );

  const toggleScope = useCallback(
    (session: SessionConfig) => {
      const next: ScopeEntry[] = scope.some((e) => e.sessionId === session.id)
        ? scope.filter((e) => e.sessionId !== session.id)
        : [
            ...scope,
            {
              sessionId: session.id,
              label: sessionLabel(session),
              cwd: session.working_directory ?? session.worktree_path ?? session.project_path,
            },
          ];
      void setScope(next);
    },
    [scope, setScope],
  );

  const handleSend = useCallback(() => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    const done = () => {
      setGoal("");
      setBusy(false);
    };
    if (sessionId === null) {
      // First goal starts the session, exactly as rohcna's panel does: the
      // brief and the goal go out together as the launch prompt.
      if (!activeTab) {
        setBusy(false);
        return;
      }
      void launch(activeTab.id, activeTab.projectPath, goal).then(done);
    } else {
      void sendGoal(goal).then(done);
    }
  }, [goal, busy, sessionId, activeTab, launch, sendGoal]);

  const now = Date.now();
  // Expiry is lazy backend-side, so a row can be past its TTL between polls;
  // showing it as still-decidable would offer a button that cannot fire.
  const pending = proposals.filter((p) => p.status === "pending" && !isProposalExpired(p, now));
  const history = proposals
    .filter((p) => !pending.includes(p))
    .slice(-30)
    .reverse();

  return (
    /* z-50: same overlay shell as Home/Factory/Landscape (eagle zoom is z-40). */
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
        <RadioTower size={13} className="text-maestro-muted" />
        <span className="text-[12px] font-semibold text-maestro-text">Orchestrator</span>
        <span className="text-[11px] text-maestro-muted">
          {sessionId === null ? "not running" : "running"}
          {pending.length > 0 && ` · ${pending.length} waiting on you`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void setSafeMode(!safeMode)}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
            safeMode
              ? "bg-maestro-green/15 text-maestro-green hover:bg-maestro-green/25"
              : "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
          }`}
          title={
            safeMode
              ? "Safe mode: every proposal waits for your approval"
              : "Free run: proposals are pre-approved and delivered as they arrive"
          }
        >
          {safeMode ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
          {safeMode ? "Safe mode" : "Free run"}
        </button>
        <button
          type="button"
          onClick={() => void clear()}
          className="rounded px-2 py-1 text-[11px] text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          title="Fresh start — drop the queue and the scope. Safe mode stays as it is."
        >
          Fresh start
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Refresh queue"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Close orchestrator"
        >
          <X size={14} />
        </button>
      </div>

      {!safeMode && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-400">
          Free run: proposals are delivered to your sessions without asking. Turn safe mode back on
          to review them first.
        </div>
      )}
      {error && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400">
          {error}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-80 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-maestro-border p-3">
          <h2 className={labelClass}>Goal</h2>
          <textarea
            className={`${fieldClass} min-h-24 resize-y`}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              scope.length > 0
                ? `What should the ${scope.length} scoped session(s) get done?`
                : "What should the fleet get done?"
            }
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!goal.trim() || busy || (sessionId === null && !activeTab)}
            className="flex items-center justify-center gap-1.5 rounded bg-maestro-accent/15 px-2 py-1.5 text-[12px] font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/25 disabled:opacity-40"
          >
            {sessionId === null ? <Play size={12} /> : <Send size={12} />}
            {sessionId === null ? "Start orchestrator" : "Send goal"}
          </button>
          {sessionId === null && !activeTab && (
            <p className="text-[11px] text-maestro-muted/70">
              Open a project tab first — the orchestrator launches into it like any other session.
            </p>
          )}

          <h2 className={`${labelClass} mt-2`}>
            Scope {scope.length > 0 ? `(${scope.length})` : "— all sessions"}
          </h2>
          <p className="text-[11px] text-maestro-muted/70">
            Tick the sessions this goal may touch. A proposal for anything else is blocked, not
            queued.
          </p>
          {drivable.length === 0 ? (
            <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
              No other sessions running.
            </p>
          ) : (
            drivable.map((session) => {
              const ticked = scope.some((e) => e.sessionId === session.id);
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => toggleScope(session)}
                  className={`flex items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors ${
                    ticked
                      ? "border-maestro-accent/50 bg-maestro-accent/10 text-maestro-text"
                      : "border-maestro-border bg-maestro-card text-maestro-muted hover:text-maestro-text"
                  }`}
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                      ticked
                        ? "border-maestro-accent bg-maestro-accent/20 text-maestro-accent"
                        : "border-maestro-border"
                    }`}
                  >
                    {ticked && <Check size={10} />}
                  </span>
                  <span className="truncate">{sessionLabel(session)}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-3">
          <h2 className={labelClass}>
            {pending.length > 0
              ? `${pending.length} proposed message${pending.length === 1 ? "" : "s"} — approve to send`
              : "Proposal queue"}
          </h2>
          {pending.length === 0 && history.length === 0 ? (
            <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
              {sessionId === null
                ? "Give the orchestrator a goal to begin. Everything it wants to say to your sessions lands here first."
                : "Nothing proposed yet. It reads your sessions before it suggests anything."}
            </p>
          ) : (
            <>
              {pending.map((proposal) => (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  targetLabel={labelFor(proposal.targetSessionId)}
                  onDecide={(approve) => void decide(proposal.id, approve)}
                />
              ))}
              {history.length > 0 && <h2 className={`${labelClass} mt-2`}>Recent</h2>}
              {history.map((proposal) => (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  targetLabel={labelFor(proposal.targetSessionId)}
                  onDecide={() => {}}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
