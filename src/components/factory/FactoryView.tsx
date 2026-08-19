import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ExternalLink, Factory, RefreshCw, Send, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import { type ActRun, type ActSpecInput, isTerminal, runNeedsYou, stageSummary } from "@/lib/act";
import { ACT_STALE_MS, useActStore } from "@/stores/useActStore";

interface FactoryViewProps {
  onClose: () => void;
}

/** Poll faster while the factory is on screen; Home's 5-min tick covers the rest. */
const POLL_INTERVAL_MS = 30 * 1000;

/** ACT portal statuses → badge colours (Maestro semantics: blue working, green done). */
const RUN_BADGES: Record<string, string> = {
  queued: "bg-maestro-muted/15 text-maestro-muted",
  planning: "bg-maestro-blue/15 text-maestro-blue",
  running: "bg-maestro-blue/15 text-maestro-blue",
  completed: "bg-maestro-green/15 text-maestro-green",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-maestro-muted/15 text-maestro-muted",
};

function runBadge(status: string): string {
  return RUN_BADGES[status] ?? "bg-maestro-muted/15 text-maestro-muted";
}

function relAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const fieldClass =
  "w-full rounded border border-maestro-border bg-maestro-card px-2 py-1.5 text-[12px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent/50 focus:outline-none";
const labelClass = "text-[10px] font-semibold uppercase tracking-wider text-maestro-muted";

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The spec form: what ACT needs to replace a developer for one task. */
function SpecForm() {
  const { submit, isSubmitting, submitOutcome } = useActStore();
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [audience, setAudience] = useState("");
  const [mustHaves, setMustHaves] = useState("");
  const [nonGoals, setNonGoals] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");

  const canSubmit = title.trim() && problem.trim() && !isSubmitting;

  const handleSubmit = useCallback(() => {
    const spec: ActSpecInput = {
      title: title.trim(),
      problem: problem.trim(),
      audience: audience.trim(),
      mustHaves: linesToList(mustHaves),
      nonGoals: linesToList(nonGoals),
      successCriteria: linesToList(successCriteria),
    };
    void submit(spec).then((outcome) => {
      if (outcome?.accepted) {
        setTitle("");
        setProblem("");
        setAudience("");
        setMustHaves("");
        setNonGoals("");
        setSuccessCriteria("");
      }
    });
  }, [title, problem, audience, mustHaves, nonGoals, successCriteria, submit]);

  return (
    <div className="flex w-80 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-maestro-border p-3">
      <h2 className={labelClass}>Hand ACT a spec</h2>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Title</span>
        <input
          className={fieldClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What to build"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Problem</span>
        <textarea
          className={`${fieldClass} min-h-20 resize-y`}
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          placeholder="What hurts today, and for whom"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Audience</span>
        <input
          className={fieldClass}
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          placeholder="Who uses the result"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Must haves (one per line)</span>
        <textarea
          className={`${fieldClass} min-h-16 resize-y`}
          value={mustHaves}
          onChange={(e) => setMustHaves(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Non-goals (one per line)</span>
        <textarea
          className={`${fieldClass} min-h-16 resize-y`}
          value={nonGoals}
          onChange={(e) => setNonGoals(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Success criteria (one per line)</span>
        <textarea
          className={`${fieldClass} min-h-16 resize-y`}
          value={successCriteria}
          onChange={(e) => setSuccessCriteria(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleSubmit}
        className="flex items-center justify-center gap-1.5 rounded border border-maestro-accent/50 px-2 py-1.5 text-[12px] font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/10 disabled:opacity-40"
      >
        <Send size={12} />
        {isSubmitting ? "Handing over…" : "Start the run"}
      </button>
      {submitOutcome && (
        <p
          className={`rounded border px-2 py-1.5 text-[11px] ${
            submitOutcome.accepted
              ? "border-maestro-green/40 text-maestro-green"
              : "border-maestro-yellow/40 text-maestro-yellow"
          }`}
        >
          {submitOutcome.accepted
            ? `Run queued (${submitOutcome.complexity ?? "complexity pending"}).`
            : submitOutcome.httpStatus === 429
              ? `ACT is at its in-flight limit (${submitOutcome.currentInFlight ?? "?"}/${submitOutcome.limit ?? "?"}). Try again when a run finishes.`
              : submitOutcome.httpStatus === 402
                ? "ACT's token budget is exhausted for today."
                : (submitOutcome.error ?? "ACT rejected the spec.")}
        </p>
      )}
    </div>
  );
}

function RunRow({ run, gated, onOpen }: { run: ActRun; gated: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded border border-maestro-border bg-maestro-card px-3 py-2 text-left transition-colors hover:border-maestro-muted/50"
    >
      <span className={`${badgeBaseClass} ${runBadge(run.status)}`}>
        {run.status.toUpperCase()}
      </span>
      {gated && (
        <span className={`${badgeBaseClass} bg-maestro-accent/15 text-maestro-accent`}>
          NEEDS YOU
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-maestro-text">
        {run.title}
      </span>
      <span className="hidden max-w-56 truncate text-[10px] text-maestro-muted lg:block">
        {stageSummary(run)}
      </span>
      <span className="shrink-0 text-[10px] text-maestro-muted">{relAgo(run.updatedAt)}</span>
      {run.repoUrl && <ExternalLink size={11} className="shrink-0 text-maestro-muted" />}
    </button>
  );
}

/** One run, opened: stages, the gate when there is one, the PR when done. */
function RunDetail({ onBack }: { onBack: () => void }) {
  const { detail, detailError, cancelRun, resolveGate } = useActStore();
  if (!detail) return null;
  const gated = runNeedsYou(detail);
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Back to runs"
        >
          <ArrowLeft size={14} />
        </button>
        <span className={`${badgeBaseClass} ${runBadge(detail.status)}`}>
          {detail.status.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-maestro-text">
          {detail.title}
        </span>
        {!isTerminal(detail.status) && (
          <button
            type="button"
            onClick={() => void cancelRun(detail.id)}
            className="rounded border border-maestro-border px-1.5 py-0.5 text-[11px] text-maestro-muted transition-colors hover:border-red-500/50 hover:text-red-400"
          >
            Cancel run
          </button>
        )}
      </div>

      {detailError && <p className="text-[11px] text-maestro-yellow">{detailError}</p>}

      <div className="flex flex-wrap gap-1.5">
        {detail.stages.map((s) => (
          <span
            key={s.name}
            className={`${badgeBaseClass} ${
              s.status === "completed"
                ? "bg-maestro-green/15 text-maestro-green"
                : s.status === "running"
                  ? "bg-maestro-blue/15 text-maestro-blue animate-pulse"
                  : "bg-maestro-muted/15 text-maestro-muted"
            }`}
          >
            {s.name}
          </span>
        ))}
      </div>

      {gated && (
        <div className="flex flex-col gap-2 rounded border border-maestro-accent/40 p-3">
          <span className="text-[11px] font-semibold text-maestro-accent">
            Stopped at a confidence gate — the run is waiting on you.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => detail.task?.id && void resolveGate(detail.task.id, true)}
              className="rounded border border-maestro-green/50 px-2 py-1 text-[11px] text-maestro-green transition-colors hover:bg-maestro-green/10"
            >
              Approve and continue
            </button>
            <button
              type="button"
              onClick={() => detail.task?.id && void resolveGate(detail.task.id, false)}
              className="rounded border border-red-500/50 px-2 py-1 text-[11px] text-red-400 transition-colors hover:bg-red-500/10"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {detail.repoUrl && (
        <button
          type="button"
          onClick={() =>
            detail.repoUrl &&
            void openUrl(detail.repoUrl).catch((err) => console.error("Failed to open:", err))
          }
          className="flex w-fit items-center gap-1.5 rounded border border-maestro-border px-2 py-1 text-[11px] text-maestro-text transition-colors hover:border-maestro-green/50"
        >
          <ExternalLink size={11} /> Open the result
        </button>
      )}

      {detail.error && (
        <p className="rounded border border-red-500/30 px-2 py-1.5 text-[11px] text-red-400">
          {detail.error}
        </p>
      )}
    </div>
  );
}

/**
 * Factory — the ACT lane. Hand a spec over on the left, watch runs on the
 * right, unblock a gated run in place. ACT unreachable renders as an offline
 * chip and yesterday's list, never an error wall.
 */
export function FactoryView({ onClose }: FactoryViewProps) {
  const { runs, gatedRuns, fetchedAt, error, isPolling, detail, refresh, openDetail, closeDetail } =
    useActStore();

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const gatedIds = new Set(gatedRuns.map((r) => r.id));
  const offline = fetchedAt === 0;
  const stale = !offline && (error !== null || Date.now() - fetchedAt > ACT_STALE_MS * 2);

  return (
    /* z-50: same overlay shell as Home/Landscape (eagle zoom is z-40). */
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
        <Factory size={13} className="text-maestro-muted" />
        <span className="text-[12px] font-semibold text-maestro-text">Factory</span>
        <span
          className={`${badgeBaseClass} ${
            offline
              ? "bg-maestro-muted/15 text-maestro-muted"
              : stale
                ? "bg-maestro-yellow/15 text-maestro-yellow"
                : "bg-maestro-green/15 text-maestro-green"
          }`}
          title={error ?? (offline ? "ACT has not answered yet" : "ACT is answering")}
        >
          {offline ? "ACT OFFLINE" : stale ? "ACT STALE" : "ACT LIVE"}
        </span>
        <span className="text-[11px] text-maestro-muted">
          {runs.length} run{runs.length === 1 ? "" : "s"}
          {gatedRuns.length > 0 && ` · ${gatedRuns.length} waiting on you`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isPolling}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
          aria-label="Refresh runs"
        >
          <RefreshCw size={13} className={isPolling ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Close factory"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <SpecForm />
        {detail ? (
          <RunDetail onBack={closeDetail} />
        ) : (
          <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-3">
            {runs.length === 0 ? (
              <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
                {offline
                  ? "ACT is not answering. Start it, then refresh — the factory picks it straight up."
                  : "No runs yet. Hand over a spec on the left."}
              </p>
            ) : (
              runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  gated={gatedIds.has(run.id)}
                  onOpen={() => void openDetail(run.id)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
