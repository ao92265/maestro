//! Reads Claude handoff summaries so the UI can recover session context without
//! depending on the JavaScript dashboard that originally produced the format.

use chrono::{DateTime, Utc};
use directories::BaseDirs;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const STALE_AFTER: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Kept as a nested value so handoffs without a recorded commit serialize as
/// `null` rather than inventing an empty hash and message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub hash: String,
    pub msg: String,
}

/// A best-effort view of one handoff; optional fields tolerate incomplete
/// snapshots left behind by interrupted Claude sessions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffInfo {
    pub slug: String,
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub uncommitted: u32,
    pub last_commit: Option<LastCommit>,
    pub asks: Vec<String>,
    pub last_action: String,
    pub waiting: bool,
    pub last_active: String,
    pub stale: bool,
    pub orphan: bool,
}

fn handoffs_root() -> Result<PathBuf, String> {
    let base_dirs = BaseDirs::new().ok_or("Could not resolve home directory")?;
    Ok(base_dirs.home_dir().join(".claude").join("handoffs"))
}

fn line_value<'a>(content: &'a str, label: &str) -> Option<&'a str> {
    content.lines().find_map(|line| {
        let line = line.trim_start().strip_prefix('-')?.trim_start();
        let prefix = line.get(..label.len())?;
        if !prefix.eq_ignore_ascii_case(label) {
            return None;
        }
        Some(line[label.len()..].trim_start())
    })
}

fn quoted_line_value(content: &str, label: &str) -> Option<String> {
    let value = line_value(content, label)?.strip_prefix('`')?;
    let closing_tick = value.find('`')?;
    let value = value[..closing_tick].trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn branch_value(content: &str) -> Option<String> {
    let raw = line_value(content, "Branch:")?;
    let raw = raw.strip_prefix('`').unwrap_or(raw);
    let branch = raw.split('`').next().unwrap_or_default().trim();
    if branch.is_empty()
        || branch == "?"
        || branch.to_ascii_lowercase().contains("unknown")
        || branch.to_ascii_lowercase().contains("detached")
    {
        None
    } else {
        Some(branch.to_string())
    }
}

fn last_commit_value(content: &str) -> Option<LastCommit> {
    let commit = line_value(content, "Last commit:")?.trim();
    if commit.is_empty() {
        return None;
    }
    let split_at = commit.find(char::is_whitespace);
    match split_at {
        Some(index) => Some(LastCommit {
            hash: commit[..index].to_string(),
            msg: commit[index..].trim().to_string(),
        }),
        None => Some(LastCommit {
            hash: commit.to_string(),
            msg: String::new(),
        }),
    }
}

fn section(content: &str, name: &str) -> Vec<String> {
    let mut in_section = false;
    let mut values = Vec::new();

    for line in content.lines() {
        if let Some(heading) = line
            .strip_prefix("##")
            .filter(|heading| heading.chars().next().is_some_and(char::is_whitespace))
        {
            let heading = heading.trim_start();
            if in_section {
                break;
            }
            if heading
                .get(..name.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(name))
            {
                in_section = true;
            }
            continue;
        }
        if !in_section {
            continue;
        }
        let value = line.trim_start().strip_prefix('-').unwrap_or(line).trim();
        if !value.is_empty() {
            values.push(value.to_string());
        }
    }

    values
}

fn fallback_path(slug: &str) -> String {
    format!(
        "/{}",
        slug.split('-')
            .filter(|component| !component.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    )
}

fn parse_handoff(
    handoff_file: &Path,
    content: &str,
    modified: SystemTime,
    now: SystemTime,
) -> HandoffInfo {
    let slug = handoff_file
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let recorded_path = quoted_line_value(content, "Path:").unwrap_or_else(|| fallback_path(&slug));
    let repo = Path::new(&recorded_path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let uncommitted = line_value(content, "Uncommitted:")
        .map(|value| value.chars().take_while(char::is_ascii_digit).collect())
        .and_then(|value: String| value.parse::<u32>().ok())
        .unwrap_or(0);
    let asks = section(content, "Recent asks");
    let last_action = section(content, "Last action").join(" ");

    HandoffInfo {
        slug,
        path: recorded_path.clone(),
        repo,
        branch: branch_value(content),
        uncommitted,
        last_commit: last_commit_value(content),
        asks,
        waiting: last_action.trim().ends_with('?'),
        last_action,
        last_active: DateTime::<Utc>::from(modified).to_rfc3339(),
        stale: now
            .duration_since(modified)
            .is_ok_and(|elapsed| elapsed > STALE_AFTER),
        orphan: !Path::new(&recorded_path).exists(),
    }
}

/// Lists recoverable Claude handoffs newest-first while ignoring individual
/// snapshots that disappear or become unreadable during the scan.
#[tauri::command]
pub fn get_handoffs() -> Result<Vec<HandoffInfo>, String> {
    let root = handoffs_root()?;
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read handoffs directory {}: {error}",
                root.display()
            ));
        }
    };
    let now = SystemTime::now();
    let mut handoffs = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".md") || file_name.ends_with(".compact.md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        handoffs.push((modified, parse_handoff(&path, &content, modified, now)));
    }

    handoffs.sort_by(|(modified_a, _), (modified_b, _)| modified_b.cmp(modified_a));
    Ok(handoffs.into_iter().map(|(_, handoff)| handoff).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_a_realistic_handoff() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        let recorded_path = temp_dir.path();
        let content = format!(
            "# Handoff — maestro — 2026-08-19 11:16\n\
             \n\
             ## State\n\
             - Path: `{}`\n\
             - Branch: `?`\n\
             - Last commit: 086c655 carry the handoff pointer\n\
             - Uncommitted: 3 file(s)\n\
             \n\
             ## Recent asks (oldest→newest)\n\
             - Port the JavaScript parser.\n\
             - Keep the command best-effort.\n\
             \n\
             ## Last action\n\
             - Read the source parser.\n\
             - Should I implement it?\n",
            recorded_path.display()
        );
        let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let handoff = parse_handoff(
            &temp_dir.path().join("maestro-session.md"),
            &content,
            modified,
            modified,
        );

        assert_eq!(handoff.slug, "maestro-session");
        assert_eq!(handoff.path, recorded_path.to_string_lossy());
        assert_eq!(
            handoff.repo,
            recorded_path
                .file_name()
                .expect("temporary directory basename")
                .to_string_lossy()
        );
        assert_eq!(handoff.branch, None);
        assert_eq!(handoff.uncommitted, 3);
        let commit = handoff.last_commit.expect("last commit");
        assert_eq!(commit.hash, "086c655");
        assert_eq!(commit.msg, "carry the handoff pointer");
        assert_eq!(
            handoff.asks,
            [
                "Port the JavaScript parser.",
                "Keep the command best-effort."
            ]
        );
        assert_eq!(
            handoff.last_action,
            "Read the source parser. Should I implement it?"
        );
        assert!(handoff.waiting);
        assert_eq!(
            handoff.last_active,
            DateTime::<Utc>::from(modified).to_rfc3339()
        );
        assert!(!handoff.stale);
        assert!(!handoff.orphan);
    }

    #[test]
    fn marks_old_missing_paths_as_stale_and_orphaned() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        let missing_path = temp_dir.path().join("removed-repo");
        let content = format!("## State\n- Path: `{}`\n", missing_path.display());
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let modified = now - Duration::from_secs(15 * 24 * 60 * 60);
        let handoff = parse_handoff(
            &temp_dir.path().join("old-session.md"),
            &content,
            modified,
            now,
        );

        assert!(handoff.stale);
        assert!(handoff.orphan);
    }
}
