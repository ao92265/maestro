//! IPC commands for Claude Code's auto-memory: the per-project fact files
//! Claude saves under `~/.claude/projects/<encoded-path>/memory/`
//! (`MEMORY.md` index plus one markdown file per remembered fact).
//!
//! Commands take an encoded project directory name plus a path relative to
//! that project's memory dir — never an absolute path — so strict component
//! validation is the safeguard against the frontend touching arbitrary files.

use chrono::{DateTime, Utc};
use directories::BaseDirs;
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::claude_sessions::encode_project_path;

/// Maximum directory depth scanned inside a memory dir. Memory files are flat
/// or one folder deep in practice; the bound keeps a corrupted/symlinked tree
/// from turning a listing into a filesystem crawl.
const MAX_SCAN_DEPTH: usize = 4;

/// One project that has an auto-memory directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProject {
    /// Encoded directory name under `~/.claude/projects` (e.g. "C--git-maestro").
    pub dir_name: String,
    /// Absolute path to the memory directory (display only).
    pub memory_path: String,
    /// Number of markdown files in the memory directory.
    pub file_count: usize,
    /// True when this is the memory of the project passed by the caller.
    pub is_active: bool,
}

/// One markdown file inside a project's memory directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// Path relative to the memory dir, forward-slash separated.
    pub rel_path: String,
    /// Absolute path (display only — commands take dir_name + rel_path).
    pub path: String,
    /// `description:` from the file's YAML frontmatter, if present.
    pub description: Option<String>,
    /// `type:` from the frontmatter metadata (user/feedback/project/reference).
    pub mem_type: Option<String>,
    /// True for the MEMORY.md index that Claude loads every session.
    pub is_index: bool,
    pub size_bytes: u64,
    /// Last modified time, RFC 3339.
    pub modified: Option<String>,
}

fn projects_root() -> Result<PathBuf, String> {
    let base_dirs = BaseDirs::new().ok_or("Could not resolve home directory")?;
    Ok(base_dirs.home_dir().join(".claude").join("projects"))
}

/// Encoded project dir names only ever contain ASCII alphanumerics and `-` —
/// `_` in a path encodes to `-` like every other special character (issue
/// #86, see [`encode_project_path`]). The validator still accepts `_` on
/// purpose: it guards against traversal, not against encoding drift, and a
/// literal-underscore directory name is harmless to read.
fn validate_dir_name(dir_name: &str) -> Result<(), String> {
    if dir_name.is_empty() {
        return Err("Project directory name is empty".into());
    }
    if !dir_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("Invalid project directory name: {dir_name}"));
    }
    Ok(())
}

/// Validates a path relative to a memory dir: forward-slash separated, no
/// empty/dot components, no backslashes or drive colons, must be markdown.
fn validate_rel_path(rel_path: &str) -> Result<(), String> {
    if rel_path.is_empty() {
        return Err("Memory file path is empty".into());
    }
    if rel_path.contains('\\') || rel_path.contains(':') {
        return Err(format!("Invalid memory file path: {rel_path}"));
    }
    for component in rel_path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(format!("Invalid memory file path: {rel_path}"));
        }
    }
    if !rel_path.ends_with(".md") {
        return Err("Only markdown (.md) memory files can be accessed".into());
    }
    Ok(())
}

/// Resolves and validates `<projects root>/<dir_name>/memory/<rel_path>`.
fn memory_file_path(dir_name: &str, rel_path: &str) -> Result<PathBuf, String> {
    validate_dir_name(dir_name)?;
    validate_rel_path(rel_path)?;
    let mut path = projects_root()?.join(dir_name).join("memory");
    for component in rel_path.split('/') {
        path.push(component);
    }
    Ok(path)
}

/// Extracts `description:` and `type:` values from a memory file's YAML
/// frontmatter. Deliberately line-based rather than a full YAML parse — the
/// files are machine-written with a fixed shape, and a malformed one should
/// degrade to "no description", not an error.
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }

    let mut description = None;
    let mut mem_type = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("description:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                description = Some(value.to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("type:") {
            let value = value.trim();
            if !value.is_empty() {
                mem_type = Some(value.to_string());
            }
        }
    }
    (description, mem_type)
}

/// Recursively collects `.md` files under `dir`. Missing/unreadable
/// subdirectories are skipped, not fatal. Paths are absolute; callers that
/// want them repo-relative pass each one through [`rel_path_string`].
fn collect_md_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_md_files(&path, depth + 1, out);
        } else if file_type.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
}

fn rel_path_string(path: &Path, base: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// Lists every project under `~/.claude/projects` that has a non-empty
/// `memory/` directory. `active_project_path` (the project open in Maestro;
/// may be empty) marks the matching entry so the UI can pin it first.
#[tauri::command]
pub async fn list_memory_projects(
    active_project_path: String,
) -> Result<Vec<MemoryProject>, String> {
    let root = projects_root()?;
    let active_dir_name = if active_project_path.is_empty() {
        None
    } else {
        Some(encode_project_path(&active_project_path))
    };

    let mut projects: Vec<MemoryProject> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        // No ~/.claude/projects at all — nothing remembered yet.
        return Ok(projects);
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(dir_name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        let memory_dir = entry.path().join("memory");
        if !memory_dir.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_md_files(&memory_dir, 0, &mut files);
        if files.is_empty() {
            continue;
        }
        projects.push(MemoryProject {
            is_active: active_dir_name.as_deref() == Some(dir_name.as_str()),
            dir_name,
            memory_path: memory_dir.to_string_lossy().into_owned(),
            file_count: files.len(),
        });
    }

    // Active project first, then alphabetical for a stable list.
    projects.sort_by(|a, b| {
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| a.dir_name.cmp(&b.dir_name))
    });
    Ok(projects)
}

/// Lists the markdown files in one project's memory directory, with the
/// MEMORY.md index first.
#[tauri::command]
pub async fn list_memory_files(dir_name: String) -> Result<Vec<MemoryFile>, String> {
    validate_dir_name(&dir_name)?;
    let memory_dir = projects_root()?.join(&dir_name).join("memory");
    if !memory_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    collect_md_files(&memory_dir, 0, &mut paths);

    let mut files: Vec<MemoryFile> = Vec::new();
    for path in paths {
        let Some(rel_path) = rel_path_string(&path, &memory_dir) else {
            continue;
        };
        let metadata = std::fs::metadata(&path).ok();
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339());
        // Frontmatter lives in the first ~10 lines; reading the whole file is
        // fine at memory-file sizes (a few KB each).
        let (description, mem_type) = std::fs::read_to_string(&path)
            .map(|c| parse_frontmatter(&c))
            .unwrap_or((None, None));
        files.push(MemoryFile {
            is_index: rel_path == "MEMORY.md",
            path: path.to_string_lossy().into_owned(),
            size_bytes: metadata.map(|m| m.len()).unwrap_or(0),
            modified,
            description,
            mem_type,
            rel_path,
        });
    }

    files.sort_by(|a, b| {
        b.is_index
            .cmp(&a.is_index)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(files)
}

/// Reads one memory file. Returns "" if it doesn't exist.
#[tauri::command]
pub async fn read_memory_file(dir_name: String, rel_path: String) -> Result<String, String> {
    let path = memory_file_path(&dir_name, &rel_path)?;
    if !path.exists() {
        return Ok(String::new());
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read {rel_path}: {e}"))
}

/// Writes one memory file, creating parent directories as needed.
///
/// Note: Claude Code itself writes these files while a session is running in
/// that project — a concurrent save on Claude's side can overwrite an edit
/// made here. The UI surfaces that caveat instead of trying to lock a
/// directory another process doesn't lock.
#[tauri::command]
pub async fn write_memory_file(
    dir_name: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let path = memory_file_path(&dir_name, &rel_path)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    // Temp file + rename, never a write in place: MEMORY.md is loaded into
    // every later session's context, and a crash, a full disk or a
    // concurrent read during an in-place write leaves it truncated. Every
    // other managed-file writer in this codebase already works this way.
    let tmp = path.with_extension("md.tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("Failed to write {rel_path}: {e}"))?;
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Failed to write {rel_path}: {e}"));
    }
    Ok(())
}

/// Deletes one memory file. The MEMORY.md index is not rewritten — stale
/// index lines are harmless (Claude treats them as pointers, not truth) and
/// the user can edit the index in the same UI.
#[tauri::command]
pub async fn delete_memory_file(dir_name: String, rel_path: String) -> Result<(), String> {
    let path = memory_file_path(&dir_name, &rel_path)?;
    tokio::fs::remove_file(&path)
        .await
        .map_err(|e| format!("Failed to delete {rel_path}: {e}"))
}

/// Deletes a project's entire memory directory (every remembered fact plus
/// the MEMORY.md index). Only the `memory/` subdirectory is removed — session
/// transcripts and other data under the project dir are untouched.
#[tauri::command]
pub async fn delete_memory_project(dir_name: String) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    let memory_dir = projects_root()?.join(&dir_name).join("memory");
    if !memory_dir.is_dir() {
        // Already gone — treat as success so the UI can just drop the row.
        return Ok(());
    }
    tokio::fs::remove_dir_all(&memory_dir)
        .await
        .map_err(|e| format!("Failed to delete memory of {dir_name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_name_accepts_encoded_paths_only() {
        assert!(validate_dir_name("C--git-maestro").is_ok());
        assert!(validate_dir_name("-Users-alice--config").is_ok());
        assert!(validate_dir_name("").is_err());
        assert!(validate_dir_name("..").is_err());
        assert!(validate_dir_name("a/b").is_err());
        assert!(validate_dir_name("a\\b").is_err());
        assert!(validate_dir_name("C:").is_err());
    }

    #[test]
    fn rel_path_rejects_traversal_and_non_markdown() {
        assert!(validate_rel_path("MEMORY.md").is_ok());
        assert!(validate_rel_path("facts/user_profile.md").is_ok());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../secrets.md").is_err());
        assert!(validate_rel_path("a/../b.md").is_err());
        assert!(validate_rel_path("a//b.md").is_err());
        assert!(validate_rel_path("a\\b.md").is_err());
        assert!(validate_rel_path("C:/x.md").is_err());
        assert!(validate_rel_path("notes.txt").is_err());
        assert!(validate_rel_path(".md").is_ok()); // odd but harmless: stays in the dir
    }

    #[test]
    fn frontmatter_extracts_description_and_type() {
        let content = "---\nname: project-fork-state\ndescription: \"Cloud sessions land on main\"\nmetadata: \n  node_type: memory\n  type: project\n---\n\nBody text.";
        let (description, mem_type) = parse_frontmatter(content);
        assert_eq!(description.as_deref(), Some("Cloud sessions land on main"));
        assert_eq!(mem_type.as_deref(), Some("project"));
    }

    #[test]
    fn frontmatter_missing_or_malformed_degrades_to_none() {
        assert_eq!(parse_frontmatter("# Just markdown"), (None, None));
        assert_eq!(parse_frontmatter(""), (None, None));
        // Unterminated frontmatter: still scans without panicking.
        let (description, _) = parse_frontmatter("---\ndescription: x");
        assert_eq!(description.as_deref(), Some("x"));
    }

    #[test]
    fn memory_file_path_stays_inside_memory_dir() {
        let path = memory_file_path("C--git-maestro", "facts/one.md").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with(".claude/projects/C--git-maestro/memory/facts/one.md"));
        assert!(memory_file_path("..", "MEMORY.md").is_err());
        assert!(memory_file_path("C--git-maestro", "../../evil.md").is_err());
    }
}
