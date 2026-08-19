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
  /** Pipeline preview from a 200: the stage names the run will pass through. */
  stages: string[] | null;
  complexity: string | null;
  httpStatus: number;
  error: string | null;
  /** 429 body: how full the in-flight window is. */
  currentInFlight: number | null;
  limit: number | null;
  /** 402 body: the token-budget numbers. */
  usedTokens: number | null;
  capTokens: number | null;
  remainingTokens: number | null;
}

/**
 * A pipeline HITL gate (ACT's GateManager) — a different pause from the
 * low-confidence task block: gates have their own ids and a decision set,
 * blocks live on the task and clear through the tasks route.
 */
export interface ActGate {
  id: string;
  title: string;
  options: string[];
  createdAt: string | null;
}

/** Best-effort parse of the gates payload; malformed entries are dropped. */
export function parseGates(payload: unknown): ActGate[] {
  if (typeof payload !== "object" || payload === null) return [];
  const gates = (payload as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return [];
  return gates.flatMap((g) => {
    if (typeof g !== "object" || g === null) return [];
    const gate = g as Record<string, unknown>;
    if (typeof gate.id !== "string" || gate.status === "resolved") return [];
    return [
      {
        id: gate.id,
        title: typeof gate.title === "string" ? gate.title : gate.id,
        options: Array.isArray(gate.options)
          ? gate.options.filter((o): o is string => typeof o === "string")
          : ["approve", "revise", "skip"],
        createdAt: typeof gate.createdAt === "string" ? gate.createdAt : null,
      },
    ];
  });
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
