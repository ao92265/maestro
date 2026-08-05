//! Shared mechanics for Maestro's headless-Claude features (standup report,
//! daily plan, …).
//!
//! Every one of them does the same four things: build a prompt from local
//! material, run it through `claude -p` inside a repo (the user's existing
//! Claude Code login — no API key), and persist the answer as a dated
//! markdown artifact it can serve back later. This module owns that
//! machinery; feature modules own only their prompt and their material.
//!
//! Artifacts live at `<app data>/<kind>/[<project>/]<YYYY-MM-DD>.md` — one
//! directory per KIND ("standups", "plans"), optionally scoped to a project
//! for per-project kinds. The standup layout predates this module and is
//! reproduced exactly, so previously saved reports keep loading.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use chrono::{DateTime, Local, NaiveDate, Utc};
use tokio::io::AsyncWriteExt;

use crate::core::status_server::StatusServer;

/// `claude -p` can take a while on a big context; kill it after this. It is
/// the ceiling for the features that summarise pre-gathered material in one
/// pass. Features whose run also has the model EXPLORE the repo (many tool
/// calls, minutes of work) pass their own — see [`run_and_save_with_timeout`].
pub const CLAUDE_TIMEOUT_SECS: u64 = 300;

/// Base directory for one artifact kind: `<app data>/<kind>/`.
pub fn artifact_base_dir(kind: &str) -> PathBuf {
    directories::ProjectDirs::from("com", "maestro", "maestro")
        .map(|p| p.data_dir().to_path_buf())
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".local/share/maestro")
        })
        .join(kind)
}

/// Per-project artifact directory: `<base>/<sanitized-name>-<hash12>/`. The
/// hash disambiguates same-named projects in different locations.
pub fn project_artifact_dir(kind: &str, canonical_project: &str) -> PathBuf {
    let name = Path::new(canonical_project)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let hash = StatusServer::generate_project_hash(canonical_project);
    artifact_base_dir(kind).join(format!("{}-{}", sanitized, hash))
}

/// Canonicalizes a project path for artifact naming and as the `claude -p`
/// working directory. On Windows, canonicalize() prepends \\?\ (the
/// extended-length prefix); cmd.exe rejects that as a working directory and
/// silently falls back to C:\Windows, so the run would happen in the wrong
/// directory. Strip it, same as commands/terminal.rs.
pub fn canonical_project_path(project_path: &str) -> String {
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

/// Directory name of a project path, for display inside prompts.
pub fn project_name_of(canonical_project: &str) -> String {
    Path::new(canonical_project)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical_project.to_string())
}

/// Today's local calendar date (YYYY-MM-DD) — the artifact's file name.
pub fn today_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Remove ANSI escape sequences (CSI and OSC) so saved artifacts are clean text.
pub fn strip_ansi(input: &str) -> String {
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
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{}\n[... truncated ...]", truncated)
}

/// Newest saved artifact date in `dir`, optionally strictly before `before`
/// (ISO dates sort lexically). This is what keeps yesterday's artifact
/// readable until today's replaces it.
pub async fn latest_artifact_date(dir: &Path, before: Option<&str>) -> Option<String> {
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    let mut best: Option<String> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(date) = name.strip_suffix(".md") {
            if date.len() == 10
                && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
                && before.map_or(true, |b| date < b)
                && best.as_deref().map_or(true, |b| date > b)
            {
                best = Some(date.to_string());
            }
        }
    }
    best
}

/// Rejects anything that isn't a plain ISO date — it becomes a filename.
pub fn validate_date(date: &str) -> Result<(), String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("Invalid report date: {}", date))
}

/// Single-pass placeholder interpolation over `template`: each `{token}` in
/// the TEMPLATE is replaced once, and substituted material is never
/// re-scanned — so a commit subject or issue title containing a literal
/// "{sessions}"/"{overview}" cannot get expanded (unlike chained
/// `str::replace`, which rescans the accumulated string).
pub fn interpolate(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    loop {
        let mut earliest: Option<(usize, &str, &str)> = None;
        for &(token, value) in vars {
            if let Some(pos) = rest.find(token) {
                if earliest.map_or(true, |(p, _, _)| pos < p) {
                    earliest = Some((pos, token, value));
                }
            }
        }
        match earliest {
            Some((pos, token, value)) => {
                out.push_str(&rest[..pos]);
                out.push_str(value);
                rest = &rest[pos + token.len()..];
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// "(none)" placeholder for an empty material section, so the model sees an
/// explicit absence instead of a blank gap.
pub fn or_none(s: &str) -> &str {
    if s.trim().is_empty() {
        "(none)"
    } else {
        s
    }
}

/// Run `claude -p` headlessly in the project directory, prompt via stdin,
/// killed after `timeout_secs`. A run that has the model read its way around a
/// repository needs far longer than one that summarises material we already
/// gathered, so the ceiling is the caller's choice — [`CLAUDE_TIMEOUT_SECS`]
/// is the default the summarising features pass.
///
/// `tools` restricts the run to the named built-in tools; an empty slice
/// leaves the CLI's own defaults alone (what the summarising features want,
/// since they hand the model everything in the prompt and expect no tool use).
pub async fn run_claude_print_with_timeout(
    project_path: &str,
    prompt: String,
    timeout_secs: u64,
    tools: &[&str],
) -> Result<String, String> {
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

    if !tools.is_empty() {
        // `--tools` decides which built-in tools EXIST for the run, so a
        // permissive project settings.json cannot hand the model Bash or
        // Write; `--allowedTools` then spares the survivors a permission
        // prompt that a headless run has no way to answer. Both flags take a
        // comma- or space-separated list (`claude --help`).
        let list = tools.join(",");
        cmd.args(["--tools", list.as_str(), "--allowedTools", list.as_str()]);
    }

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
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Claude run timed out after {}s", timeout_secs))?
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

/// Run the prompt and persist the cleaned answer as `<dir>/<date>.md`.
/// Returns the saved markdown. An empty answer is an error and saves nothing,
/// so a failed run never consumes the day's slot on disk.
pub async fn run_and_save(
    cwd: &str,
    prompt: String,
    dir: &Path,
    date: &str,
) -> Result<String, String> {
    run_and_save_with_timeout(cwd, prompt, dir, date, CLAUDE_TIMEOUT_SECS, &[]).await
}

/// Same, with an explicit run timeout and tool restriction (see
/// [`run_claude_print_with_timeout`]).
pub async fn run_and_save_with_timeout(
    cwd: &str,
    prompt: String,
    dir: &Path,
    date: &str,
    timeout_secs: u64,
    tools: &[&str],
) -> Result<String, String> {
    let raw = run_claude_print_with_timeout(cwd, prompt, timeout_secs, tools).await?;
    let markdown = strip_ansi(&raw).trim().to_string();
    if markdown.is_empty() {
        return Err("Claude returned an empty report".to_string());
    }

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create report directory: {}", e))?;
    let file_path = dir.join(format!("{}.md", date));
    tokio::fs::write(&file_path, &markdown)
        .await
        .map_err(|e| format!("Failed to save report: {}", e))?;
    Ok(markdown)
}

/// Read `<dir>/<date>.md`, returning its markdown and RFC 3339 mtime.
/// `Ok(None)` means "not generated", which callers surface as an empty panel
/// rather than an error.
pub async fn load_artifact(dir: &Path, date: &str) -> Result<Option<(String, String)>, String> {
    let file_path = dir.join(format!("{}.md", date));
    match tokio::fs::read_to_string(&file_path).await {
        Ok(markdown) => {
            let generated_at = tokio::fs::metadata(&file_path)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_default();
            Ok(Some((markdown, generated_at)))
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
    async fn latest_artifact_date_picks_newest_before_today() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "2026-07-25.md",
            "2026-07-28.md",
            "2026-07-30.md",
            "junk.txt",
        ] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let best = latest_artifact_date(dir.path(), Some("2026-07-30")).await;
        assert_eq!(best.as_deref(), Some("2026-07-28"));
    }

    #[tokio::test]
    async fn latest_artifact_date_unbounded_picks_newest_overall() {
        // Retention: with no upper bound the newest saved artifact wins — this
        // is what keeps yesterday's report/plan readable until today's exists.
        let dir = tempfile::tempdir().unwrap();
        for name in ["2026-07-28.md", "2026-07-30.md", "junk.txt"] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let best = latest_artifact_date(dir.path(), None).await;
        assert_eq!(best.as_deref(), Some("2026-07-30"));
    }

    #[tokio::test]
    async fn latest_artifact_date_none_for_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(
            latest_artifact_date(&missing, Some("2026-07-30")).await,
            None
        );
        assert_eq!(latest_artifact_date(&missing, None).await, None);
    }

    #[tokio::test]
    async fn load_artifact_reads_saved_markdown_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("2026-08-04.md"), "# plan").unwrap();
        let found = load_artifact(dir.path(), "2026-08-04").await.unwrap();
        assert_eq!(found.map(|(md, _)| md), Some("# plan".to_string()));
        assert!(load_artifact(dir.path(), "2026-08-03")
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn validate_date_rejects_non_iso_input() {
        // The date becomes a filename, so anything that could escape the
        // artifact directory or trail extra text has to be rejected.
        assert!(validate_date("2026-08-04").is_ok());
        assert!(validate_date("../../etc/passwd").is_err());
        assert!(validate_date("2026-08-04/../../secret").is_err());
        assert!(validate_date("2026-08-04.md").is_err());
        assert!(validate_date("").is_err());
        // Unpadded components still parse to a real date (chrono accepts
        // them) — harmless as a filename, and pinned here so the looser rule
        // is a documented choice rather than an accident.
        assert!(validate_date("2026-8-4").is_ok());
    }

    #[test]
    fn interpolate_replaces_each_template_token_once() {
        let out = interpolate("a {x} b {y} c", &[("{x}", "1"), ("{y}", "2")]);
        assert_eq!(out, "a 1 b 2 c");
    }

    #[test]
    fn interpolate_does_not_rescan_substituted_material() {
        // Placeholder-looking text inside the material must pass through
        // verbatim — only tokens in the template itself are interpolated.
        let out = interpolate("{a}|{b}", &[("{a}", "says {b}"), ("{b}", "B")]);
        assert_eq!(out, "says {b}|B");
    }

    #[test]
    fn project_artifact_dir_is_stable_and_kind_scoped() {
        let a = project_artifact_dir("standups", "/home/me/git/Maestro");
        let b = project_artifact_dir("standups", "/home/me/git/Maestro");
        let plan = project_artifact_dir("plans", "/home/me/git/Maestro");
        assert_eq!(a, b);
        assert_ne!(a, plan);
        // Directory name is the lowercased, sanitized project name + hash.
        let leaf = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(leaf.starts_with("maestro-"), "unexpected leaf: {leaf}");
        assert!(a.parent().unwrap().ends_with("standups"));
    }

    #[test]
    fn or_none_marks_empty_sections() {
        assert_eq!(or_none("   \n "), "(none)");
        assert_eq!(or_none("real"), "real");
    }
}
