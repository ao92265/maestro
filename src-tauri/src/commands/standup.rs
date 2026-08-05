//! Daily standup report generation.
//!
//! Gathers git commits and Claude agent-session metadata since the previous
//! report, plus a long-horizon project overview (branches + a month of
//! commits) for the "overall status" line, feeds them to a headless
//! `claude -p` run (the user's existing Claude Code login — no API key), and
//! persists the resulting markdown per project per date under the app data
//! directory.
//!
//! The generic machinery — running `claude -p`, saving/loading a dated
//! artifact, newest-artifact lookup, truncation, safe interpolation — lives in
//! [`super::ai_runner`] and is shared with the daily plan. This module owns
//! only the standup's material gathering and prompt.

use std::path::PathBuf;

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde::Serialize;

use super::ai_runner;
use super::claude_sessions;
use crate::git::Git;

/// Artifact kind — also the directory name under the app data dir. Changing
/// it would orphan every previously saved report.
const KIND: &str = "standups";
/// Noun used in the errors this feature surfaces to the user. Pinned to
/// "report" so the messages are byte-identical to the pre-extraction ones.
const NOUN: &str = "report";
/// Ceiling for the since-last-report commit log only — a standup covers at
/// most a few days of work. The long-horizon overview has its own cap below.
const MAX_COMMITS: usize = 100;
/// Fallback window when no previous report exists (covers a long weekend).
const DEFAULT_SINCE_DAYS: i64 = 3;
/// Cap the raw material fed to the model.
const MAX_COMMITS_CHARS: usize = 12_000;
const MAX_SESSIONS_CHARS: usize = 4_000;
/// Long-horizon window backing the "overall status" line of the report.
const OVERVIEW_SINCE_DAYS: i64 = 30;
/// Commit cap for the overview list (compact one-line-per-commit format);
/// the char cap below trims whatever still overflows.
const MAX_OVERVIEW_COMMITS: usize = 300;
const MAX_OVERVIEW_CHARS: usize = 4_000;

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

/// Per-project report directory: `<app data>/standups/<name>-<hash12>/`.
fn project_report_dir(canonical_project: &str) -> PathBuf {
    ai_runner::project_artifact_dir(KIND, canonical_project)
}

/// Built-in prompt template. Users may override it from the AI panel;
/// `{project}`, `{date}`, `{since}`, `{commits}`, `{sessions}` and
/// `{overview}` are substituted before the prompt is sent to `claude -p`.
pub const DEFAULT_PROMPT_TEMPLATE: &str = r#"Write my standup update for the {project} project ({date}) so I can paste it straight into my team's group chat. Base it ONLY on the material below — never invent work that is not evidenced by it.

Voice — it must read like I typed it myself:
- First person ("I"), casual but professional, plain language.
- No headings, no bold section titles, no greeting, no sign-off, no preamble like "Here's your standup", no code fences.
- No AI-isms: never "Certainly", "Additionally", "Furthermore", "I successfully", "leveraged", "delved".
- Summarize the work the way a dev would say it out loud. Do NOT enumerate commits, files, or every branch — group related work into one plain-words point. Skip technical detail a teammate wouldn't need.
- The material can include teammates' commits (author names are shown). Only claim work I authored; leave other people's commits out.

Shape (plain text, under 120 words total):
- 2-4 short "-" bullets: what I got done since {since}, grouped by topic.
- 1 bullet: what I'm picking up next (the natural follow-up from the material).
- 1 bullet for blockers ONLY if the material shows a real one; otherwise leave blockers out or end a bullet with "no blockers".
- If RECENT WORK shows nothing of mine since {since}, replace those bullets with one short line saying I've nothing new to report — do not pad, and do not mine the PROJECT OVERVIEW for filler.
- Close with one or two sentences (no bullet): where the project stands overall — big-picture progress judged from the PROJECT OVERVIEW below, not just the last day's changes.

RECENT WORK (since {since}):

== Git commits ==
{commits}

== Claude agent sessions in this project ==
{sessions}

PROJECT OVERVIEW (only for the closing overall-status sentences):
{overview}
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
    overview: &str,
) -> String {
    let template = match template {
        Some(t) if !t.trim().is_empty() => t,
        _ => DEFAULT_PROMPT_TEMPLATE,
    };
    ai_runner::interpolate(
        template,
        &[
            ("{project}", project_name),
            ("{date}", date),
            ("{since}", since),
            ("{commits}", ai_runner::or_none(commits)),
            ("{sessions}", ai_runner::or_none(sessions)),
            ("{overview}", ai_runner::or_none(overview)),
        ],
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
    let canonical = ai_runner::canonical_project_path(&project_path);

    let today = ai_runner::today_local();
    let report_dir = project_report_dir(&canonical);
    let since = ai_runner::latest_artifact_date(&report_dir, Some(&today))
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

    // 3. Long-horizon overview (branches + a month of commits) so the model
    //    can judge where the project stands overall, not just the last delta.
    let branches = git
        .list_branches()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|b| !b.is_remote)
        .map(|b| {
            if b.is_current {
                format!("{} (current)", b.name)
            } else {
                b.name
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let branches_line = if branches.is_empty() {
        "(none)".to_string()
    } else {
        branches
    };
    let overview_since = (Local::now() - Duration::days(OVERVIEW_SINCE_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let overview_log = git
        .commit_subjects_text_since(&overview_since, MAX_OVERVIEW_COMMITS)
        .await
        .unwrap_or_default();
    let commit_count = overview_log
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();
    let overview = if commit_count == 0 {
        format!(
            "Local branches: {}\n\nNo commits in the last {} days.",
            branches_line, OVERVIEW_SINCE_DAYS
        )
    } else {
        format!(
            "Local branches: {}\n\n{}{} commits across all branches in the last {} days — most recent listed first, list may be truncated:\n{}",
            branches_line,
            commit_count,
            if commit_count == MAX_OVERVIEW_COMMITS { "+" } else { "" },
            OVERVIEW_SINCE_DAYS,
            overview_log
        )
    };

    let project_name = ai_runner::project_name_of(&canonical);

    let prompt = build_prompt(
        prompt_template.as_deref(),
        &project_name,
        &today,
        &since,
        &ai_runner::truncate_chars(&commits, MAX_COMMITS_CHARS),
        &ai_runner::truncate_chars(&sessions, MAX_SESSIONS_CHARS),
        &ai_runner::truncate_chars(&overview, MAX_OVERVIEW_CHARS),
    );

    let markdown = ai_runner::run_and_save(&canonical, prompt, &report_dir, &today, NOUN).await?;

    Ok(StandupReport {
        project_path,
        date: today,
        markdown,
        generated_at: Utc::now().to_rfc3339(),
    })
}

/// Load a previously generated report. When `date` is omitted, serves the
/// newest saved report (today's when it exists, otherwise the last one
/// generated) so the panel keeps showing a report until the next day's
/// replaces it. Returns `None` when no matching report exists.
#[tauri::command]
pub async fn load_standup_report(
    project_path: String,
    date: Option<String>,
) -> Result<Option<StandupReport>, String> {
    let canonical = ai_runner::canonical_project_path(&project_path);
    let report_dir = project_report_dir(&canonical);

    let date = match date {
        Some(d) => {
            ai_runner::validate_date(&d, NOUN)?;
            d
        }
        None => ai_runner::latest_artifact_date(&report_dir, None)
            .await
            .unwrap_or_else(ai_runner::today_local),
    };

    Ok(ai_runner::load_artifact(&report_dir, &date, NOUN)
        .await?
        .map(|(markdown, generated_at)| StandupReport {
            project_path,
            date,
            markdown,
            generated_at,
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_substitutes_placeholders_for_empty_material() {
        let p = build_prompt(None, "maestro", "2026-07-30", "2026-07-28", "", "", "");
        assert!(p.contains("maestro"));
        assert!(p.contains("(none)"));
        assert!(!p.contains("{project}"));
        assert!(!p.contains("{overview}"));
    }

    #[test]
    fn build_prompt_uses_custom_template_with_placeholders() {
        let p = build_prompt(
            Some("Report for {project} on {date}: {commits} / {sessions} / {overview}"),
            "maestro",
            "2026-07-31",
            "2026-07-30",
            "abc fix bug",
            "",
            "branch list",
        );
        assert_eq!(
            p,
            "Report for maestro on 2026-07-31: abc fix bug / (none) / branch list"
        );
    }

    #[test]
    fn build_prompt_custom_template_without_overview_is_unchanged() {
        // Backward-compat pin: a pre-{overview} custom template must produce
        // byte-identical output even though an overview is now supplied.
        let p = build_prompt(
            Some("Report for {project} on {date}: {commits} / {sessions}"),
            "maestro",
            "2026-07-31",
            "2026-07-30",
            "abc fix bug",
            "",
            "branch list",
        );
        assert_eq!(p, "Report for maestro on 2026-07-31: abc fix bug / (none)");
    }

    #[test]
    fn build_prompt_does_not_expand_tokens_inside_material() {
        // Placeholder-looking text inside the material must pass through
        // verbatim — only tokens in the template itself are interpolated.
        let p = build_prompt(
            Some("C: {commits} S: {sessions} O: {overview}"),
            "maestro",
            "2026-07-31",
            "2026-07-30",
            "subject mentions {sessions} and {overview}",
            "session says {overview} and {commits}",
            "OVERVIEW",
        );
        assert_eq!(
            p,
            "C: subject mentions {sessions} and {overview} S: session says {overview} and {commits} O: OVERVIEW"
        );
    }

    #[test]
    fn build_prompt_falls_back_to_default_on_blank_template() {
        let p = build_prompt(
            Some("   "),
            "maestro",
            "2026-07-31",
            "2026-07-30",
            "",
            "",
            "",
        );
        assert!(p.contains("PROJECT OVERVIEW"));
    }

    #[test]
    fn report_dir_is_unchanged_by_the_shared_runner() {
        // Pin the on-disk layout exactly — name AND hash: saved reports must
        // keep loading after the extraction, so the directory stays
        // `<data>/standups/<lowercased-name>-<project-hash>`.
        let path = "/home/me/git/Maestro";
        let dir = project_report_dir(path);
        assert!(dir.parent().unwrap().ends_with("standups"));
        let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            leaf,
            format!(
                "maestro-{}",
                crate::core::status_server::StatusServer::generate_project_hash(path)
            )
        );
    }

    #[test]
    fn standup_error_wording_is_unchanged() {
        // The shared runner takes a noun so the plan can say "plan"; standup
        // must keep the exact strings it had before the extraction.
        assert_eq!(NOUN, "report");
        assert_eq!(
            ai_runner::validate_date("nope", NOUN).unwrap_err(),
            "Invalid report date: nope"
        );
    }
}
