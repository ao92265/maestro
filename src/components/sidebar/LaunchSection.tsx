import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FolderGit2,
  Loader2,
  RefreshCw,
  Rocket,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { samePath } from "@/lib/path";
import {
  type SamuraiPreflight,
  type SamuraiRunConfig,
  type SamuraiTestGateProgress,
  samuraiCleanupEpic,
  samuraiLaunchRun,
  samuraiListRuns,
  samuraiPreflight,
} from "@/lib/samurai";
import type { UsageData } from "@/lib/usageParser";
import { useSamuraiWorkflowStore } from "@/stores/useSamuraiWorkflowStore";
import { useUsageStore } from "@/stores/useUsageStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";
import { WorkflowGraphEditor } from "./WorkflowGraphEditor";

/** Last path segment, for compact project display. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Models the run can be pinned to, plus the allowance window each one draws
 * from. `family` keys the usage lookup, not the CLI: the usage API reports
 * per-model weeklies under human labels ("Week (Opus)"), while `value` is
 * what reaches `claude --model`. Empty `value` = no `--model` flag at all.
 */
const MODEL_OPTIONS: { value: string; label: string; family: string | null }[] = [
  { value: "", label: "Default", family: null },
  { value: "claude-opus-5", label: "Opus 5", family: "opus" },
  { value: "claude-sonnet-5", label: "Sonnet 5", family: "sonnet" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku" },
  { value: "claude-fable-5", label: "Fable 5", family: "fable" },
];

/**
 * Percent of this model's weekly allowance still available, or null when the
 * API reports no window for it (enterprise seats report a spend budget
 * instead, and not every model gets its own window). Null is "unknown", NOT
 * zero — the caller must render the difference, or a model with plenty left
 * reads as exhausted.
 */
function allowanceLeft(usage: UsageData | null, family: string | null): number | null {
  if (!usage || !family) return null;
  const dedicated =
    family === "opus"
      ? usage.weeklyOpusPercent
      : family === "sonnet"
        ? usage.weeklySonnetPercent
        : null;
  // Models without a dedicated top-level window (Fable, Haiku) only ever
  // appear in the `limits`-derived list.
  const used =
    dedicated ??
    usage.modelWindows.find((w) => w.label.toLowerCase().includes(family))?.percent ??
    null;
  if (used === null || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

/** Allowance-left colouring: green plenty, amber tight, red nearly gone. */
function allowanceClass(left: number | null): string {
  if (left === null) return "text-maestro-muted/60";
  if (left <= 10) return "text-maestro-red";
  if (left <= 25) return "text-maestro-orange";
  return "text-maestro-green";
}

/** One pass/fail preflight row. */
function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px]">
      {ok ? (
        <CheckCircle2 size={12} className="mt-px shrink-0 text-maestro-green" />
      ) : (
        <XCircle size={12} className="mt-px shrink-0 text-maestro-red" />
      )}
      <span className={ok ? "text-maestro-text" : "text-maestro-red"}>
        {label}
        {detail ? <span className="text-maestro-muted"> — {detail}</span> : null}
      </span>
    </div>
  );
}

/**
 * Model picker. A listbox rather than a native `<select>` so each row can put
 * the model on the left and its remaining allowance on the right — the whole
 * point is choosing a model by what is left to spend on it.
 */
function ModelPicker({
  value,
  onChange,
  usage,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  usage: UsageData | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = MODEL_OPTIONS.find((m) => m.value === value) ?? MODEL_OPTIONS[0];
  const selectedLeft = allowanceLeft(usage, selected.family);

  // Close on outside click / Escape. Bound only while open so an unopened
  // picker costs no global listeners (this panel can sit mounted for hours).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id="samurai-launch-model"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-left text-[11px] text-maestro-text transition-colors hover:border-maestro-accent/60 disabled:opacity-40"
      >
        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
        {selectedLeft !== null && (
          <span className={`shrink-0 tabular-nums ${allowanceClass(selectedLeft)}`}>
            {selectedLeft}% left
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 text-maestro-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Model"
          className="absolute z-20 mt-0.5 w-full overflow-hidden rounded border border-maestro-border bg-maestro-bg shadow-lg"
        >
          {MODEL_OPTIONS.map((option) => {
            const left = allowanceLeft(usage, option.family);
            return (
              <button
                key={option.value || "default"}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors hover:bg-maestro-surface ${
                  option.value === value ? "text-maestro-accent" : "text-maestro-text"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className={`shrink-0 tabular-nums text-[10px] ${allowanceClass(left)}`}>
                  {left === null ? "—" : `${left}% left`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One listed run (live or finished-awaiting-cleanup) with its cleanup action. */
function RunRow({
  run,
  onCleanup,
  busy,
}: {
  run: SamuraiRunConfig;
  onCleanup: (run: SamuraiRunConfig) => void;
  busy: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-maestro-surface"
      title={`worktree: ${run.worktree_path}\nrepo pin: ${run.repo_pin ?? "none"}\ncreated: ${run.created_at}`}
    >
      {/* Issue #96: a COMPLETED run is verified finished (all issues closed,
          PR open) and only awaits the manual cleanup — visually distinct
          from a live ACTIVE run. */}
      {run.status === "COMPLETED" ? (
        <span
          className="shrink-0 rounded bg-maestro-accent/20 px-1 py-px text-[9px] font-bold tracking-wide text-maestro-accent"
          title="Run verified complete — every issue closed, PR open. Awaiting cleanup."
        >
          FINISHED
        </span>
      ) : (
        <span className="shrink-0 rounded bg-maestro-green/20 px-1 py-px text-[9px] font-bold tracking-wide text-maestro-green">
          ACTIVE
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-maestro-text">
        {run.epic}
        <span className="text-maestro-muted"> · {baseName(run.project_path)}</span>
        {run.model ? <span className="text-maestro-muted"> · {run.model}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => onCleanup(run)}
        disabled={busy}
        className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
        aria-label={`Clean up epic ${run.epic}`}
        title="Delete this epic's worktree and branch, cancel its timer, archive its run config (asks first)"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** Field label, shared by every row in the launch form. */
function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      title={hint}
      className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-maestro-muted"
    >
      {children}
    </label>
  );
}

/** What the Launch button is doing right now (null = idle). */
type LaunchPhase = "preflight" | "spawning";

const PHASE_LABEL: Record<LaunchPhase, string> = {
  preflight: "Checking gh auth + allowance…",
  spawning: "Creating worktree, spawning gen-1…",
};

/** Gate steps that are still running (issue #90b) — the ones worth a live
 *  progress row; `passed`/`failed` resolve through the launch promise. */
const GATE_RUNNING_STEPS: SamuraiTestGateProgress["step"][] = [
  "bootstrap_npm",
  "bootstrap_mcp",
  "cargo_test",
];

/**
 * Samurai run launcher (issue #63, PRD §5.8 + §9): the form that starts an
 * autonomous run — project (the active tab, read-only), the issues to work,
 * an optional model pinned by remaining allowance, an optional handoff
 * override — behind ONE Launch button that runs preflight itself and reports
 * the phase it is in. Below it, the active runs (`samurai_list_runs`) with
 * per-run destructive cleanup behind the same ask()-confirm pattern as the
 * audit clear.
 */
export function LaunchSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  const usage = useUsageStore((s) => s.usage);
  const startPolling = useUsageStore((s) => s.startPolling);
  useEffect(() => startPolling(), [startPolling]);

  // Issue #91: the edited workflow graph (null = never edited — the backend
  // then compiles its default template). Whatever this holds at launch is
  // snapshotted into the run config.
  const workflow = useSamuraiWorkflowStore((s) => s.graph);

  const [epic, setEpic] = useState("");
  const [model, setModel] = useState("");
  // Review F4: optional per-run handoff trigger override. Empty = the
  // global config applies (backend stores thresholds: None).
  const [handoffPct, setHandoffPct] = useState("");
  // Issue #90b: the explicit red-baseline override. Default OFF — the gate
  // runs and a red `cargo test --workspace` blocks the launch.
  const [skipGate, setSkipGate] = useState(false);
  // The latest test-gate tick plus when it arrived, so the elapsed display
  // keeps counting between backend ticks (cargo test is one long step).
  const [gate, setGate] = useState<{ progress: SamuraiTestGateProgress; at: number } | null>(null);
  // 1 Hz re-render while the gate line is showing (drives the elapsed time).
  const [, setGateTick] = useState(0);
  const [preflight, setPreflight] = useState<SamuraiPreflight | null>(null);
  // The project a running launch belongs to — a result that outlives a tab
  // switch is dropped rather than applied to the newly active project.
  const currentProjectRef = useRef(projectPath);
  const [phase, setPhase] = useState<LaunchPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // null = loading.
  const [runs, setRuns] = useState<SamuraiRunConfig[] | null>(null);
  const [cleaningEpic, setCleaningEpic] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await samuraiListRuns());
    } catch (err) {
      setRuns([]);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  // Preflight results are project-scoped — a stale pass must not leak onto
  // another project's form.
  useEffect(() => {
    currentProjectRef.current = projectPath;
    setPreflight(null);
    setError(null);
    setNotice(null);
    setGate(null);
  }, [projectPath]);

  // Issue #90b: live test-gate progress. The backend streams one tick per
  // gate step during the launch; other projects' ticks are skipped (the
  // AuditSection subscription pattern).
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen<SamuraiTestGateProgress>("samurai-test-gate-event", (e) => {
      if (!samePath(e.payload.project, currentProjectRef.current)) return;
      setGate({ progress: e.payload, at: Date.now() });
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // Event system unavailable (tests) — the launch still resolves.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Tick the elapsed display once a second while a gate step is running.
  const gateRunning =
    phase === "spawning" && gate !== null && GATE_RUNNING_STEPS.includes(gate.progress.step);
  useEffect(() => {
    if (!gateRunning) return;
    const id = setInterval(() => setGateTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [gateRunning]);

  const issueCount = useMemo(
    () => epic.split(",").filter((part) => part.trim().length > 0).length,
    [epic],
  );

  const canLaunch = Boolean(projectPath) && epic.trim().length > 0 && phase === null;

  const handleLaunch = async () => {
    // Review F4: an unparseable override is a form error, not a null.
    const pctText = handoffPct.trim();
    const pct = pctText === "" ? null : Number(pctText);
    if (pct !== null && !Number.isFinite(pct)) {
      setError("Handoff context % must be a number (or empty for the global default)");
      return;
    }
    // Mirror the backend's SamuraiConfig::validate range: 0 would make every
    // `percent >= threshold` test true and arm a permanent handoff loop, so
    // it is rejected here rather than surfacing as a launch failure.
    if (pct !== null && (pct <= 0 || pct > 100)) {
      setError("Handoff context % must be between 1 and 100 (or empty for the global default)");
      return;
    }

    const target = projectPath;
    setError(null);
    setNotice(null);
    setPreflight(null);
    setGate(null);

    // Phase 1 — preflight. The backend re-runs it inside the launch anyway;
    // running it here first is what lets a failure render as pass/fail rows
    // instead of one opaque refusal string.
    setPhase("preflight");
    let checks: SamuraiPreflight;
    try {
      checks = await samuraiPreflight(target);
    } catch (err) {
      if (currentProjectRef.current === target) {
        setError(String(err));
        setPhase(null);
      }
      return;
    }
    // Switched project mid-flight — the answer belongs to the old project.
    if (currentProjectRef.current !== target) {
      setPhase(null);
      return;
    }
    setPreflight(checks);
    if (!checks.gh_auth.ok || !checks.windows_reported) {
      setError("Preflight failed — fix the red checks below, then launch again.");
      setPhase(null);
      return;
    }

    // Phase 2 — the launch proper (worktree → test gate → gen-1 spawn).
    setPhase("spawning");
    try {
      const result = await samuraiLaunchRun(
        target,
        epic.trim(),
        model.trim() || null,
        pct,
        skipGate,
        workflow,
      );
      if (currentProjectRef.current !== target) return;
      setNotice(
        `Run launched: ${result.epic} on ${result.branch} (worktree ${result.worktree_path})${result.stale_timer_cancelled ? " — stale resume timer cancelled" : ""}`,
      );
      setEpic("");
      setHandoffPct("");
      setPreflight(null);
      await refreshRuns();
    } catch (err) {
      if (currentProjectRef.current === target) setError(String(err));
    } finally {
      setPhase(null);
      setGate(null);
    }
  };

  const handleCleanup = async (run: SamuraiRunConfig) => {
    // Destructive, never silent (PRD §5.9) — same ask() confirm pattern as
    // the audit clear.
    const confirmed = await ask(
      `Clean up epic ${run.epic}? This deletes its worktree and samurai branch, cancels its resume timer, and archives its run config. It cannot be undone.`,
      { title: "Clean Up Epic", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setCleaningEpic(run.epic);
    setError(null);
    setNotice(null);
    try {
      const report = await samuraiCleanupEpic(run.project_path, run.epic);
      const removed = [
        report.worktree_removed ? "worktree" : null,
        report.branch_deleted ? `branch ${report.branch}` : null,
        report.config_archived ? "run config" : null,
        report.timer_cancelled ? "resume timer" : null,
        report.spawn_cancelled ? "staged gen-1 spawn" : null,
      ].filter(Boolean);
      setNotice(
        removed.length > 0
          ? `Cleaned up epic ${report.epic}: removed ${removed.join(", ")}.`
          : `Epic ${report.epic} was already clean.`,
      );
      await refreshRuns();
    } catch (err) {
      setError(String(err));
    } finally {
      setCleaningEpic(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className={cardClass}>
        <SectionHeader icon={Rocket} label="Launch Run" iconColor="text-maestro-accent" />
        <p className="mb-2 text-[11px] text-maestro-muted">
          Start an autonomous Samurai run in its own worktree.
        </p>

        <div className="space-y-2">
          <div>
            <FieldLabel>Project</FieldLabel>
            {/* Read-only on purpose: the run follows the active project tab.
                Rendered as plain text, not a bordered box — an input frame
                around something you cannot type in reads as a broken field. */}
            <div
              className="flex items-center gap-1.5 px-0.5 text-[11px] text-maestro-text"
              title={projectPath || undefined}
            >
              <FolderGit2 size={11} className="shrink-0 text-maestro-muted" />
              <span className="truncate">
                {projectPath ? baseName(projectPath) : "No active project"}
              </span>
            </div>
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-epic"
              hint="A GitHub epic reference, a single issue, or several issues separated by commas. All of them are worked by one run, in one worktree."
            >
              Issues
            </FieldLabel>
            <input
              id="samurai-launch-epic"
              type="text"
              value={epic}
              onChange={(e) => setEpic(e.target.value)}
              placeholder="#38, or 77, 78"
              className="w-full rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
            />
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              An epic ref, one issue, or a comma-separated list.
              {issueCount > 1 ? ` ${issueCount} issues in one run.` : ""}
            </p>
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-model"
              hint="Which Claude model the run's agents use. The percentage is how much of that model's weekly allowance is still available."
            >
              Model
            </FieldLabel>
            <ModelPicker
              value={model}
              onChange={setModel}
              usage={usage}
              disabled={phase !== null}
            />
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-handoff-pct"
              hint="A long-running agent's answers decay as its context fills up. At this percentage the orchestrator writes its state to a handoff file and Maestro starts a fresh agent from it, so the work continues with a clean context. Lower = hands off sooner and more often; higher = fewer handoffs but more decay."
            >
              Handoff at context %
            </FieldLabel>
            <input
              id="samurai-launch-handoff-pct"
              type="number"
              min={1}
              max={100}
              value={handoffPct}
              onChange={(e) => setHandoffPct(e.target.value)}
              placeholder="40 (default)"
              className="w-full rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
            />
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              Hand this run to a fresh agent once the orchestrator's context is this full. Empty
              uses the default, 40%.
            </p>
          </div>

          <div>
            <label
              className="flex items-center gap-1.5 text-[11px] text-maestro-text"
              title="The launch bootstraps the epic worktree (npm install, mcp-server build) and runs `cargo test --workspace` in it first; a red suite blocks the launch. Tick this to skip that gate and launch anyway."
            >
              <input
                type="checkbox"
                checked={skipGate}
                onChange={(e) => setSkipGate(e.target.checked)}
                disabled={phase !== null}
                className="h-3 w-3 accent-maestro-accent"
              />
              Skip test-suite gate
            </label>
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              Off (default): the launch runs the worktree's test suite first and blocks on red.
            </p>
          </div>

          <div className="flex items-start gap-1.5 rounded border border-maestro-orange/40 bg-maestro-orange/10 p-1.5 text-[10px] leading-snug text-maestro-text">
            <AlertTriangle size={12} className="mt-px shrink-0 text-maestro-orange" />
            <span>
              Make sure the issues are agent-ready — clear scope and acceptance criteria, no open
              decisions — or the run cannot develop them autonomously. Generation 1 checks each
              issue first and reports any it cannot work.
            </span>
          </div>

          <button
            type="button"
            onClick={handleLaunch}
            disabled={!canLaunch}
            className="w-full rounded bg-maestro-accent/20 px-2 py-1 text-[11px] font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/30 disabled:opacity-40"
          >
            {phase ? (
              <span className="flex items-center justify-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                {/* Issue #90b: while the test gate runs, its live step (with
                    elapsed time, ticking between backend events) replaces
                    the generic spawning label. */}
                {gateRunning && gate
                  ? `${gate.progress.detail} · ${
                      gate.progress.elapsed_secs + Math.floor((Date.now() - gate.at) / 1000)
                    }s`
                  : PHASE_LABEL[phase]}
              </span>
            ) : (
              "Launch"
            )}
          </button>

          {preflight && (
            <div className="space-y-1 rounded border border-maestro-border/40 bg-maestro-surface/60 p-1.5">
              <CheckRow
                ok={preflight.gh_auth.ok}
                label={
                  preflight.gh_auth.ok
                    ? `gh authenticated as ${preflight.gh_auth.username ?? "unknown user"}`
                    : "gh auth failed"
                }
                detail={preflight.gh_auth.ok ? null : preflight.gh_auth.error}
              />
              <CheckRow
                ok={preflight.windows_reported}
                label={
                  preflight.windows_reported
                    ? "Allowance windows reported"
                    : "No governing allowance window"
                }
                detail={
                  preflight.windows_reported
                    ? null
                    : "the usage API reports neither the 5h nor the 7d window — parking cannot govern this run"
                }
              />
            </div>
          )}

          {error && <p className="text-[11px] text-maestro-red">{error}</p>}
          {notice && <p className="text-[11px] text-maestro-green">{notice}</p>}
        </div>
      </div>

      <div className={cardClass}>
        <SectionHeader
          icon={Rocket}
          label="Active Runs"
          iconColor="text-maestro-green"
          badge={
            runs && runs.length > 0 ? (
              <span className="rounded-full bg-maestro-green/20 px-1.5 text-[10px] font-bold text-maestro-green">
                {runs.length}
              </span>
            ) : undefined
          }
          right={
            <button
              type="button"
              onClick={refreshRuns}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh active runs"
              title="Reload the active runs list"
            >
              <RefreshCw size={12} />
            </button>
          }
        />
        {runs === null ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : runs.length === 0 ? (
          <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
            No active runs. Launch one above.
          </p>
        ) : (
          <div className="space-y-0.5">
            {runs.map((run) => (
              <RunRow
                key={`${run.project_path}-${run.epic}`}
                run={run}
                onCleanup={handleCleanup}
                busy={cleaningEpic !== null}
              />
            ))}
          </div>
        )}
      </div>

      {/* Issue #91: the run workflow the briefs compile from — edited here,
          persisted across restarts, sent with the launch above. */}
      <WorkflowGraphEditor />
    </div>
  );
}
