import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ExternalLink,
  Factory,
  RefreshCw,
  Send,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ControlPanel } from "@/components/factory/control/ControlPanel";
import { relAgo } from "@/components/factory/control/primitives";
import { EngineBadge } from "@/components/factory/EngineBadge";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import { type ActRun, type ActSpecInput, isTerminal, runNeedsYou, stageSummary } from "@/lib/act";
import { useActControlStore } from "@/stores/useActControlStore";
import { useActEngineStore } from "@/stores/useActEngineStore";
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
            ? `Run queued (${submitOutcome.complexity ?? "complexity pending"}${
                submitOutcome.stages?.length ? `, stages: ${submitOutcome.stages.join(", ")}` : ""
              }).`
            : submitOutcome.httpStatus === 429
              ? `ACT is at its in-flight limit (${submitOutcome.currentInFlight ?? "?"}/${submitOutcome.limit ?? "?"}). Try again when a run finishes.`
              : submitOutcome.httpStatus === 402
                ? `ACT's token budget is exhausted (${submitOutcome.usedTokens ?? "?"} of ${submitOutcome.capTokens ?? "?"} used, ${submitOutcome.remainingTokens ?? 0} left).`
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
  const { detail, detailGates, detailError, cancelRun, unblockTask, resolveGate } = useActStore();
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
            Stopped on low confidence: the run is waiting on you.
          </span>
          <div className="flex gap-2">
            {/* Low-confidence blocks live on the TASK, not in the gates
                subsystem — clearing one goes through the tasks route
                (review b43c16d, HIGH #1). */}
            <button
              type="button"
              onClick={() => detail.task?.id && void unblockTask(detail.task.id, true)}
              className="rounded border border-maestro-green/50 px-2 py-1 text-[11px] text-maestro-green transition-colors hover:bg-maestro-green/10"
            >
              Approve and continue
            </button>
            <button
              type="button"
              onClick={() => detail.task?.id && void unblockTask(detail.task.id, false)}
              className="rounded border border-red-500/50 px-2 py-1 text-[11px] text-red-400 transition-colors hover:bg-red-500/10"
              title="Archives the task; the run will not continue"
            >
              Reject and archive
            </button>
          </div>
        </div>
      )}

      {detailGates.length > 0 && (
        <div className="flex flex-col gap-2 rounded border border-maestro-yellow/40 p-3">
          <span className="text-[11px] font-semibold text-maestro-yellow">
            Pipeline gate{detailGates.length === 1 ? "" : "s"} waiting for a decision.
          </span>
          {detailGates.map((gate) => (
            <div key={gate.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-text">
                {gate.title}
              </span>
              {gate.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => void resolveGate(gate.id, option)}
                  className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                    option === "approve"
                      ? "border-maestro-green/50 text-maestro-green hover:bg-maestro-green/10"
                      : "border-maestro-border text-maestro-muted hover:text-maestro-text"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          ))}
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

type FactoryTab = "runs" | "control";

/**
 * Factory — the ACT lane. Two tabs over one engine: Runs hands a spec over and
 * watches it through, Control shows and sets what the engine is allowed to do
 * on its own. ACT unreachable renders as an offline chip and yesterday's list,
 * never an error wall.
 */
export function FactoryView({ onClose }: FactoryViewProps) {
  const [tab, setTab] = useState<FactoryTab>("runs");
  const { runs, gatedRuns, fetchedAt, error, isPolling, detail, refresh, openDetail, closeDetail } =
    useActStore();

  const refreshEngine = useActEngineStore((state) => state.refresh);
  const refreshControl = useActControlStore((state) => state.refreshAll);
  /* The two lanes poll separately, so the header control has to follow
     whichever one is on screen rather than the runs poller alone. */
  const isControlPolling = useActControlStore((state) => state.isPolling);
  const tabIsPolling = tab === "control" ? isControlPolling : isPolling;
  const engineState = useActEngineStore((state) => state.status?.state ?? null);

  useEffect(() => {
    void refresh();
    void refreshEngine();
    const timer = setInterval(() => {
      void refresh();
      void refreshEngine();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, refreshEngine]);

  const gatedIds = new Set(gatedRuns.map((r) => r.id));
  const offline = fetchedAt === 0;
  /* fetchedAt changes on every successful poll, so this recomputes at least
     once per interval; a stricter clock would need a render tick for no
     user-visible gain (review b43c16d, LOW). */
  const stale = !offline && (error !== null || Date.now() - fetchedAt > ACT_STALE_MS);

  return (
    /* z-50: same overlay shell as Home/Landscape (eagle zoom is z-40). */
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
        <Factory size={13} className="text-maestro-muted" />
        <span className="text-[12px] font-semibold text-maestro-text">Factory</span>
        <EngineBadge runsFetchedAt={fetchedAt} stale={stale} />
        <div className="flex overflow-hidden rounded border border-maestro-border">
          {(
            [
              ["runs", "Runs", Factory],
              ["control", "Control", SlidersHorizontal],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium transition-colors ${
                tab === id
                  ? "bg-maestro-accent/20 text-maestro-accent"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              }`}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>
        {tab === "runs" && (
          <span className="text-[11px] text-maestro-muted">
            {runs.length} run{runs.length === 1 ? "" : "s"}
            {gatedRuns.length > 0 && ` · ${gatedRuns.length} waiting on you`}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            void (tab === "control" ? refreshControl() : refresh());
          }}
          disabled={tabIsPolling}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
          aria-label={tab === "control" ? "Refresh control panel" : "Refresh runs"}
        >
          <RefreshCw size={13} className={tabIsPolling ? "animate-spin" : ""} />
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
        {tab === "control" && <ControlPanel />}
        {tab === "runs" && <SpecForm />}
        {tab === "runs" &&
          (detail ? (
            <RunDetail onBack={closeDetail} />
          ) : (
            <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-3">
              {runs.length === 0 ? (
                <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
                  {engineState === "starting"
                    ? "ACT is starting. The list fills itself as soon as it answers."
                    : offline
                      ? "ACT is not running. Press Start ACT above and the factory picks it up on its own."
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
          ))}
      </div>
    </div>
  );
}
