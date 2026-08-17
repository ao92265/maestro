//! Persistent PR-review run records (issue #139; epic #136).
//!
//! A samurai run leaves a run config, handoffs, briefs and audit rows behind.
//! A **PR review** left nothing at all: the Git tab opened a terminal, typed a
//! prompt and forgot. With no artifact on disk the review had no identity, so
//! the Second Brain could not group its brief (issue #138) under anything, and
//! no audit row could ever attach to it.
//!
//! So every PR-review launch writes one small JSON record here — PR number and
//! title, the repo it belongs to, the checkout it ran in, the ticked steps, the
//! brief it was delivered as, and the terminal session it opened. That record
//! IS the group's identity ([`pr_group_id`]), exactly the way a run config is a
//! run's.
//!
//! **Layout:** one file per launch at
//! `<app data>/runs/<PR_RUNS_DIR>/<owner>-<repo>-<number>-<ts>.json`. Inside
//! the `runs` root on purpose — that root is already a Samurai-managed delete
//! root (`samurai_files::delete_file`), so a record is deletable through the
//! same guard as every other managed file with no new root to authorise. The
//! `pr` subdirectory can never collide with a run config's project directory:
//! those are always `<sanitized-basename>-<hash12>`
//! (`samurai_run_config::project_dir_name`), which `pr` is not, and
//! `RunConfigStore::load_all` skips this name explicitly.
//!
//! **Best effort, never blocking:** a launch that cannot write its record logs
//! and carries on. The review still runs; it simply groups under nothing until
//! the next launch — the same policy the brief write itself follows.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Directory name, inside the `runs` root, holding PR-review records.
pub const PR_RUNS_DIR: &str = "pr";

/// The record's `kind` discriminator. A one-variant enum so the SCREAMING wire
/// spelling is pinned by serde rather than by a string literal (the
/// `samurai_journal::MarkerKind` precedent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrRunKind {
    PrReview,
}

/// What a PR-review launch tells the store about itself. Everything the record
/// carries EXCEPT the two facts only the delivery path knows — the session the
/// terminal opened under and the brief it was actually staged as.
///
/// snake_case on the wire like every samurai sibling: this crosses the Tauri
/// boundary as a `terminal_arm_initial_prompt` parameter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrReviewLaunch {
    /// The pull request number.
    pub pr: u32,
    /// The PR title as the Git tab already had it — the label's title half.
    /// Empty when the payload carried none: the label then degrades to the
    /// ref alone, and the launch is never blocked for it.
    pub title: String,
    /// `owner/repo`. Empty when the PR url did not parse into a slug; the
    /// group id then keys off the empty slug, which still separates PRs by
    /// number within a checkout.
    pub repo: String,
    /// The checkout the review terminal opened in.
    pub project_path: String,
    /// The workflow step ids the user ticked, in order.
    pub steps: Vec<String>,
}

/// One PR review, on disk. Fields are snake_case on the wire like every
/// samurai sibling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrReviewRun {
    pub kind: PrRunKind,
    pub pr: u32,
    pub title: String,
    pub repo: String,
    pub project_path: String,
    pub steps: Vec<String>,
    /// Worktree-relative path of the brief the prompt was staged as
    /// (`samurai_brief`), or `None` when the prompt was short enough to type
    /// inline — a review is not required to have a brief.
    #[serde(default)]
    pub brief: Option<String>,
    /// The Maestro terminal session the review opened in. Its liveness is what
    /// makes the group live.
    pub session_id: u32,
    /// RFC 3339 UTC creation timestamp.
    pub created_at: String,
}

impl PrReviewRun {
    /// Builds a record from a launch plus the two delivery facts, stamped with
    /// the current UTC time.
    pub fn now(launch: PrReviewLaunch, session_id: u32, brief: Option<String>) -> Self {
        Self {
            kind: PrRunKind::PrReview,
            pr: launch.pr,
            title: launch.title,
            repo: launch.repo,
            project_path: launch.project_path,
            steps: launch.steps,
            brief,
            session_id,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// This review's group id (see [`pr_group_id`]).
    pub fn group_id(&self) -> String {
        pr_group_id(&self.repo, self.pr)
    }
}

/// The Second Brain group id of a PR review: `pr:<owner/repo>#<number>`
/// (issue #139). Stable across calls and across launches — two reviews of the
/// same PR are the same group, which is the point: their briefs and records
/// belong together.
pub fn pr_group_id(repo: &str, number: u32) -> String {
    format!("pr:{repo}#{number}")
}

/// The on-disk store, rooted at `<app data>/runs/<PR_RUNS_DIR>`. Constructed
/// once at app setup and managed as `Arc<PrRunStore>`; tests root it at a
/// tempdir.
pub struct PrRunStore {
    base_dir: PathBuf,
}

impl PrRunStore {
    /// `runs_dir` is the `runs` root itself — the store appends
    /// [`PR_RUNS_DIR`], so callers never have to know the layout.
    pub fn new(runs_dir: PathBuf) -> Self {
        Self {
            base_dir: runs_dir.join(PR_RUNS_DIR),
        }
    }

    /// Writes one record, returning its path. One file per launch: the
    /// timestamp in the name keeps a relaunch of the same PR from overwriting
    /// the previous review's record (they share a group, not a file).
    pub fn record(&self, run: &PrReviewRun) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.base_dir).map_err(|e| {
            format!(
                "failed to create the PR run directory {}: {e}",
                self.base_dir.display()
            )
        })?;
        let path = self.base_dir.join(record_file_name(run));
        let json = serde_json::to_string_pretty(run)
            .map_err(|e| format!("failed to serialize the PR review record: {e}"))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
        Ok(path)
    }

    /// Every readable record with its on-disk path — the Second Brain
    /// inventory's input. Corrupt files are skipped with a warning, like
    /// `RunConfigStore::load_all`: one torn record must not blank the panel.
    pub fn list_with_paths(&self) -> Vec<(PathBuf, PrReviewRun)> {
        let mut runs: Vec<(PathBuf, PrReviewRun)> = Vec::new();
        let Ok(files) = std::fs::read_dir(&self.base_dir) else {
            // Nothing recorded yet — the normal first-launch state.
            return runs;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|c| serde_json::from_str::<PrReviewRun>(&c).map_err(|e| e.to_string()))
            {
                Ok(run) => runs.push((path, run)),
                Err(e) => log::warn!("samurai pr runs: skipping unreadable record {path:?}: {e}"),
            }
        }
        runs
    }
}

/// `<owner>-<repo>-<number>-<ts>.json`, every segment sanitized to
/// `[a-z0-9-]`: `owner/repo` carries a slash and an RFC 3339 timestamp carries
/// colons, neither of which is a legal Windows file name character.
fn record_file_name(run: &PrReviewRun) -> String {
    let repo = sanitize(&run.repo);
    let ts = sanitize(&run.created_at);
    format!("{repo}-{}-{ts}.json", run.pr)
}

/// Lowercased, with every run of non-`[a-z0-9]` characters collapsed to one
/// `-` and the ends trimmed (the `prActionBriefStem` rule, in Rust).
fn sanitize(value: &str) -> String {
    let collapsed: String = value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut out = String::with_capacity(collapsed.len());
    let mut last_dash = false;
    for c in collapsed.chars() {
        if c == '-' {
            if !last_dash {
                out.push(c);
            }
            last_dash = true;
        } else {
            out.push(c);
            last_dash = false;
        }
    }
    out.trim_matches('-').to_string()
}

/// Path of the brief a PR review was staged as, when it has one: the record's
/// worktree-relative `brief` resolved against its checkout.
pub fn brief_path(run: &PrReviewRun) -> Option<PathBuf> {
    let brief = run.brief.as_deref()?;
    Some(Path::new(&run.project_path).join(brief))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn launch() -> PrReviewLaunch {
        PrReviewLaunch {
            pr: 142,
            title: "fix journal splitting".to_string(),
            repo: "nachogl1/maestro".to_string(),
            project_path: r"C:\git\maestro".to_string(),
            steps: vec!["check".to_string(), "review".to_string()],
        }
    }

    #[test]
    fn test_record_roundtrips_with_the_agreed_wire_shape() {
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());
        let run = PrReviewRun::now(
            launch(),
            7,
            Some(".maestro/briefs/pr-142-check-review.md".to_string()),
        );

        let path = store.record(&run).unwrap();
        assert_eq!(store.list_with_paths(), vec![(path.clone(), run.clone())]);

        // The exact JSON the issue specifies — dependent surfaces read these
        // keys, and `kind` is the SCREAMING discriminator.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for key in [
            "kind",
            "pr",
            "title",
            "repo",
            "project_path",
            "steps",
            "brief",
            "session_id",
            "created_at",
        ] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["kind"], "PR_REVIEW");
        assert_eq!(raw["pr"], 142);
        assert_eq!(raw["brief"], ".maestro/briefs/pr-142-check-review.md");
        assert!(chrono::DateTime::parse_from_rfc3339(&run.created_at).is_ok());
    }

    #[test]
    fn test_file_name_is_filesystem_safe_and_one_file_per_launch() {
        // `owner/repo` carries a slash and the timestamp colons — neither is
        // legal in a Windows file name, so both are sanitized. And a second
        // review of the same PR must not overwrite the first record.
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());

        let mut first = PrReviewRun::now(launch(), 7, None);
        first.created_at = "2026-08-17T12:00:00+00:00".to_string();
        let mut second = PrReviewRun::now(launch(), 9, None);
        second.created_at = "2026-08-17T13:30:00+00:00".to_string();

        let a = store.record(&first).unwrap();
        let b = store.record(&second).unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("nachogl1-maestro-142-"), "{name}");
        assert!(
            !name.contains('/') && !name.contains(':'),
            "unsafe file name {name}"
        );
        assert_eq!(store.list_with_paths().len(), 2);
        // Absent brief: `None`, not a fabricated path.
        assert!(store
            .list_with_paths()
            .iter()
            .all(|(_, r)| r.brief.is_none()));
    }

    #[test]
    fn test_group_id_is_stable_and_per_pr() {
        let run = PrReviewRun::now(launch(), 7, None);
        assert_eq!(run.group_id(), "pr:nachogl1/maestro#142");
        assert_eq!(run.group_id(), pr_group_id("nachogl1/maestro", 142));
        assert_ne!(run.group_id(), pr_group_id("nachogl1/maestro", 143));
        assert_ne!(run.group_id(), pr_group_id("other/maestro", 142));
    }

    #[test]
    fn test_unreadable_records_are_skipped_not_fatal() {
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());
        store.record(&PrReviewRun::now(launch(), 7, None)).unwrap();
        std::fs::write(dir.path().join(PR_RUNS_DIR).join("torn.json"), "{ not json").unwrap();
        std::fs::write(dir.path().join(PR_RUNS_DIR).join("notes.txt"), "ignored").unwrap();

        assert_eq!(store.list_with_paths().len(), 1);
    }

    #[test]
    fn test_brief_path_resolves_against_the_checkout() {
        let run = PrReviewRun::now(
            launch(),
            7,
            Some(".maestro/briefs/pr-142-check-review.md".to_string()),
        );
        assert_eq!(
            brief_path(&run).unwrap(),
            Path::new(r"C:\git\maestro").join(".maestro/briefs/pr-142-check-review.md")
        );
        assert!(brief_path(&PrReviewRun::now(launch(), 7, None)).is_none());
    }
}
