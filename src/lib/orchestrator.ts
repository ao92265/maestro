/**
 * Orchestrator lane: one headless Claude session that reads the other sessions
 * and proposes what they should do next, with every outbound message held in a
 * queue the operator approves.
 *
 * Ported from rohcna's `/orchestrate*` + `/propose*` routes, but not its
 * transport. Rohcna could curl its own Express server; a Tauri app has no such
 * server, so the two halves land differently:
 *
 * - The orchestrator is a REAL Maestro session, launched down the existing
 *   `PendingLaunch` path (spawn_shell → create_session → arm prompt → CLI).
 *   No daemon, no second process manager, and the operator can watch it in a
 *   terminal tab like any other session.
 * - It files proposals by dropping JSON files into a watched directory
 *   (write-then-rename), which Rust ingests into a durable, TTL-expiring queue
 *   (`src-tauri/src/commands/orchestrator.rs`).
 *
 * Safe mode is the default and the whole point: the orchestrator has no route
 * to another session except a proposal, and a proposal only moves when the
 * operator approves it or when the operator has explicitly turned safe mode
 * off. Nobody approving is not consent — a pending proposal expires.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * How long a proposal may sit undecided before it stops being deliverable.
 * Mirrors rohcna's `PROPOSAL_TTL_MS`: advice about a session's state goes off,
 * and an approval landing an hour late would drive it on a stale reading.
 */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

/**
 * Where a proposal is in its life:
 * - `pending`  waiting on the operator (safe mode)
 * - `approved` decided yes, not yet typed into the target
 * - `sent`     delivered to the target session
 * - `rejected` operator said no
 * - `expired`  nobody decided inside the TTL — never deliverable
 * - `blocked`  target is outside the operator's scope — never deliverable
 * - `error`    approved, but delivery failed
 */
export type ProposalStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "expired"
  | "blocked"
  | "error";

export interface Proposal {
  id: number;
  /** Maestro session id the message is for. */
  targetSessionId: number;
  /** Message to type, already whitespace-collapsed by the backend. */
  text: string;
  /** A control key (e.g. `Escape`) instead of text; mutually exclusive with it. */
  key: string | null;
  /** One-line reason, shown to the operator at the decision. */
  note: string;
  status: ProposalStatus;
  /** ISO timestamp of ingest — the clock the TTL runs on. */
  at: string;
  error: string | null;
}

/** One session the operator ticked as in-scope for the current goal. */
export interface ScopeEntry {
  sessionId: number;
  /** How the session reads in the picker, e.g. `maestro — feat/orchestrator`. */
  label: string;
  /** Working directory, so the orchestrator can inspect the actual checkout. */
  cwd?: string | null;
}

/** The whole queue as Rust holds it. */
export interface OrchestratorQueue {
  safeMode: boolean;
  scope: ScopeEntry[];
  proposals: Proposal[];
}

/** What `orchestrator_decide` answers: the updated row, and whether to deliver it. */
export interface ProposalDecision {
  proposal: Proposal;
  /**
   * True only for an approval that survived every check (still pending, inside
   * its TTL, target in scope). The frontend delivers on this flag alone and
   * never re-derives the verdict — one decision point, not two.
   */
  dispatch: boolean;
}

/**
 * Control keys a proposal may ask for, and the bytes they actually are. The
 * queue stores the NAME so the operator approves something readable; the
 * escape sequence is resolved only at delivery.
 */
const CONTROL_KEYS: Record<string, string> = {
  Escape: "\x1b",
  Enter: "\r",
  Tab: "\t",
  "C-c": "\x03",
  "C-d": "\x04",
};

/** The bytes for a named control key, or null if the name is not one we allow. */
export function controlSequence(key: string): string | null {
  return CONTROL_KEYS[key] ?? null;
}

/**
 * A pending proposal is expired once the TTL has passed. Only `pending`
 * expires: once decided, finishing the delivery is the app's job, and a
 * TTL that kept running would strand an approved message.
 *
 * An unparseable timestamp stays visible rather than being guessed stale —
 * the same call rohcna makes, so a corrupt row is something the operator
 * sees rather than something that silently vanishes.
 */
export function isProposalExpired(proposal: Proposal, now: number): boolean {
  if (proposal.status !== "pending") return false;
  const at = Date.parse(proposal.at);
  if (Number.isNaN(at)) return false;
  return now - at > PROPOSAL_TTL_MS;
}

/**
 * Whether a target may be driven under the current scope. An EMPTY scope means
 * "all sessions", matching rohcna — it is not a deny-all, or an operator who
 * ticked nothing would find every proposal blocked.
 */
export function isTargetInScope(targetSessionId: number, scope: ScopeEntry[]): boolean {
  if (scope.length === 0) return true;
  return scope.some((entry) => entry.sessionId === targetSessionId);
}

/**
 * The scope restriction, prepended to a goal. Advisory here — the enforcement
 * that matters happens in Rust at ingest, which blocks an out-of-scope target
 * whatever the prompt said.
 */
export function buildScopeNote(scope: ScopeEntry[]): string {
  if (scope.length === 0) return "";
  const rows = scope
    .map((entry) => `- ${entry.label} [targetSessionId: ${entry.sessionId}]`)
    .join("\n");
  return `SCOPE — for THIS goal, read and propose to ONLY these sessions, ignoring every other session on the machine:\n${rows}\n\n`;
}

/** A goal as the orchestrator session receives it: scope restriction, then the ask. */
export function buildGoalPrompt(goal: string, scope: ScopeEntry[]): string {
  return `${buildScopeNote(scope)}${goal.trim()}`;
}

/**
 * The orchestrator's standing brief. Delivered as a brief FILE (the
 * `briefDir`/`briefStem` route on `terminal_arm_initial_prompt`), never typed:
 * the inline path collapses every whitespace run to a single space, which
 * would flatten the JSON examples below into one unreadable line.
 */
export function buildOrchestratorBrief(dropDir: string, scope: ScopeEntry[]): string {
  const roster =
    scope.length > 0
      ? scope
          .map(
            (entry) =>
              `- ${entry.label} [targetSessionId: ${entry.sessionId}]${entry.cwd ? ` — ${entry.cwd}` : ""}`,
          )
          .join("\n")
      : "- (none ticked yet — the operator will scope each goal as they give it)";

  return `You are the Vanguard orchestrator — a control tower for the other Claude Code sessions running in this app.

You have NO way to type into another session. Everything you want a session to do is a PROPOSAL that the
operator approves before it is delivered. Proposing IS asking: never end a goal by asking the operator
whether you should nudge a session — propose the nudge with a clear note and let them decide.

## Proposing

One JSON file per proposal, dropped into:

    ${dropDir}

Write it as \`<name>.json.tmp\` first, then rename it to \`<name>.json\`. The app polls this directory and a
direct \`.json\` write would be read half-finished.

    {"targetSessionId": 7, "text": "your message", "note": "why, in one line"}
    {"targetSessionId": 7, "key": "Escape", "note": "why"}

- \`targetSessionId\` must be one of the ids in the roster below. Any other id is blocked, not queued.
- \`text\` is typed into that session and submitted as a single message. Keep it to one line — newlines are
  collapsed before the operator ever sees it.
- \`key\` sends a control key instead of text. Allowed: ${Object.keys(CONTROL_KEYS).join(", ")}.
- \`note\` is what the operator reads when deciding. Always write one, and make it the REASON, not a restatement.
- A proposal nobody approves expires after ${PROPOSAL_TTL_MS / 60000} minutes. Stale advice is not delivered late.

## Sessions in scope

${roster}

## Rules

- A proposal is the ONLY channel. Never drive a session by any other route — no tmux, no AppleScript, no
  writing into another session's files, no killing processes.
- Look before you propose. Inspect the target's checkout (git status, its branch, its failing tests, its open
  PR) and base the proposal on what you actually found.
- Never propose anything destructive as busywork: no force-push, no \`rm\`, no killing sessions, no closing panes.
- A session waiting on the OPERATOR — a question only a human can answer, an approval, a manual step — is
  genuinely blocked. Report the blocker; do not manufacture work for it.
- A session mid-task is left alone.
- Keep your replies short: what you found, what you proposed and to whom, why, and what you are waiting on.`;
}

/** How a proposal reads in the queue — control keys must never look like typed text. */
export function proposalPreview(proposal: Proposal): string {
  return proposal.key ? `⌨ ${proposal.key}` : proposal.text;
}

/** Ingests any newly dropped proposals and returns the whole queue. */
export function orchestratorIngest(): Promise<OrchestratorQueue> {
  return invoke<OrchestratorQueue>("orchestrator_ingest");
}

/** Decides a proposal. Only an approval that passes every check comes back dispatchable. */
export function orchestratorDecide(id: number, approve: boolean): Promise<ProposalDecision> {
  return invoke<ProposalDecision>("orchestrator_decide", { id, approve });
}

/** Records what actually happened to an approved proposal once delivery was attempted. */
export function orchestratorMark(
  id: number,
  status: ProposalStatus,
  error: string | null,
): Promise<void> {
  return invoke("orchestrator_mark", { id, status, error });
}

/** Persists safe mode; the returned value is the flag Rust actually holds. */
export function orchestratorSetSafeMode(on: boolean): Promise<boolean> {
  return invoke<boolean>("orchestrator_set_safe_mode", { on });
}

/** Persists the scope, which is what ingest enforces against. */
export function orchestratorSetScope(scope: ScopeEntry[]): Promise<void> {
  return invoke("orchestrator_set_scope", { scope });
}

/** Empties the queue and forgets the scope — the "fresh start" control. */
export function orchestratorClear(): Promise<void> {
  return invoke("orchestrator_clear");
}

/** Absolute path of the drop directory, for the brief. */
export function orchestratorDropDir(): Promise<string> {
  return invoke<string>("orchestrator_drop_dir");
}
