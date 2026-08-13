import type { ClaudeEvent } from "@/types/claude-events";

/**
 * Longest one-line description rendered under a terminal header. Long enough
 * to carry a real sentence at a glance, short enough that it never wins the
 * fight for header space in a dense grid — the full text is on the tooltip.
 */
const MAX_CONTEXT_CHARS = 110;

/**
 * How many recent transcript events are scanned backwards for a usable line.
 *
 * The activity store keeps up to 500 events per session, and a long agent turn
 * can be hundreds of tool calls with no user message in between. Capping the
 * walk keeps this cheap on every re-render; if the last user prompt has already
 * scrolled past this window, the tool/file fallbacks still describe the work.
 */
const MAX_EVENTS_SCANNED = 200;

/**
 * Opening tags that mark a transcript "user" entry Claude Code injected itself
 * (hook output, command echoes, sub-agent notifications) rather than something
 * the user typed. Mirrors the SYSTEM_TAGS list the session picker uses in
 * `src-tauri/src/commands/claude_sessions.rs` — the same transcripts feed both.
 */
const INJECTED_ENTRY_TAGS = [
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<system-reminder>",
  "<task-notification>",
  "<user-prompt-submit-hook>",
];

/** Reads the text between `<tag>` and `</tag>`, trimmed; null when absent. */
function tagContent(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return null;
  const inner = text.slice(start + open.length, end).trim();
  return inner || null;
}

/** Drops every `<...>` tag, keeping the text between them. */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, " ");
}

/**
 * Collapses a transcript blob into a single readable line: no newlines, no
 * runs of spaces, no leading markdown bullet/heading punctuation (a pasted
 * "- fix the thing" should read as "fix the thing").
 */
function toSingleLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*#>\s]+/, "")
    .trim();
}

/** Truncates on a word boundary so the line never ends mid-word. */
function clamp(text: string, max = MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a space when one exists reasonably late; a single very long
  // token (a path, a URL) is better hard-cut than reduced to two characters.
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Extracts what the user actually asked for out of one transcript user entry,
 * or null when the entry was machine-injected and says nothing about intent.
 *
 * Slash commands arrive as `<command-name>/foo</command-name>` plus
 * `<command-args>...</command-args>`; the arguments are the intent, the command
 * name is the fallback.
 */
export function userIntentFrom(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (INJECTED_ENTRY_TAGS.some((tag) => trimmed.startsWith(tag))) return null;

  const args = tagContent(trimmed, "command-args");
  if (args) return toSingleLine(args) || null;

  const name = tagContent(trimmed, "command-name");
  if (name) return toSingleLine(name) || null;

  const line = toSingleLine(trimmed.includes("<") ? stripTags(trimmed) : trimmed);
  return line || null;
}

/** Everything the one-line description can be derived from. */
export interface SessionContextInput {
  /** Latest MCP-reported "what I'm doing" line, when the agent reports status. */
  statusMessage?: string;
  /** The question the agent is blocked on, when its status is NeedsInput. */
  needsInputPrompt?: string;
  /** Transcript events for this session, oldest first (capped by the store). */
  events: readonly ClaudeEvent[];
  /** Files this session has created or edited. */
  filesModified: readonly string[];
}

/**
 * One line saying what a terminal is about, recomputed from the session's own
 * data every time it changes — so a terminal parked (or ignored) for an hour
 * still says what it was for without the user having to remember.
 *
 * Priority is "what would remind me fastest", strongest first:
 *
 * 1. the question the agent is blocked on — it is the only thing that matters
 *    while it waits;
 * 2. the last thing the user asked for — the intent of the whole session,
 *    and what a returning user recognises;
 * 3. the agent's own status line — present only while an agent reports over
 *    MCP, but accurate when it is;
 * 4. the tool call in flight, then the files touched — weak, but still better
 *    than a blank line for a plain shell.
 *
 * Returns null when the session has produced nothing to describe yet; callers
 * render no strip at all in that case rather than an empty one.
 */
export function describeSessionContext(input: SessionContextInput): string | null {
  const { statusMessage, needsInputPrompt, events, filesModified } = input;

  const prompt = needsInputPrompt?.trim();
  if (prompt) return clamp(`Asking: ${toSingleLine(prompt)}`);

  const window = events.slice(-MAX_EVENTS_SCANNED);

  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i];
    if (event.event_type !== "UserMessage") continue;
    const intent = userIntentFrom(event.text);
    if (intent) return clamp(intent);
  }

  const status = statusMessage?.trim();
  if (status) return clamp(toSingleLine(status));

  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i];
    if (event.event_type !== "ToolUseStarted") continue;
    const summary = toSingleLine(event.input_summary ?? "");
    return clamp(summary ? `${event.tool_name}: ${summary}` : event.tool_name);
  }

  if (filesModified.length > 0) {
    const names = filesModified.slice(-3).map(
      (path) =>
        path
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() || path,
    );
    return clamp(
      `${filesModified.length} file${filesModified.length === 1 ? "" : "s"} touched — ${names.join(", ")}`,
    );
  }

  return null;
}
