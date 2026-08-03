//! Daily standup report generation.
//!
//! Gathers git commits and Claude agent-session metadata since the previous
//! report, feeds them to a headless `claude -p` run (the user's existing
//! Claude Code login — no API key), and persists the resulting markdown per
//! project per date under the app data directory.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::claude_sessions;
use crate::core::status_server::StatusServer;
use crate::git::Git;

/// Generous ceiling — a standup covers at most a few days of work.
const MAX_COMMITS: usize = 100;
/// Fallback window when no previous report exists (covers a long weekend).
const DEFAULT_SINCE_DAYS: i64 = 3;
/// `claude -p` can take a while on a big context; kill it after this.
const CLAUDE_TIMEOUT_SECS: u64 = 300;
/// Cap the raw material fed to the model.
const MAX_COMMITS_CHARS: usize = 12_000;
const MAX_SESSIONS_CHARS: usize = 4_000;

/// A generated (or loaded) standup report for one project.
#[derive(Debug, Clone, Serialize)]
pub struct StandupReport {
    pub project_path: String,
    /// Local calendar date the report belongs to (YYYY-MM-DD).
    pub date: String,
    pub markdown: String,
    /// RFC 3339 timestamp of when the report was generated.
    pub generated_at: String,
}

/// Base directory for saved reports: `<app data>/standups/`.
fn standup_base_dir() -> PathBuf {
    directories::ProjectDirs::from("com", "maestro", "maestro")
        .map(|p| p.data_dir().to_path_buf())
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".local/share/maestro")
        })
        .join("standups")
}

/// Per-project report directory: `<base>/<sanitized-name>-<hash12>/`.
fn project_report_dir(canonical_project: &str) -> PathBuf {
    let name = Path::new(canonical_project)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let hash = StatusServer::generate_project_hash(canonical_project);
    standup_base_dir().join(format!("{}-{}", sanitized, hash))
}

/// Remove ANSI escape sequences (CSI and OSC) so saved reports are clean text.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                // CSI: parameters end at the first "final byte" in '@'..='~'.
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: runs until BEL or ESC-backslash (ST).
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{07}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                // Two-character escape (e.g. ESC c).
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// Truncate on a char boundary, appending a marker when content was dropped.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{}\n[... truncated ...]", truncated)
}

/// Newest saved report date strictly before `today` (ISO dates sort lexically).
async fn latest_report_date_before(dir: &Path, today: &str) -> Option<String> {
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    let mut best: Option<String> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(date) = name.strip_suffix(".md") {
            if date.len() == 10
                && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
                && date < today
                && best.as_deref().map_or(true, |b| date > b)
            {
                best = Some(date.to_string());
            }
        }
    }
    best
}

/// Canonicalizes the project path for report naming and as the `claude -p`
/// working directory. On Windows, canonicalize() prepends \\?\ (the
/// extended-length prefix); cmd.exe rejects that as a working directory and
/// silently falls back to C:\Windows, so the report would be generated from
/// the wrong directory. Strip it, same as commands/terminal.rs.
fn canonical_project_path(project_path: &str) -> String {
    let canonical = std::fs::canonicalize(project_path)
        .unwrap_or_else(|_| PathBuf::from(project_path))
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let canonical = canonical
        .strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(canonical);
    canonical
}

/// Run `claude -p` headlessly in the project directory, prompt via stdin.
async fn run_claude_print(project_path: &str, prompt: String) -> Result<String, String> {
    #[cfg(windows)]
    let mut cmd = {
        use crate::core::windows_process::TokioCommandExt;
        // `claude` may be an npm `.cmd` shim, which CreateProcess cannot spawn
        // directly; route through cmd.exe. The prompt travels via stdin, so no
        // untrusted content ever reaches cmd's argument parser.
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "claude", "-p"]);
        c.hide_console_window();
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("claude");
        c.arg("-p");
        c.env("PATH", crate::core::cli_path::augmented_path());
        c
    };

    cmd.current_dir(project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            "Claude CLI not found on PATH — install it with: npm install -g @anthropic-ai/claude-code".to_string()
        }
        _ => format!("Failed to start Claude CLI: {}", e),
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Failed to send prompt to Claude CLI: {}", e))?;
        // Dropping stdin closes the pipe so `claude -p` knows input ended.
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(CLAUDE_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Claude run timed out after {}s", CLAUDE_TIMEOUT_SECS))?
    .map_err(|e| format!("Claude run failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Claude CLI exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Built-in prompt template. Users may override it from the Standup panel;
/// `{project}`, `{date}`, `{since}`, `{commits}` and `{sessions}` are
/// substituted before the prompt is sent to `claude -p`.
pub const DEFAULT_PROMPT_TEMPLATE: &str = r#"You are writing a daily standup report for the developer working in this repository. Use ONLY the material below; never invent work that is not evidenced by it.

Output exactly this GitHub-flavored markdown structure, with no preamble and no surrounding code fence:

# Standup — {project} — {date}

## TL;DR
(1-3 bullets max)

## Since last report
(what was worked on; group related commits/sessions into one bullet each)

## Blockers
(evidence-based only; write "None evident." if nothing suggests one)

## Next
(the natural follow-ups implied by the material; 1-3 bullets)

Formatting rules — the reader has ADHD, optimize for scanning:
- Every bullet starts with a **bold 2-4 word lead**, then one short clause.
- Max ~14 words per bullet. No nested bullets. No paragraphs.
- Mention branch names inline as `code`.
- Total under 200 words.

MATERIAL (covers work since {since}):

== Git commits ==
{commits}

== Agent sessions (Claude conversations in this project) ==
{sessions}
"#;

/// Build the standup prompt from the gathered material. A non-empty custom
/// template replaces the built-in one; both use the same placeholders.
fn build_prompt(
    template: Option<&str>,
    project_name: &str,
    date: &str,
    since: &str,
    commits: &str,
    sessions: &str,
) -> String {
    let template = match template {
        Some(t) if !t.trim().is_empty() => t,
        _ => DEFAULT_PROMPT_TEMPLATE,
    };
    template
        .replace("{project}", project_name)
        .replace("{date}", date)
        .replace("{since}", since)
        .replace(
            "{commits}",
            if commits.trim().is_empty() { "(none)" } else { commits },
        )
        .replace(
            "{sessions}",
            if sessions.trim().is_empty() { "(none)" } else { sessions },
        )
}

/// The built-in prompt template, for the panel's editor prefill / reset.
#[tauri::command]
pub fn get_default_standup_prompt() -> String {
    DEFAULT_PROMPT_TEMPLATE.to_string()
}

/// Generate the standup report for one project and persist it as
/// `<data>/standups/<project>/<today>.md`. The window starts at the date of
/// the newest previous report, or 3 days ago when none exists.
#[tauri::command]
pub async fn generate_standup_report(
    project_path: String,
    prompt_template: Option<String>,
) -> Result<StandupReport, String> {
    let canonical = canonical_project_path(&project_path);

    let today = Local::now().format("%Y-%m-%d").to_string();
    let report_dir = project_report_dir(&canonical);
    let since = latest_report_date_before(&report_dir, &today)
        .await
        .unwrap_or_else(|| {
            (Local::now() - Duration::days(DEFAULT_SINCE_DAYS))
                .format("%Y-%m-%d")
                .to_string()
        });

    // 1. Commits across all branches since the window start.
    let git = Git::new(&canonical);
    let commits = git
        .commit_log_text_since(&since, MAX_COMMITS)
        .await
        .unwrap_or_default();

    // 2. Claude conversations active inside the window.
    let cutoff: DateTime<Utc> = NaiveDate::parse_from_str(&since, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|naive| DateTime::from_naive_utc_and_offset(naive, Utc))
        .unwrap_or_else(|| Utc::now() - Duration::days(DEFAULT_SINCE_DAYS));
    let sessions = claude_sessions::list_claude_sessions(canonical.clone())
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|s| {
            DateTime::parse_from_rfc3339(&s.last_active)
                .map(|t| t.with_timezone(&Utc) >= cutoff)
                .unwrap_or(false)
        })
        .map(|s| {
            format!(
                "- [{} | branch: {}] {}",
                s.last_active,
                s.git_branch.as_deref().unwrap_or("-"),
                s.first_prompt.as_deref().unwrap_or("(no prompt recorded)")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let project_name = Path::new(&canonical)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical.clone());

    let prompt = build_prompt(
        prompt_template.as_deref(),
        &project_name,
        &today,
        &since,
        &truncate_chars(&commits, MAX_COMMITS_CHARS),
        &truncate_chars(&sessions, MAX_SESSIONS_CHARS),
    );

    let raw = run_claude_print(&canonical, prompt).await?;
    let markdown = strip_ansi(&raw).trim().to_string();
    if markdown.is_empty() {
        return Err("Claude returned an empty report".to_string());
    }

    tokio::fs::create_dir_all(&report_dir)
        .await
        .map_err(|e| format!("Failed to create report directory: {}", e))?;
    let file_path = report_dir.join(format!("{}.md", today));
    tokio::fs::write(&file_path, &markdown)
        .await
        .map_err(|e| format!("Failed to save report: {}", e))?;

    Ok(StandupReport {
        project_path,
        date: today,
        markdown,
        generated_at: Utc::now().to_rfc3339(),
    })
}

/// Load a previously generated report (today's when `date` is omitted).
/// Returns `None` when no report exists for that date.
#[tauri::command]
pub async fn load_standup_report(
    project_path: String,
    date: Option<String>,
) -> Result<Option<StandupReport>, String> {
    let canonical = canonical_project_path(&project_path);

    let date = match date {
        Some(d) => {
            // Reject anything that isn't a plain ISO date — it becomes a filename.
            NaiveDate::parse_from_str(&d, "%Y-%m-%d")
                .map_err(|_| format!("Invalid report date: {}", d))?;
            d
        }
        None => Local::now().format("%Y-%m-%d").to_string(),
    };

    let file_path = project_report_dir(&canonical).join(format!("{}.md", date));
    match tokio::fs::read_to_string(&file_path).await {
        Ok(markdown) => {
            let generated_at = tokio::fs::metadata(&file_path)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_default();
            Ok(Some(StandupReport {
                project_path,
                date,
                markdown,
                generated_at,
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read report: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_and_osc_sequences() {
        assert_eq!(strip_ansi("plain text"), "plain text");
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{07}b"), "ab");
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{1b}\\b"), "ab");
        // Trailing lone escape must not panic or loop.
        assert_eq!(strip_ansi("end\u{1b}"), "end");
    }

    #[test]
    fn truncate_chars_marks_dropped_content() {
        assert_eq!(truncate_chars("short", 10), "short");
        let long = "x".repeat(20);
        let cut = truncate_chars(&long, 10);
        assert!(cut.starts_with("xxxxxxxxxx"));
        assert!(cut.ends_with("[... truncated ...]"));
    }

    #[tokio::test]
    async fn latest_report_date_picks_newest_before_today() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["2026-07-25.md", "2026-07-28.md", "2026-07-30.md", "junk.txt"] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let best = latest_report_date_before(dir.path(), "2026-07-30").await;
        assert_eq!(best.as_deref(), Some("2026-07-28"));
    }

    #[tokio::test]
    async fn latest_report_date_none_for_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(latest_report_date_before(&missing, "2026-07-30").await, None);
    }

    #[test]
    fn build_prompt_substitutes_placeholders_for_empty_material() {
        let p = build_prompt(None, "maestro", "2026-07-30", "2026-07-28", "", "");
        assert!(p.contains("maestro"));
        assert!(p.contains("(none)"));
        assert!(!p.contains("{project}"));
    }

    #[test]
    fn build_prompt_uses_custom_template_with_placeholders() {
        let p = build_prompt(
            Some("Report for {project} on {date}: {commits} / {sessions}"),
            "maestro",
            "2026-07-31",
            "2026-07-30",
            "abc fix bug",
            "",
        );
        assert_eq!(p, "Report for maestro on 2026-07-31: abc fix bug / (none)");
    }

    #[test]
    fn build_prompt_falls_back_to_default_on_blank_template() {
        let p = build_prompt(Some("   "), "maestro", "2026-07-31", "2026-07-30", "", "");
        assert!(p.contains("## TL;DR"));
    }
}
