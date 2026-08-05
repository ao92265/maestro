//! Filesystem probe backing the memory health rules.
//!
//! The rule "this memory file references repo paths that no longer exist"
//! needs one thing the frontend cannot answer: whether a repo-relative path
//! is still on disk. Everything else the health checker needs it already has.
//!
//! Read-only by construction — the command can only report existence, never
//! create, move or delete anything.

use std::path::{Path, PathBuf};

/// Upper bound on paths checked per call. The frontend already caps
/// references per memory file; this is the backstop against a single call
/// turning into an unbounded stat storm.
const MAX_PATHS_PER_CALL: usize = 500;

/// True when `rel` is safe to join onto a repo root: relative, forward-slash
/// separated, no traversal, no drive letter.
///
/// A rejected path is treated as "not checkable" rather than "missing" — the
/// health rules must never flag something they could not actually verify.
fn is_checkable_rel_path(rel: &str) -> bool {
    if rel.is_empty() || rel.len() > 260 {
        return false;
    }
    if rel.contains('\\') || rel.contains(':') {
        return false;
    }
    if rel.starts_with('/') || rel.starts_with('~') {
        return false;
    }
    rel.split('/')
        .all(|component| !component.is_empty() && component != "." && component != "..")
}

/// Joins a validated relative path onto `root`.
fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for component in rel.split('/') {
        path.push(component);
    }
    path
}

/// Returns the subset of `rel_paths` that do NOT exist under `root`.
///
/// Returns an empty list (i.e. "nothing is missing") whenever the answer is
/// unknowable — no root, or a root that isn't a directory — because a missing
/// checkout must not make every memory file look broken.
#[tauri::command]
pub async fn check_paths_exist(
    root: String,
    rel_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if root.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Ok(Vec::new());
    }

    let mut missing = Vec::new();
    for rel in rel_paths.into_iter().take(MAX_PATHS_PER_CALL) {
        if !is_checkable_rel_path(&rel) {
            continue;
        }
        if !join_rel(&root_path, &rel).exists() {
            missing.push(rel);
        }
    }
    Ok(missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_rejects_absolute_traversal_and_windows_forms() {
        assert!(is_checkable_rel_path("src/lib/memory.ts"));
        assert!(is_checkable_rel_path("a.md"));
        assert!(!is_checkable_rel_path(""));
        assert!(!is_checkable_rel_path("/etc/passwd"));
        assert!(!is_checkable_rel_path("~/.ssh/id_rsa"));
        assert!(!is_checkable_rel_path("../outside.ts"));
        assert!(!is_checkable_rel_path("src/../../etc/passwd"));
        assert!(!is_checkable_rel_path("src\\lib\\a.ts"));
        assert!(!is_checkable_rel_path("C:/git/x.ts"));
        assert!(!is_checkable_rel_path("src//a.ts"));
    }

    #[tokio::test]
    async fn reports_only_paths_that_are_absent() {
        let dir = std::env::temp_dir().join(format!("maestro-health-{}", std::process::id()));
        let nested = dir.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("present.ts"), "x").unwrap();

        let missing = check_paths_exist(
            dir.to_string_lossy().into_owned(),
            vec![
                "src/present.ts".into(),
                "src/gone.ts".into(),
                // Unsafe forms are skipped, never reported as missing.
                "../escape.ts".into(),
            ],
        )
        .await
        .unwrap();

        assert_eq!(missing, vec!["src/gone.ts".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn unknown_root_reports_nothing_missing() {
        let missing = check_paths_exist(String::new(), vec!["a.ts".into()])
            .await
            .unwrap();
        assert!(missing.is_empty());

        let missing = check_paths_exist(
            std::env::temp_dir()
                .join("maestro-health-does-not-exist")
                .to_string_lossy()
                .into_owned(),
            vec!["a.ts".into()],
        )
        .await
        .unwrap();
        assert!(missing.is_empty());
    }
}
