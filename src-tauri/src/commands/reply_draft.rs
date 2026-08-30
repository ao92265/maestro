//! One-shot AI draft of the reply that would unblock a waiting session.
//!
//! Ported from rohcna's `draftReply` (server.js:1233) onto Maestro's existing
//! headless-Claude harness ([`run_claude_print_with_timeout`]), so this module
//! owns only the prompt and the sanitising — not a second way to run `claude`.
//!
//! Two differences from rohcna, both deliberate:
//!
//! 1. **No screen capture.** Rohcna read the tail of the tmux pane. Maestro's
//!    scrollback lives in the frontend's xterm buffer, not in Rust, and the
//!    Home overlay has no handle on it. The draft is built from what the
//!    blocked row already shows — the question the agent asked, plus the repo
//!    and branch it asked from. Narrower context, but honest about its source.
//! 2. **The result is never sent.** It is returned as text for the user to
//!    edit. [`sanitize_draft`] flattens it to a single line precisely so that
//!    pasting it into a terminal cannot submit it: a newline in a TUI prompt
//!    IS the send.

use serde::Deserialize;

use super::ai_runner::{run_claude_print_with_timeout, truncate_chars};

/// A draft is one short answer with no repo exploration, so it does not need
/// the summarising features' five-minute ceiling. Rohcna used 40s.
const DRAFT_TIMEOUT_SECS: u64 = 60;

/// Guards the prompt against a runaway `statusMessage`.
const MAX_QUESTION_CHARS: usize = 2000;

/// A drafted reply is a line the user types, not an essay.
const MAX_DRAFT_CHARS: usize = 1000;

/// What the blocked row knows about the session it is drafting for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyDraftContext {
    /// Working directory for the headless run — the session's own repo, so
    /// project-level CLAUDE.md and settings apply to the draft.
    pub project_path: String,
    /// The question the agent stopped on (`needsInputPrompt`).
    pub question: String,
    /// Display name of the repo, when the row has one.
    pub repo: Option<String>,
    pub branch: Option<String>,
    /// The agent's last status line, when it has one — often says what it was
    /// part-way through when it stopped.
    pub status_message: Option<String>,
}

/// Builds the drafting prompt. Split out so the contract is testable without
/// spawning a CLI.
fn build_reply_draft_prompt(ctx: &ReplyDraftContext) -> String {
    let mut where_line = String::new();
    if let Some(repo) = ctx.repo.as_deref().filter(|r| !r.trim().is_empty()) {
        where_line.push_str(repo);
    }
    if let Some(branch) = ctx.branch.as_deref().filter(|b| !b.trim().is_empty()) {
        if !where_line.is_empty() {
            where_line.push_str(" on ");
        }
        where_line.push_str(branch);
    }

    let mut prompt = String::from(
        "A Claude Code session paused and is waiting for its operator. \
         Draft the single concise reply the operator would type to unblock it.\n\n",
    );

    if !where_line.is_empty() {
        prompt.push_str(&format!("--- WHERE ---\n{where_line}\n\n"));
    }
    if let Some(status) = ctx
        .status_message
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        prompt.push_str(&format!(
            "--- WHAT IT WAS DOING ---\n{}\n\n",
            truncate_chars(status, MAX_QUESTION_CHARS)
        ));
    }
    prompt.push_str(&format!(
        "--- QUESTION ---\n{}\n\n",
        truncate_chars(&ctx.question, MAX_QUESTION_CHARS)
    ));
    prompt.push_str(
        "Output ONLY the reply text — no preamble, no quotes, no explanation, \
         no sign-off. Keep it to one line. If the question cannot be answered \
         from the information above, say what you would need instead of guessing.",
    );
    prompt
}

/// Flattens a drafted reply to one safe-to-paste line.
///
/// The draft is pasted into a live terminal for the user to review and edit.
/// A newline at a TUI prompt submits, so a multi-line draft would send itself
/// the moment it landed — the one thing this feature must never do. Fenced
/// blocks and surrounding quotes are stripped too: the model occasionally
/// wraps its answer despite the instruction, and the wrapper is not part of
/// the reply.
pub fn sanitize_draft(raw: &str) -> String {
    let mut text = raw.trim();

    // Drop a wrapping code fence, keeping the body.
    if text.starts_with("```") {
        let without_open = text.trim_start_matches("```");
        let body = without_open.split_once('\n').map_or("", |(_, rest)| rest);
        text = body.trim_end().trim_end_matches("```").trim();
    }

    let flattened = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let unquoted = flattened
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(&flattened);

    // NOT `truncate_chars`: it appends a "\n[... truncated ...]" marker, and a
    // newline is exactly what this function exists to remove. A hard cut is
    // right here anyway — the user edits the draft before sending it.
    unquoted.trim().chars().take(MAX_DRAFT_CHARS).collect()
}

/// Drafts a reply for a blocked session. The caller shows the result in an
/// editable field — nothing here sends it.
#[tauri::command]
pub async fn draft_session_reply(context: ReplyDraftContext) -> Result<String, String> {
    if context.question.trim().is_empty() {
        return Err("This session has not asked a question to reply to.".to_string());
    }

    let prompt = build_reply_draft_prompt(&context);
    // No tools: a draft only has to produce text, and an empty slice disables
    // the built-in tool set entirely (see `claude_print_flags`).
    let raw =
        run_claude_print_with_timeout(&context.project_path, prompt, DRAFT_TIMEOUT_SECS, &[]).await?;

    let draft = sanitize_draft(&raw);
    if draft.is_empty() {
        return Err("Claude returned an empty draft.".to_string());
    }
    Ok(draft)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(question: &str) -> ReplyDraftContext {
        ReplyDraftContext {
            project_path: "/repo".to_string(),
            question: question.to_string(),
            repo: Some("maestro".to_string()),
            branch: Some("feat/x".to_string()),
            status_message: None,
        }
    }

    // ---- prompt ----------------------------------------------------------

    #[test]
    fn prompt_carries_the_question_and_the_location() {
        let prompt = build_reply_draft_prompt(&ctx("Deploy to prod?"));

        assert!(prompt.contains("Deploy to prod?"));
        assert!(prompt.contains("maestro on feat/x"));
    }

    #[test]
    fn prompt_omits_empty_optional_sections() {
        let mut c = ctx("Which branch?");
        c.repo = None;
        c.branch = Some("  ".to_string());
        c.status_message = Some(String::new());

        let prompt = build_reply_draft_prompt(&c);

        assert!(!prompt.contains("--- WHERE ---"));
        assert!(!prompt.contains("--- WHAT IT WAS DOING ---"));
        assert!(prompt.contains("--- QUESTION ---"));
    }

    #[test]
    fn prompt_includes_the_status_line_when_there_is_one() {
        let mut c = ctx("Continue?");
        c.status_message = Some("Running the test suite".to_string());

        assert!(build_reply_draft_prompt(&c).contains("Running the test suite"));
    }

    #[test]
    fn prompt_truncates_a_runaway_question() {
        let huge = "x".repeat(MAX_QUESTION_CHARS * 3);

        let prompt = build_reply_draft_prompt(&ctx(&huge));

        assert!(prompt.len() < huge.len());
    }

    // ---- sanitize_draft (the never-auto-sends guarantee) ------------------

    /// A newline pasted at a TUI prompt IS the send. Every draft has to reach
    /// the terminal as one line or the review step is bypassed.
    #[test]
    fn sanitize_flattens_newlines_so_a_paste_cannot_submit_itself() {
        let out = sanitize_draft("yes, go ahead\nand deploy it");

        assert_eq!(out, "yes, go ahead and deploy it");
        assert!(!out.contains('\n'));
    }

    #[test]
    fn sanitize_strips_trailing_and_leading_whitespace_including_newlines() {
        let out = sanitize_draft("\n\n  approve  \n\n");

        assert_eq!(out, "approve");
        assert!(!out.ends_with('\n'));
    }

    #[test]
    fn sanitize_unwraps_a_fenced_block() {
        assert_eq!(sanitize_draft("```\nnpm run build\n```"), "npm run build");
        assert_eq!(sanitize_draft("```text\nyes\n```"), "yes");
    }

    #[test]
    fn sanitize_unwraps_surrounding_quotes() {
        assert_eq!(sanitize_draft("\"use the main branch\""), "use the main branch");
    }

    #[test]
    fn sanitize_leaves_an_ordinary_reply_alone() {
        assert_eq!(sanitize_draft("use option 2"), "use option 2");
    }

    #[test]
    fn sanitize_caps_a_runaway_draft() {
        let out = sanitize_draft(&"y".repeat(MAX_DRAFT_CHARS * 2));

        assert_eq!(out.chars().count(), MAX_DRAFT_CHARS);
    }

    #[test]
    fn sanitize_of_blank_output_is_empty() {
        assert_eq!(sanitize_draft("   \n  \n"), "");
    }
}
