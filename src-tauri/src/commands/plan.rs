//! Daily plan generation.
//!
//! Unlike the standup report (one per project, looking backwards), the plan is
//! a SINGLE artifact across every open project, looking forwards: what to work
//! on first today and why. Cross-project prioritisation is the whole point, so
//! there is one saved plan per date under `<app data>/plans/<date>.md`.
//!
//! Material fed to the model, per open project: local git state (branch,
//! uncommitted files, recent commits), the GitHub issues assigned to the user
//! and the PRs waiting on their review (via the `gh` CLI — silently skipped
//! when `gh` is missing or unauthenticated), plus Claude's auto-memory facts
//! for the project as background. On top of that sits a free-text "concerns"
//! box the user keeps in the Plan tab.
//!
//! The run/save/load mechanics are shared with the standup report — see
//! [`super::ai_runner`].

use std::path::PathBuf;

use chrono::Utc;
use serde::Serialize;

use super::ai_runner;
use super::memory;
use crate::git::Git;
use crate::github::{GitHub, IssueFilter, PullRequestFilter};

/// Artifact kind — also the directory name under the app data dir.
const KIND: &str = "plans";
/// Recent-commit window and cap per project (just enough to show momentum).
const RECENT_COMMITS_SINCE: &str = "7 days ago";
const MAX_RECENT_COMMITS: usize = 15;
/// GitHub list caps — a plan cannot act on more than this in one day anyway.
const MAX_GH_ITEMS: u32 = 20;
/// Caps on the material sections (the model sees a bounded prompt).
const MAX_PROJECT_CHARS: usize = 2_000;
const MAX_PROJECTS_CHARS: usize = 12_000;
const MAX_MEMORY_CHARS: usize = 4_000;
const MAX_CONCERNS_CHARS: usize = 2_000;
/// Cap on the MEMORY.md index text pulled in per project.
const MAX_MEMORY_INDEX_CHARS: usize = 1_200;
/// Cap on the per-project fact summaries listed after the index.
const MAX_MEMORY_FACTS: usize = 12;

/// A generated (or loaded) daily plan. One per date, spanning all projects.
#[derive(Debug, Clone, Serialize)]
pub struct DailyPlan {
    /// Local calendar date the plan belongs to (YYYY-MM-DD).
    pub date: String,
    pub markdown: String,
    /// RFC 3339 timestamp of when the plan was generated.
    pub generated_at: String,
}

/// Plans are global, so they sit directly in `<app data>/plans/`.
fn plan_dir() -> PathBuf {
    ai_runner::artifact_base_dir(KIND)
}

/// Built-in prompt. Deliberately not user-editable (unlike the standup
/// template): the plan's value comes from the priority rules below, and the
/// panel already lets the user steer it through the concerns box.
pub const PLAN_PROMPT_TEMPLATE: &str = r#"Write my plan for today ({date}), across every project I have open, so I can read it in under a minute and start working. Base it ONLY on the material below — never invent work that is not evidenced by it.

Voice — it must read like a colleague who has looked at my week, not a report:
- Talk to me directly ("you"), plain language, short sentences.
- No headings, no bold section titles, no greeting, no sign-off, no preamble like "Here's your plan", no code fences.
- No AI-isms: never "Certainly", "Additionally", "Furthermore", "leverage", "delve", "streamline", "robust", "seamless".
- Name the project on every piece of work — this spans several at once.
- Don't read the material back to me; say what to do about it and why.

How to prioritise, strongest first:
1. What I flagged in MY CONCERNS — that is what I said matters right now.
2. Work other people are blocked on (PRs waiting on my review).
3. Issues assigned to me.
4. Local work in progress (uncommitted changes, a branch mid-flight).

Shape (plain text, under 200 words total):
- Open with one line, no bullet: the single thing to do first and why it beats everything else today.
- Then 3-5 short "-" bullets, most important first. Each one: the project, the concrete piece of work, and a few words on why it matters now.
- End with one "-" bullet for anything worth knowing but not worth doing today — only if the material actually shows one.
- If the material shows nothing actionable, say exactly that in one line. Do not pad, and do not invent work to fill the list.

MY CONCERNS (what I told you I care about right now):
{concerns}

PROJECTS (local git state, issues assigned to me, PRs waiting on my review):
{projects}

BACKGROUND — facts Claude has remembered about these projects (context only, never turn these into tasks):
{memory}
"#;

/// Assemble the plan prompt. Every section is pre-truncated by the caller.
fn build_prompt(date: &str, projects: &str, memory: &str, concerns: &str) -> String {
    ai_runner::interpolate(
        PLAN_PROMPT_TEMPLATE,
        &[
            ("{date}", date),
            ("{concerns}", ai_runner::or_none(concerns)),
            ("{projects}", ai_runner::or_none(projects)),
            ("{memory}", ai_runner::or_none(memory)),
        ],
    )
}

/// Local git state for one project, as prompt lines. Every git call degrades
/// to a blank/zero rather than failing the whole plan.
async fn git_section(canonical: &str) -> String {
    let git = Git::new(canonical);
    let branch = git
        .current_branch()
        .await
        .unwrap_or_else(|_| "(unknown)".to_string());
    let dirty = git.uncommitted_count().await.unwrap_or(0);
    let commits = git
        .commit_subjects_text_since(RECENT_COMMITS_SINCE, MAX_RECENT_COMMITS)
        .await
        .unwrap_or_default();
    format!(
        "Branch: {} — {} uncommitted file(s)\nRecent commits:\n{}",
        branch,
        dirty,
        ai_runner::or_none(&commits)
    )
}

/// Issues assigned to the user and PRs requesting their review, via the `gh`
/// CLI. `gh` missing, unauthenticated, or the project not being a GitHub repo
/// all degrade to "(none)" — the plan is still useful without them.
async fn github_section(canonical: &str) -> String {
    let gh = GitHub::new(canonical);

    let issues = gh
        .list_issues(IssueFilter {
            state: Some("open".to_string()),
            limit: Some(MAX_GH_ITEMS),
            search: Some("assignee:@me".to_string()),
        })
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|i| format!("- #{} {} (updated {})", i.number, i.title, i.updated_at))
        .collect::<Vec<_>>()
        .join("\n");

    let prs = gh
        .list_pull_requests(PullRequestFilter {
            state: Some("open".to_string()),
            limit: Some(MAX_GH_ITEMS),
            search: Some("review-requested:@me".to_string()),
        })
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            format!(
                "- #{} {} by {} (updated {})",
                p.number, p.title, p.author.login, p.updated_at
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Issues assigned to me:\n{}\nPRs waiting on my review:\n{}",
        ai_runner::or_none(&issues),
        ai_runner::or_none(&prs)
    )
}

/// Claude's auto-memory for one project: the MEMORY.md index it loads every
/// session, plus a capped list of fact-file summaries. Absent memory is fine.
async fn memory_section(canonical: &str) -> String {
    let dir_name = super::claude_sessions::encode_project_path(canonical);
    let files = memory::list_memory_files(dir_name.clone())
        .await
        .unwrap_or_default();
    if files.is_empty() {
        return String::new();
    }

    let index = memory::read_memory_file(dir_name, "MEMORY.md".to_string())
        .await
        .unwrap_or_default();
    let facts = files
        .iter()
        .filter(|f| !f.is_index)
        .take(MAX_MEMORY_FACTS)
        .map(|f| {
            format!(
                "- {}: {}",
                f.rel_path,
                f.description.as_deref().unwrap_or("(no description)")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut out = String::new();
    if !index.trim().is_empty() {
        out.push_str(&ai_runner::truncate_chars(
            index.trim(),
            MAX_MEMORY_INDEX_CHARS,
        ));
    }
    if !facts.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&facts);
    }
    out
}

/// Generate today's plan across `project_paths` and persist it as
/// `<data>/plans/<today>.md`, replacing any plan already saved for today.
#[tauri::command]
pub async fn generate_daily_plan(
    project_paths: Vec<String>,
    concerns: Option<String>,
) -> Result<DailyPlan, String> {
    if project_paths.is_empty() {
        return Err("No open projects to plan for".to_string());
    }
    let canonicals: Vec<String> = project_paths
        .iter()
        .map(|p| ai_runner::canonical_project_path(p))
        .collect();

    let mut project_blocks: Vec<String> = Vec::new();
    let mut memory_blocks: Vec<String> = Vec::new();
    for canonical in &canonicals {
        let name = ai_runner::project_name_of(canonical);
        let block = format!(
            "== {} ==\n{}\n{}",
            name,
            git_section(canonical).await,
            github_section(canonical).await
        );
        // Per-project cap first, so one noisy repo cannot crowd the others
        // out of the overall cap applied below.
        project_blocks.push(ai_runner::truncate_chars(&block, MAX_PROJECT_CHARS));

        let mem = memory_section(canonical).await;
        if !mem.trim().is_empty() {
            memory_blocks.push(format!("== {} ==\n{}", name, mem));
        }
    }

    let today = ai_runner::today_local();
    let prompt = build_prompt(
        &today,
        &ai_runner::truncate_chars(&project_blocks.join("\n\n"), MAX_PROJECTS_CHARS),
        &ai_runner::truncate_chars(&memory_blocks.join("\n\n"), MAX_MEMORY_CHARS),
        &ai_runner::truncate_chars(concerns.as_deref().unwrap_or(""), MAX_CONCERNS_CHARS),
    );

    // `claude -p` needs a working directory; the first open project is as good
    // as any — the plan's material is already gathered and travels in stdin.
    let dir = plan_dir();
    let markdown = ai_runner::run_and_save(&canonicals[0], prompt, &dir, &today).await?;

    Ok(DailyPlan {
        date: today,
        markdown,
        generated_at: Utc::now().to_rfc3339(),
    })
}

/// Load a previously generated plan. When `date` is omitted, serves the newest
/// saved plan (today's when it exists, otherwise the last one generated) so the
/// panel keeps showing a plan until the next day's replaces it.
#[tauri::command]
pub async fn load_daily_plan(date: Option<String>) -> Result<Option<DailyPlan>, String> {
    let dir = plan_dir();
    let date = match date {
        Some(d) => {
            ai_runner::validate_date(&d)?;
            d
        }
        None => ai_runner::latest_artifact_date(&dir, None)
            .await
            .unwrap_or_else(ai_runner::today_local),
    };

    Ok(ai_runner::load_artifact(&dir, &date)
        .await?
        .map(|(markdown, generated_at)| DailyPlan {
            date,
            markdown,
            generated_at,
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_fills_every_section() {
        let p = build_prompt(
            "2026-08-04",
            "== maestro ==\nBranch: main — 3 uncommitted file(s)",
            "== maestro ==\n- notes.md: a fact",
            "ship the AI panel",
        );
        assert!(p.contains("2026-08-04"));
        assert!(p.contains("ship the AI panel"));
        assert!(p.contains("Branch: main"));
        assert!(p.contains("- notes.md: a fact"));
        assert!(!p.contains("{date}"));
        assert!(!p.contains("{concerns}"));
        assert!(!p.contains("{projects}"));
        assert!(!p.contains("{memory}"));
    }

    #[test]
    fn build_prompt_marks_missing_material_as_none() {
        let p = build_prompt("2026-08-04", "", "", "   ");
        assert_eq!(p.matches("(none)").count(), 3);
    }

    #[test]
    fn build_prompt_does_not_expand_tokens_inside_material() {
        // An issue title or a concerns note containing "{projects}" must not
        // be re-expanded — the single-pass interpolation guarantees that.
        let p = build_prompt("2026-08-04", "issue titled {memory}", "M", "{projects}");
        assert!(p.contains("issue titled {memory}"));
        assert!(p.contains("{projects}\n"));
        // The real sections still got their own material.
        assert!(p.contains("\nM\n") || p.ends_with("M\n"));
    }

    #[test]
    fn plan_dir_is_a_single_global_directory() {
        // One plan per date across all projects — no per-project subdir.
        let dir = plan_dir();
        assert!(dir.ends_with("plans"));
    }

    #[tokio::test]
    async fn generate_rejects_an_empty_project_list() {
        let err = generate_daily_plan(vec![], None).await.unwrap_err();
        assert!(err.contains("No open projects"));
    }
}
