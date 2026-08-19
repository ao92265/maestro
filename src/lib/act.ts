/**
 * Types and pure predicates for the ACT factory lane.
 *
 * The wire shapes mirror the Rust relay in `src-tauri/src/commands/act.rs`
 * (the webview's CSP blocks direct local HTTP, so every call hops through a
 * Tauri command). Normalization happens in Rust — the frontend only ever sees
 * these typed rows, per the rohcna ACT-client contract: named fields, no raw
 * payload passthrough, an unreachable ACT is a stale badge and never a crash.
 */

export interface ActStage {
  name: string;
  status: string;
}

export interface ActRun {
  id: string;
  title: string;
  status: string;
  /** Name of the currently running stage, when one is. */
  stage: string | null;
  stages: ActStage[];
  createdAt: string | null;
  updatedAt: string | null;
  /** PR / repository the run produced, once it has one. */
  repoUrl: string | null;
  error: string | null;
}

export interface ActTask {
  id: string | null;
  status: string | null;
  blockReason: string | null;
}

export interface ActRunDetail extends ActRun {
  task: ActTask | null;
  /** Raw agent rows, rendered as-is in the detail drawer. */
  agents: unknown;
}

export interface ActSpecInput {
  title: string;
  problem: string;
  audience: string;
  mustHaves: string[];
  nonGoals: string[];
  successCriteria: string[];
}

export interface ActSubmitOutcome {
  accepted: boolean;
  runId: string | null;
  taskId: string | null;
  complexity: string | null;
  httpStatus: number;
  error: string | null;
  currentInFlight: number | null;
  limit: number | null;
}

/** Portal statuses that mean the run will not change again. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * "Blocked on you" discriminator. The portal status itself never says
 * "waiting on a human" — a confidence-gated run can even surface as `failed`
 * — so the embedded task is the only truth: blocked + low_confidence.
 */
export function runNeedsYou(detail: Pick<ActRunDetail, "task">): boolean {
  return detail.task?.status === "blocked" && detail.task?.blockReason === "low_confidence";
}

/** One-line stage summary for a run row: "plan ✓ · build ✓ · verify …". */
export function stageSummary(run: ActRun): string {
  if (run.stages.length === 0) return run.status;
  return run.stages
    .map((s) => {
      const mark = s.status === "completed" ? "✓" : s.status === "running" ? "…" : "·";
      return `${s.name} ${mark}`;
    })
    .join("  ");
}
