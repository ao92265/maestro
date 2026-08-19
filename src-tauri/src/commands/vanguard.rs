//! Vanguard feed: persists the Home view's assembled bands to a small state
//! file under `~/.maestro/` so an out-of-process digest script (launchd) can
//! message Alex without the app running. The frontend mirrors its band state
//! here on every change (debounced); the script judges freshness by the
//! snapshot's own `writtenAt`, so a closed app degrades to a stale-marked
//! digest instead of silence.

use directories::BaseDirs;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn snapshot_path() -> Result<PathBuf, String> {
    let base_dirs = BaseDirs::new().ok_or("Could not resolve home directory")?;
    Ok(base_dirs
        .home_dir()
        .join(".maestro")
        .join("band-snapshot.json"))
}

/// Temp file + rename, never a write in place: the digest script polls this
/// file on its own schedule, and an in-place write caught mid-flight would
/// hand it truncated JSON. Same discipline as every other managed-file writer
/// in this codebase (see `write_memory_file`).
async fn write_atomically(path: &Path, snapshot: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    let content = serde_json::to_string(snapshot)
        .map_err(|e| format!("Failed to serialize band snapshot: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("Failed to write band snapshot: {e}"))?;
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Failed to write band snapshot: {e}"));
    }
    Ok(())
}

/// Writes the band snapshot to `~/.maestro/band-snapshot.json`.
///
/// The snapshot arrives as opaque JSON on purpose: its shape belongs to the
/// frontend (`useVanguardSnapshot`) and the digest script, and typing it here
/// would force a Rust rebuild for every field the feed adds.
#[tauri::command]
pub async fn write_band_snapshot(snapshot: Value) -> Result<(), String> {
    let path = snapshot_path()?;
    write_atomically(&path, &snapshot).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_snapshot_and_creates_parent_dir() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        let path = temp_dir.path().join("nested").join("band-snapshot.json");
        let snapshot = serde_json::json!({ "writtenAt": 123, "blocked": [] });

        write_atomically(&path, &snapshot).await.expect("write");

        let content = std::fs::read_to_string(&path).expect("read back");
        let parsed: Value = serde_json::from_str(&content).expect("valid JSON");
        assert_eq!(parsed["writtenAt"], 123);
        // No temp file left behind on the happy path.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[tokio::test]
    async fn overwrite_replaces_previous_snapshot() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        let path = temp_dir.path().join("band-snapshot.json");

        write_atomically(&path, &serde_json::json!({ "writtenAt": 1 }))
            .await
            .expect("first write");
        write_atomically(&path, &serde_json::json!({ "writtenAt": 2 }))
            .await
            .expect("second write");

        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read back"))
                .expect("valid JSON");
        assert_eq!(parsed["writtenAt"], 2);
    }

    #[tokio::test]
    async fn unwritable_parent_reports_error_not_panic() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        // Occupy the parent path with a FILE so create_dir_all must fail.
        let blocker = temp_dir.path().join("occupied");
        std::fs::write(&blocker, "not a directory").expect("blocker file");
        let path = blocker.join("band-snapshot.json");

        let err = write_atomically(&path, &serde_json::json!({}))
            .await
            .expect_err("must fail");
        assert!(err.contains("Failed to"), "unexpected error: {err}");
    }
}
