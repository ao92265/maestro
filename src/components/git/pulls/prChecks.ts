/**
 * Normalized shape for one entry of a PR's `statusCheckRollup`. `gh` reports
 * two different raw shapes here — a CheckRun (`status`/`conclusion`/`name`/
 * `workflowName`/`detailsUrl`) and a StatusContext (`state`/`context`/
 * `targetUrl`) — and the store keeps the array typed `unknown[]` end to end
 * (see `PullRequestDetail.statusCheckRollup` in `useGitHubStore.ts`), so this
 * module turns one raw entry into something safe to render.
 */
export interface NormalizedCheck {
  name: string;
  state: "success" | "failure" | "pending" | "unknown";
  url: string | null;
}

/**
 * Mirrors `classify_state` in `src-tauri/src/github/ops.rs` exactly so the
 * panel agrees with the `checksSummary` counts computed on the Rust side.
 */
const SUCCESS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILURE_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

function classifyState(value: string): "success" | "failure" | "pending" {
  const upper = value.toUpperCase();
  if (SUCCESS_STATES.has(upper)) return "success";
  if (FAILURE_STATES.has(upper)) return "failure";
  return "pending";
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalizes one raw `statusCheckRollup` entry into a display-ready shape.
 * Defensive against missing/malformed fields — the array is typed
 * `unknown[]` precisely because `gh` can report either shape, so nothing
 * here may throw regardless of what's in `entry`.
 */
export function normalizeCheck(entry: unknown): NormalizedCheck {
  if (typeof entry !== "object" || entry === null) {
    return { name: "Unknown check", state: "unknown", url: null };
  }
  const obj = entry as Record<string, unknown>;

  const workflowName = stringField(obj, "workflowName");
  const name = stringField(obj, "name");
  const context = stringField(obj, "context");
  const displayName = workflowName && name ? `${workflowName} / ${name}` : (name ?? context);

  // Same branch structure as `classify_check`: a `status` field means the
  // CheckRun shape (only COMPLETED runs have a meaningful conclusion);
  // otherwise fall back to the StatusContext `state` field. Either way,
  // missing/unrecognized values default to "pending", matching Rust's
  // `.unwrap_or(CheckOutcome::Pending)`.
  const status = stringField(obj, "status");
  const conclusion = stringField(obj, "conclusion");
  const state = stringField(obj, "state");
  let checkState: "success" | "failure" | "pending";
  if (status !== undefined) {
    checkState =
      status.toUpperCase() !== "COMPLETED"
        ? "pending"
        : conclusion !== undefined
          ? classifyState(conclusion)
          : "pending";
  } else {
    checkState = state !== undefined ? classifyState(state) : "pending";
  }

  const detailsUrl = stringField(obj, "detailsUrl");
  const targetUrl = stringField(obj, "targetUrl");

  return {
    name: displayName ?? "Unknown check",
    state: checkState,
    url: detailsUrl ?? targetUrl ?? null,
  };
}
