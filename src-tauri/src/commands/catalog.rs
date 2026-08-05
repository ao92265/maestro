//! On-demand project feature catalogue.
//!
//! Unlike the standup report and the daily plan — both of which summarise
//! material Maestro has already gathered — the catalogue asks the headless
//! Claude run to EXPLORE the repository itself (it has read/grep/glob tools in
//! the project's own directory) and write down what the app actually does, per
//! feature, with a done/partial/gaps status naming the gaps concretely.
//!
//! It is strictly on demand: nothing schedules it, nothing catches it up on
//! launch. The "Scan project" button in the Catalog tab is the only trigger,
//! because a scan is slow and expensive in a way a daily job should not be.
//!
//! Extra signal fed in alongside the repo: the project's open GitHub issues
//! (wanted work, not built work) and — on a rescan — the previous catalogue,
//! so the model updates it and can say what changed since that scan.
//!
//! The run/save/load mechanics are shared with the standup report and the
//! plan — see [`super::ai_runner`].

use std::path::PathBuf;

use chrono::Utc;
use serde::Serialize;

use super::ai_runner;
use crate::github::{GitHub, IssueFilter};

/// Artifact kind — also the directory name under the app data dir.
const KIND: &str = "catalogs";
/// The model reads its way around the whole repo, which takes far longer than
/// the one-pass summaries; 45 minutes is a ceiling on a hung run, not an
/// expectation. The shared 5-minute default would kill a real scan.
const CATALOG_TIMEOUT_SECS: u64 = 2_700;
/// Open-issue cap — enough to show what is planned without flooding the prompt.
const MAX_ISSUES: u32 = 60;
/// Caps on the material sections (the model sees a bounded prompt).
const MAX_ISSUES_CHARS: usize = 6_000;
const MAX_PREVIOUS_CHARS: usize = 24_000;

/// A generated (or loaded) feature catalogue for one project.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectCatalog {
    pub project_path: String,
    /// Local calendar date of the scan (YYYY-MM-DD).
    pub date: String,
    pub markdown: String,
    /// RFC 3339 timestamp of when the scan finished.
    pub generated_at: String,
}

/// Per-project catalogue directory: `<app data>/catalogs/<name>-<hash12>/`.
fn catalog_dir(canonical_project: &str) -> PathBuf {
    ai_runner::project_artifact_dir(KIND, canonical_project)
}

/// Built-in prompt. Not user-editable: unlike the standup, the whole value of
/// the catalogue is the shape enforced below (feature, plain explanation,
/// concrete status), and a loosened template quietly turns it back into the
/// architecture dump it exists to avoid.
///
/// The `r####"` delimiter is deliberate: the prompt quotes markdown headings
/// (`"## "`, `"### "`), and a `"#`/`"##`/`"###` run would close a shorter raw
/// string mid-template.
pub const CATALOG_PROMPT_TEMPLATE: &str = r####"Catalogue what the {project} project actually does, so I can come back to it after weeks away and see what is built and what is still missing. Today is {date}.

Explore the repository yourself before writing anything — read the entry points, the commands, the screens, the settings, the tests. The code is the only proof a feature exists. The material at the bottom is extra signal, not evidence: an open issue means somebody wanted something, not that it is there.

Write it for the version of me who has forgotten this codebase. I lose track of the features I have built, what they do, and which ones are half-finished — that is the problem this has to solve.

Voice:
- Talk to me directly ("you"), plain language, short sentences.
- Describe each feature the way somebody using the app meets it, not the way the code is laid out. No file paths, no function or class names, no architecture tour, no tech-stack list.
- No AI-isms: never "Certainly", "Additionally", "Furthermore", "leverage", "delve", "streamline", "robust", "seamless", "comprehensive".
- Never list a feature you did not find in the code.

Shape (markdown, no preamble, no sign-off, no closing summary):
- Group features by area — the parts of the app somebody would name out loud. One "## " heading per area, most important area first.
- One "### " heading per feature inside its area: the feature's name in plain words.
- Under every feature, exactly three things, in this order and nothing else:
  1. one or two sentences on what it does and why it is there;
  2. a line starting "How to use it: " — the real steps from the app's surface (the button, the menu, the command, the flag), only what the code shows;
  3. a line starting "Status: " — "done", "partial" or "gaps", then a dash and the specifics. "partial" and "gaps" have to name the missing piece concretely: an unhandled case, a TODO, a stubbed path, a setting nothing reads, no error handling, no tests. Never write a vague "could be improved".
- Then a "## What's missing" section: one "-" bullet per thing that is expected or planned but not built, most useful first. Anything that exists only as an open issue belongs here, with its number.
{changes_rule}
OPEN GITHUB ISSUES (wanted or reported — never proof that something is built):
{issues}

{previous}
"####;

/// Assemble the catalogue prompt. `previous` is `(scan date, markdown)` of the
/// last saved catalogue, pre-truncated by the caller.
///
/// The "what changed" section is asked for only when the previous catalogue is
/// from an EARLIER day — a same-day rescan still gets the old catalogue as
/// material to update, but "what changed since today" is not a real question.
fn build_prompt(
    project_name: &str,
    date: &str,
    issues: &str,
    previous: Option<(&str, &str)>,
) -> String {
    let changes_rule = match previous {
        Some((prev_date, _)) if prev_date != date => format!(
            "- Finish with a \"## What changed since {}\" section: 3-6 \"-\" bullets on what is new, what moved from partial to done, and what is still open since that scan. Only real differences against the previous catalogue — if nothing changed, say that in one line.\n",
            prev_date
        ),
        _ => String::new(),
    };
    let previous_section = match previous {
        Some((prev_date, markdown)) => format!(
            "PREVIOUS CATALOGUE (scanned {}) — update it against the code as it is today: keep what is still true, correct what has gone stale, add what is new:\n{}",
            prev_date, markdown
        ),
        None => "PREVIOUS CATALOGUE: (none — this is the first scan of this project)".to_string(),
    };

    ai_runner::interpolate(
        CATALOG_PROMPT_TEMPLATE,
        &[
            ("{project}", project_name),
            ("{date}", date),
            ("{changes_rule}", &changes_rule),
            ("{issues}", ai_runner::or_none(issues)),
            ("{previous}", &previous_section),
        ],
    )
}

/// Open issues as prompt lines. Labels are kept because they are what tells a
/// wishlist item apart from a bug report.
fn issue_lines(issues: &[crate::github::IssueInfo]) -> String {
    issues
        .iter()
        .map(|i| {
            let labels = i
                .labels
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            if labels.is_empty() {
                format!("- #{} {}", i.number, i.title)
            } else {
                format!("- #{} {} [{}]", i.number, i.title, labels)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The project's open GitHub issues. `gh` missing, unauthenticated, or the
/// project not being a GitHub repo all degrade to an empty list — the scan is
/// still worth running on the code alone.
async fn issues_section(canonical: &str) -> String {
    let issues = GitHub::new(canonical)
        .list_issues(IssueFilter {
            state: Some("open".to_string()),
            limit: Some(MAX_ISSUES),
            search: None,
        })
        .await
        .unwrap_or_default();
    issue_lines(&issues)
}

/// Scan one project and persist the catalogue as
/// `<data>/catalogs/<project>/<today>.md`. On-demand only — nothing else calls
/// this.
#[tauri::command]
pub async fn scan_project_catalog(project_path: String) -> Result<ProjectCatalog, String> {
    let canonical = ai_runner::canonical_project_path(&project_path);
    let dir = catalog_dir(&canonical);
    let today = ai_runner::today_local();

    // Newest catalogue on disk, whatever its date — a rescan updates the last
    // one rather than starting from scratch.
    let previous = match ai_runner::latest_artifact_date(&dir, None).await {
        Some(prev_date) => ai_runner::load_artifact(&dir, &prev_date)
            .await
            .unwrap_or(None)
            .map(|(markdown, _)| {
                (
                    prev_date,
                    ai_runner::truncate_chars(&markdown, MAX_PREVIOUS_CHARS),
                )
            }),
        None => None,
    };

    let prompt = build_prompt(
        &ai_runner::project_name_of(&canonical),
        &today,
        &ai_runner::truncate_chars(&issues_section(&canonical).await, MAX_ISSUES_CHARS),
        previous.as_ref().map(|(d, m)| (d.as_str(), m.as_str())),
    );

    let markdown = ai_runner::run_and_save_with_timeout(
        &canonical,
        prompt,
        &dir,
        &today,
        CATALOG_TIMEOUT_SECS,
    )
    .await?;

    Ok(ProjectCatalog {
        project_path,
        date: today,
        markdown,
        generated_at: Utc::now().to_rfc3339(),
    })
}

/// Load a previously saved catalogue. With no `date`, serves the newest one on
/// disk — the catalogue has no daily rhythm, so the last scan stays the current
/// one until a rescan replaces it.
#[tauri::command]
pub async fn load_project_catalog(
    project_path: String,
    date: Option<String>,
) -> Result<Option<ProjectCatalog>, String> {
    let canonical = ai_runner::canonical_project_path(&project_path);
    let dir = catalog_dir(&canonical);

    let date = match date {
        Some(d) => {
            ai_runner::validate_date(&d)?;
            d
        }
        None => match ai_runner::latest_artifact_date(&dir, None).await {
            Some(d) => d,
            // No scan has ever run for this project — an empty panel, not an
            // error, and no pointless read of a file that cannot exist.
            None => return Ok(None),
        },
    };

    Ok(ai_runner::load_artifact(&dir, &date)
        .await?
        .map(|(markdown, generated_at)| ProjectCatalog {
            project_path,
            date,
            markdown,
            generated_at,
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{IssueInfo, PrAuthor, PrLabel};

    fn issue(number: u64, title: &str, labels: &[&str]) -> IssueInfo {
        IssueInfo {
            number,
            title: title.to_string(),
            state: "OPEN".to_string(),
            author: PrAuthor {
                login: "me".to_string(),
            },
            created_at: "2026-08-01T00:00:00Z".to_string(),
            updated_at: "2026-08-02T00:00:00Z".to_string(),
            url: format!("https://example.test/{}", number),
            labels: labels
                .iter()
                .map(|n| PrLabel {
                    name: n.to_string(),
                    color: "ffffff".to_string(),
                })
                .collect(),
            closed_at: None,
        }
    }

    #[test]
    fn build_prompt_fills_every_section() {
        let p = build_prompt("maestro", "2026-08-05", "- #12 add a catalog tab", None);
        assert!(p.contains("maestro"));
        assert!(p.contains("2026-08-05"));
        assert!(p.contains("- #12 add a catalog tab"));
        assert!(!p.contains("{project}"));
        assert!(!p.contains("{date}"));
        assert!(!p.contains("{issues}"));
        assert!(!p.contains("{previous}"));
        assert!(!p.contains("{changes_rule}"));
    }

    #[test]
    fn build_prompt_asks_for_the_shape_the_catalog_exists_for() {
        // The feature/status shape is the point — pin it so a prompt tidy-up
        // cannot quietly turn the catalogue back into an architecture dump.
        let p = build_prompt("maestro", "2026-08-05", "", None);
        assert!(p.contains("How to use it: "));
        assert!(p.contains("\"done\", \"partial\" or \"gaps\""));
        assert!(p.contains("## What's missing"));
        assert!(p.contains("No file paths"));
    }

    #[test]
    fn build_prompt_marks_a_first_scan_and_omits_the_change_section() {
        let p = build_prompt("maestro", "2026-08-05", "", None);
        assert!(p.contains("(none — this is the first scan of this project)"));
        assert!(!p.contains("What changed since"));
    }

    #[test]
    fn build_prompt_asks_what_changed_since_an_older_catalog() {
        let p = build_prompt(
            "maestro",
            "2026-08-05",
            "",
            Some(("2026-07-20", "## Terminals\n### Splits")),
        );
        assert!(p.contains("## What changed since 2026-07-20"));
        assert!(p.contains("PREVIOUS CATALOGUE (scanned 2026-07-20)"));
        assert!(p.contains("### Splits"));
    }

    #[test]
    fn build_prompt_skips_the_change_section_on_a_same_day_rescan() {
        // The old catalogue is still fed in as material to update, but
        // "what changed since today" is not a question worth asking.
        let p = build_prompt("maestro", "2026-08-05", "", Some(("2026-08-05", "## Old")));
        assert!(!p.contains("What changed since"));
        assert!(p.contains("PREVIOUS CATALOGUE (scanned 2026-08-05)"));
        assert!(p.contains("## Old"));
    }

    #[test]
    fn build_prompt_does_not_expand_tokens_inside_material() {
        // An issue title or a previous catalogue containing "{issues}" must
        // pass through verbatim — single-pass interpolation guarantees that.
        let p = build_prompt(
            "maestro",
            "2026-08-05",
            "- #3 support {previous} in templates",
            Some(("2026-08-04", "mentions {issues}")),
        );
        assert!(p.contains("- #3 support {previous} in templates"));
        assert!(p.contains("mentions {issues}"));
    }

    #[test]
    fn build_prompt_marks_missing_issues_as_none() {
        let p = build_prompt("maestro", "2026-08-05", "   ", None);
        assert!(p.contains("(none)"));
    }

    #[test]
    fn issue_lines_lists_numbers_titles_and_labels() {
        let text = issue_lines(&[
            issue(7, "Catalog tab", &["enhancement", "ai"]),
            issue(9, "Crash on quit", &[]),
        ]);
        assert_eq!(
            text,
            "- #7 Catalog tab [enhancement, ai]\n- #9 Crash on quit"
        );
        assert_eq!(issue_lines(&[]), "");
    }

    #[test]
    fn catalog_dir_is_per_project_and_kind_scoped() {
        let a = catalog_dir("/home/me/git/Maestro");
        assert_eq!(a, catalog_dir("/home/me/git/Maestro"));
        assert_ne!(a, catalog_dir("/home/me/git/other"));
        assert!(a.parent().unwrap().ends_with("catalogs"));
        let leaf = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(leaf.starts_with("maestro-"), "unexpected leaf: {leaf}");
    }

    #[tokio::test]
    async fn load_returns_none_when_a_project_was_never_scanned() {
        let missing = tempfile::tempdir().unwrap();
        let path = missing.path().join("never-scanned");
        std::fs::create_dir(&path).unwrap();
        let loaded = load_project_catalog(path.to_string_lossy().into_owned(), None)
            .await
            .unwrap();
        assert!(loaded.is_none());
    }

    #[tokio::test]
    async fn load_rejects_a_date_that_is_not_a_date() {
        // The date becomes a filename; anything else must not reach the disk.
        let err = load_project_catalog("/tmp/x".to_string(), Some("../../secret".to_string()))
            .await
            .unwrap_err();
        assert!(err.contains("Invalid report date"));
    }
}
