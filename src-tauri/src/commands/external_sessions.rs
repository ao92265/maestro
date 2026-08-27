/*!
Terminal sessions Maestro did not start.

Maestro only ever knew about the PTYs it spawned itself, so a Claude session
Alex opened in iTerm was invisible to the app that is supposed to be the one
window. This module reads those panes, and can focus or close one.

The AppleScript here is ported from Rohcna, including two details learned the
hard way: `tab` is iTerm's tab *class* inside a `tell` block, so the field
delimiter has to be a literal string, and a pane's `path` variable is
unreadable when the caller is TCC-blocked, which is why the cwd falls back to
the foreground process's own working directory.
*/

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Not a tab character: inside `tell application "iTerm"`, `tab` names iTerm's
/// tab class and AppleScript emits the literal word instead of a separator.
const FIELD: &str = "<|>";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    /// iTerm's own session id, the handle for focus and close.
    pub id: String,
    pub tty: String,
    /// Working directory, which is how a pane is matched to a repo.
    pub cwd: String,
    /// The tab title, which is usually the name the agent gave the session.
    pub title: String,
}

/// Strip what iTerm decorates a title with: the job name it appends, and the
/// spinner glyph an agent puts in front while it is working.
pub fn clean_title(raw: &str) -> String {
    let without_job = match (raw.rfind('('), raw.rfind(')')) {
        (Some(open), Some(close)) if close > open && raw[close + 1..].trim().is_empty() => {
            &raw[..open]
        }
        _ => raw,
    };
    without_job
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim()
        .to_string()
}

/// Turn the script's output into rows, dropping anything malformed rather than
/// failing the whole read: one odd pane must not hide every other session.
pub fn parse_panes(raw: &str) -> Vec<ExternalSession> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(FIELD).collect();
            if fields.len() < 4 {
                return None;
            }
            let id = fields[0].trim();
            if id.is_empty() {
                return None;
            }
            Some(ExternalSession {
                id: id.to_string(),
                tty: fields[1].trim().to_string(),
                cwd: fields[2].trim().to_string(),
                title: clean_title(fields[3]),
            })
        })
        .collect()
}

/// iTerm session ids are embedded into an AppleScript string, so anything that
/// could close the quote or start a new statement must not survive. Reject
/// rather than escape: a real id is hex, dashes and dots, and nothing else.
pub fn safe_pane_id(raw: &str) -> Option<String> {
    if raw.is_empty()
        || !raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_'))
    {
        return None;
    }
    Some(raw.to_string())
}

/// Walk up for a `.git` entry so panes group by repo rather than by whichever
/// subdirectory the shell happened to be sitting in.
pub fn git_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// Reading every pane out of iTerm in one pass. Per-pane round trips were the
/// slow part in Rohcna, so the whole tree is walked inside one script.
const LIST_SCRIPT: &str = r#"tell application "iTerm"
  set out to ""
  repeat with w in windows
    repeat with tb in tabs of w
      repeat with s in sessions of tb
        set p to ""
        try
          set p to (variable named "path") of s
        end try
        set nm to ""
        try
          set nm to (name of s)
        end try
        set out to out & (id of s) & "<|>" & (tty of s) & "<|>" & p & "<|>" & nm & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell"#;

/// Run a script and hand back its output. iTerm not running, or automation
/// permission not granted, is a normal empty answer rather than an error: the
/// section simply has nothing to show.
async fn osa(script: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|error| format!("Could not run osascript: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The cwd for a pane whose `path` variable came back empty, which happens
/// whenever the caller cannot read iTerm's session variables. Ask the
/// foreground process on that tty where it is instead.
async fn cwd_from_tty(tty: &str) -> Option<String> {
    let device = tty.strip_prefix("/dev/").unwrap_or(tty);
    if device.is_empty() || device == "?" {
        return None;
    }
    let listing = tokio::process::Command::new("/bin/ps")
        .args(["-t", device, "-o", "pid="])
        .output()
        .await
        .ok()?;
    let pids: Vec<String> = String::from_utf8_lossy(&listing.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    // Newest process first: that is the one actually sitting in the directory.
    for pid in pids.iter().rev() {
        let Ok(output) = tokio::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-d", "cwd", "-Fn", "-p", pid])
            .output()
            .await
        else {
            continue;
        };
        if let Some(line) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .find(|line| line.starts_with('n'))
        {
            return Some(line[1..].to_string());
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionRow {
    #[serde(flatten)]
    pub session: ExternalSession,
    /// Repo the pane sits in, or null when it is not in one.
    pub repo: Option<String>,
    /// Just the repo's folder name, which is what the list groups under.
    pub repo_name: Option<String>,
}

#[tauri::command]
pub async fn list_external_sessions() -> Result<Vec<ExternalSessionRow>, String> {
    let raw = match osa(LIST_SCRIPT).await {
        Ok(raw) => raw,
        // iTerm closed, or no automation permission. Nothing to show, and
        // nothing worth shouting about.
        Err(_) => return Ok(Vec::new()),
    };

    let mut rows = Vec::new();
    for mut session in parse_panes(&raw) {
        if session.cwd.is_empty() {
            if let Some(found) = cwd_from_tty(&session.tty).await {
                session.cwd = found;
            }
        }
        let repo = if session.cwd.is_empty() {
            None
        } else {
            git_root(Path::new(&session.cwd))
        };
        let repo_name = repo
            .as_ref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().to_string());
        rows.push(ExternalSessionRow {
            session,
            repo: repo.map(|path| path.display().to_string()),
            repo_name,
        });
    }
    Ok(rows)
}

/// Build a script that acts on exactly one pane and reports whether it found
/// it, so a stale id reads as "that terminal is gone" instead of silence.
fn one_pane(id: &str, body: &str) -> String {
    format!(
        r#"set matched to 0
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (id of s) is "{id}" then
          set matched to 1
          {body}
        end if
      end repeat
    end repeat
  end repeat
end tell
return matched"#
    )
}

async fn act_on_pane(id: &str, body: &str) -> Result<(), String> {
    let safe = safe_pane_id(id).ok_or_else(|| "That is not a terminal id.".to_string())?;
    let out = osa(&one_pane(&safe, body)).await?;
    if out.trim() == "1" {
        Ok(())
    } else {
        Err("That terminal has gone.".to_string())
    }
}

#[tauri::command]
pub async fn focus_external_session(id: String) -> Result<(), String> {
    act_on_pane(
        &id,
        "activate\n          select w\n          select t\n          tell s to select",
    )
    .await
}

#[tauri::command]
pub async fn close_external_session(id: String) -> Result<(), String> {
    act_on_pane(&id, "close s").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_pane_row() {
        let rows = parse_panes("w0t0p0<|>/dev/ttys004<|>/Users/a/Repos/maestro<|>maestro\n");
        assert_eq!(
            rows,
            vec![ExternalSession {
                id: "w0t0p0".into(),
                tty: "/dev/ttys004".into(),
                cwd: "/Users/a/Repos/maestro".into(),
                title: "maestro".into(),
            }]
        );
    }

    /* One unreadable pane must not cost him the whole list, which is what a
       parse that fails on the first bad row would do. */
    #[test]
    fn a_malformed_row_is_dropped_and_the_rest_survive() {
        let raw = "broken-row\n\nw0t0p1<|>/dev/ttys005<|>/Users/a/Repos/act<|>act\n";
        let rows = parse_panes(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "w0t0p1");
    }

    #[test]
    fn a_pane_with_no_readable_cwd_still_lists() {
        let rows = parse_panes("w0t0p2<|><|><|>\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cwd, "");
    }

    #[test]
    fn the_job_name_iterm_appends_is_not_part_of_the_title() {
        assert_eq!(clean_title("stabilise-jersey-pr-batch (node)"), "stabilise-jersey-pr-batch");
    }

    #[test]
    fn a_working_spinner_is_not_part_of_the_title() {
        assert_eq!(clean_title("✳ building the thing"), "building the thing");
    }

    /* Brackets in the middle are the session's own name, not iTerm's suffix. */
    #[test]
    fn brackets_that_are_not_a_trailing_job_name_are_kept() {
        assert_eq!(clean_title("fix (finally) the parser"), "fix (finally) the parser");
    }

    #[test]
    fn a_pane_groups_under_its_repo_not_its_subdirectory() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("myrepo");
        let deep = repo.join("src/components");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        assert_eq!(git_root(&deep), Some(repo));
    }

    #[test]
    fn the_single_pane_script_names_only_that_pane() {
        let script = one_pane("w0t0p0", "close s");
        assert!(script.contains("if (id of s) is \"w0t0p0\""));
        assert!(script.contains("close s"));
        assert!(script.trim_end().ends_with("return matched"));
    }

    #[test]
    fn a_real_iterm_session_id_passes() {
        assert_eq!(
            safe_pane_id("w0t1p0:6F0A2B3C-1D4E-4F5A-9B8C-7D6E5F4A3B2C"),
            Some("w0t1p0:6F0A2B3C-1D4E-4F5A-9B8C-7D6E5F4A3B2C".to_string())
        );
    }

    /* The id goes straight into an AppleScript string literal. A quote would
       close it and everything after would run, so ids like these are refused
       outright rather than escaped. */
    #[test]
    fn an_id_that_could_break_out_of_the_script_is_refused() {
        assert_eq!(safe_pane_id("w0t0p0\" \n do shell script \"rm -rf ~\""), None);
        assert_eq!(safe_pane_id("w0\\p0"), None);
        assert_eq!(safe_pane_id("w0 p0"), None);
        assert_eq!(safe_pane_id(""), None);
    }

    #[test]
    fn a_directory_outside_any_repo_has_no_root() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(git_root(temp.path()), None);
    }
}
