//! Pulse: the raw material behind today's timeline, flow score and metrics.
//!
//! A port of the collection half of rohcna's `/metrics`, `/flow` and
//! `/activity` endpoints (`server.js` `gitToday`, `scanTranscriptStats`,
//! `gitCommitsOnDate`, and `computeActivity`'s commit loop). The scoring half
//! lives in `src/lib/pulse.ts`, where it can be unit-tested against known
//! inputs; this module only reads git and the Claude transcripts and hands
//! over counts.
//!
//! Two collection choices differ from rohcna, both deliberate:
//! - Repos are the ones the caller passes (Maestro's open projects), not
//!   every directory under `~/Repos` — the fork already knows what you work on.
//! - Recent commit counts come from one `git log` per repo over the whole
//!   window, where rohcna re-ran a log per repo *per missing day*. Same
//!   numbers; rohcna's own comment called that scan the slowest thing it did.
//!
//! Failure is never fatal: a repo whose git call fails reports zeroes, and a
//! missing transcript directory returns an empty scan. The Pulse view treats
//! an unavailable source as a stale badge, not an error wall.

use crate::git::Git;
use chrono::{Datelike, Duration, Local, TimeZone, Timelike};
use directories::BaseDirs;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Transcripts read per scan. Rohcna capped its stats scan here and its
/// activity scan at 100; one walk feeds both, so the timeline sees the same
/// 200 the counters do.
const MAX_TRANSCRIPTS: usize = 200;

/// Tool names that count as an edit, lowercased.
const EDIT_TOOLS: [&str; 3] = ["edit", "write", "multiedit"];

/// Words in a bash command that make it a test run.
const TEST_COMMAND_WORDS: [&str; 8] = [
    "test", "pytest", "jest", "vitest", "go test", "npm t", "mocha", "rspec",
];

/// Openings that mark an `[AUTOPILOT]` line as an injected task prompt rather
/// than an action report. The trailing `\b` cases are matched as whole words.
const PROMPT_OPENINGS: [&str; 15] = [
    "you are",
    "your role",
    "your job",
    "your task",
    "your mission",
    "read",
    "write",
    "verify",
    "implement",
    "port",
    "build",
    "analyze",
    "create",
    "fix",
    "refactor",
];

/// Longest an `[AUTOPILOT]` line can be and still read as an action report.
const AUTOPILOT_MAX_CHARS: usize = 140;

/// One commit made today.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PulseCommit {
    pub hash: String,
    /// Local 24-hour `HH:MM`, straight from git.
    pub time: String,
    /// Branch the commit is decorated with; empty when it carries no ref.
    pub branch: String,
}

/// Today's git position for one repo, plus its recent commit counts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PulseRepoActivity {
    pub repo: String,
    pub path: String,
    pub commits: Vec<PulseCommit>,
    pub added: u32,
    pub removed: u32,
    pub files: Vec<String>,
    /// Lines of `git status --porcelain`; 0 is a clean tree.
    pub dirty: u32,
    /// `YYYY-MM-DD` → commits landed that day, over the requested window.
    pub commits_by_date: BTreeMap<String, u32>,
}

/// A timeline-worthy line found in a transcript.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PulseTranscriptEvent {
    /// Epoch milliseconds.
    pub ts: i64,
    /// `stopHook` or `autopilot` — the frontend picks the icon.
    pub kind: String,
    pub text: String,
}

/// What today's Claude transcripts say happened.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PulseTranscriptStats {
    pub edits: u32,
    pub tool_calls: u32,
    pub test_runs: u32,
    pub tests_pass: u32,
    pub tests_fail: u32,
    /// Hour of day → tool calls logged in it.
    pub hourly: BTreeMap<u32, u32>,
    pub repos: Vec<String>,
    pub switches: u32,
    pub events: Vec<PulseTranscriptEvent>,
}

/* ---- small string helpers (no regex crate in this workspace) ------------- */

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    find_ignore_case(haystack, needle).is_some()
}

fn find_ignore_case(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_lowercase().find(&needle.to_lowercase())
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\bword\b` against an already-lowercased haystack.
fn contains_word(haystack_lower: &str, word: &str) -> bool {
    let mut from = 0;
    while let Some(offset) = haystack_lower[from..].find(word) {
        let start = from + offset;
        let end = start + word.len();
        let before_ok = haystack_lower[..start].chars().next_back().is_none_or(|c| !is_word_char(c));
        let after_ok = haystack_lower[end..].chars().next().is_none_or(|c| !is_word_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// The integer written immediately before `word`, e.g. `26` in `26 passed`.
fn number_before_word(line: &str, word: &str) -> Option<u32> {
    let at = find_ignore_case(line, word)?;
    let head = &line[..at];
    let digits: String = head
        .chars()
        .rev()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.chars().rev().collect::<String>().parse().ok()
}

/// The integer at the start of `text`, after any leading whitespace.
fn leading_number(text: &str) -> Option<u32> {
    let digits: String = text
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/* ---- test output parsing ------------------------------------------------- */

/// Pass/fail counts out of a test runner's stdout: TAP/`node --test`, jest,
/// vitest, pytest and mocha. `None` when the text carries no test signal.
///
/// Hand-rolled rather than a regex port — this crate has no regex dependency,
/// and five fixed shapes do not justify adding one.
fn parse_test_result(text: &str) -> Option<(u32, u32)> {
    // TAP / node --test: "# pass 28" and "# fail 0" on their own lines.
    let mut tap_pass = None;
    let mut tap_fail = None;
    for line in text.lines() {
        let Some(rest) = line.strip_prefix('#') else {
            continue;
        };
        let rest = rest.trim_start();
        if let Some(count) = rest.strip_prefix("pass") {
            tap_pass = tap_pass.or_else(|| leading_number(count));
        } else if let Some(count) = rest.strip_prefix("fail") {
            tap_fail = tap_fail.or_else(|| leading_number(count));
        }
    }
    if tap_pass.is_some() || tap_fail.is_some() {
        return Some((tap_pass.unwrap_or(0), tap_fail.unwrap_or(0)));
    }

    // jest ("Tests: 1 failed, 27 passed, 28 total") and vitest
    // ("Tests  2 failed | 26 passed (28)") both summarise on a "Tests" line.
    for line in text.lines().filter(|l| contains_ignore_case(l, "tests")) {
        if let Some(pass) = number_before_word(line, "passed") {
            return Some((pass, number_before_word(line, "failed").unwrap_or(0)));
        }
    }

    // pytest: "2 failed, 26 passed in 0.5s". The trailing "in <time>" is
    // required so prose like "28 passed checks" cannot match.
    for line in text.lines().filter(|l| contains_ignore_case(l, "passed in ")) {
        if let Some(pass) = number_before_word(line, "passed") {
            return Some((pass, number_before_word(line, "failed").unwrap_or(0)));
        }
    }

    // mocha: "28 passing" with an optional "2 failing".
    for line in text.lines().filter(|l| contains_ignore_case(l, "passing")) {
        if let Some(pass) = number_before_word(line, "passing") {
            return Some((pass, number_before_word(text, "failing").unwrap_or(0)));
        }
    }

    None
}

/// Whether a bash command reads as a test run.
fn is_test_command(command: &str) -> bool {
    let lower = command.to_lowercase();
    TEST_COMMAND_WORDS
        .iter()
        .any(|word| contains_word(&lower, word))
}

/* ---- transcript scanning ------------------------------------------------- */

fn claude_projects_root() -> Option<PathBuf> {
    Some(BaseDirs::new()?.home_dir().join(".claude").join("projects"))
}

/// Last path segment, the way rohcna keyed a repo.
fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Transcripts modified since `start_ms`, newest first, capped.
///
/// Rohcna took whatever 200 the directory listing handed back; newest-first is
/// deterministic and keeps the freshest work when a day overflows the cap.
fn recent_transcripts(root: &Path, start_ms: i64) -> Vec<PathBuf> {
    let mut found: Vec<(i64, PathBuf)> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "jsonl") {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if modified >= start_ms {
                found.push((modified, path));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.truncate(MAX_TRANSCRIPTS);
    found.into_iter().map(|(_, path)| path).collect()
}

/// Every `tool_use` block on a transcript entry.
fn tool_uses(event: &Value) -> Vec<&Value> {
    let mut blocks: Vec<&Value> = Vec::new();
    if let Some(content) = event.pointer("/message/content").and_then(Value::as_array) {
        blocks.extend(content.iter().filter(|b| b["type"] == "tool_use"));
    }
    if event["type"] == "tool_use" {
        blocks.push(event);
    }
    blocks
}

/// Every `tool_result` block on a transcript entry.
fn tool_results(event: &Value) -> Vec<&Value> {
    event
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter(|b| b["type"] == "tool_result")
                .collect()
        })
        .unwrap_or_default()
}

/// A tool result's text, whether it arrived as a string or as content blocks.
fn tool_result_text(block: &Value) -> String {
    match &block["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                other => other["text"].as_str().unwrap_or_default().to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Epoch ms of a transcript entry, from whichever stamp it carries.
fn event_timestamp(event: &Value) -> Option<i64> {
    let raw = event["timestamp"]
        .as_str()
        .or_else(|| event["ts"].as_str())?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Collapses runs of whitespace, the way rohcna cleaned a transcript line.
fn squash_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether an `[AUTOPILOT]` line reads as an action report worth showing.
///
/// Real ones are short ("re-ran typecheck", "formatted, committed"); the long
/// imperative ones are task prompts that happened to be logged.
fn autopilot_report(text: &str) -> Option<String> {
    let clean = squash_whitespace(text);
    if clean.chars().count() > AUTOPILOT_MAX_CHARS {
        return None;
    }
    let lower = clean.to_lowercase();
    for opening in PROMPT_OPENINGS {
        if let Some(rest) = lower.strip_prefix(opening) {
            if opening.contains(' ') || rest.chars().next().is_none_or(|c| !is_word_char(c)) {
                return None;
            }
        }
    }
    Some(clean.chars().take(120).collect())
}

/// Folds one transcript entry into the running counters.
fn fold_event(
    event: &Value,
    start_ms: i64,
    stats: &mut PulseTranscriptStats,
    repos: &mut HashSet<String>,
    visits: &mut Vec<(i64, String)>,
    test_ids: &mut HashSet<String>,
) {
    let timestamp = event_timestamp(event);
    // An entry stamped before today is not today's work. One with no stamp at
    // all still counts towards the totals (rohcna's `ts && ts < start` test),
    // but cannot be placed on the timeline below.
    if timestamp.is_some_and(|ts| ts < start_ms) {
        return;
    }

    let blocks = tool_uses(event);
    for block in &blocks {
        stats.tool_calls += 1;
        let name = block["name"].as_str().unwrap_or_default().to_lowercase();
        if EDIT_TOOLS.contains(&name.as_str()) {
            stats.edits += 1;
        }
        if name == "bash" && is_test_command(block.pointer("/input/command").and_then(Value::as_str).unwrap_or_default())
        {
            stats.test_runs += 1;
            if let Some(id) = block["id"].as_str() {
                test_ids.insert(id.to_string());
            }
        }
    }

    // Each test run is matched to its own output, so the counts are the
    // runner's own rather than a guess from the command line.
    for result in tool_results(event) {
        let Some(id) = result["tool_use_id"].as_str() else {
            continue;
        };
        if !test_ids.contains(id) {
            continue;
        }
        if let Some((pass, fail)) = parse_test_result(&tool_result_text(result)) {
            stats.tests_pass += pass;
            stats.tests_fail += fail;
        }
    }

    if let Some(cwd) = event["cwd"].as_str() {
        let repo = basename(cwd);
        repos.insert(repo.clone());
        /* Recorded rather than compared against the previous entry: a switch
           is a move in TIME, and the entries arrive grouped by file. Ordering
           happens once, across every file, in `count_switches`. */
        if let Some(ts) = timestamp {
            visits.push((ts, repo));
        }
    }

    let Some(ts) = timestamp else { return };
    let hour = Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|t| t.hour())
        .unwrap_or(0);
    *stats.hourly.entry(hour).or_insert(0) += blocks.len() as u32;

    // Hook and autopilot lines arrive as plain-string assistant content.
    let Some(text) = event.pointer("/message/content").and_then(Value::as_str) else {
        return;
    };
    if contains_ignore_case(text, "stop hook") {
        stats.events.push(PulseTranscriptEvent {
            ts,
            kind: "stopHook".to_string(),
            text: "Stop hook passed".to_string(),
        });
    } else if contains_ignore_case(text, "[autopilot]") {
        if let Some(report) = autopilot_report(text) {
            stats.events.push(PulseTranscriptEvent {
                ts,
                kind: "autopilot".to_string(),
                text: report,
            });
        }
    }
}

/// Context switches: how often the working repo changed, in time order.
///
/// The naive reading — compare each entry to the previous one as the files are
/// walked — counts a switch at nearly every file boundary, because one file is
/// one session in one directory and the walk interleaves projects. That floors
/// the focus factor and fires a "fragmenting focus" warning off a number that
/// measures the directory listing. Ordering the visits by timestamp first is
/// what makes the count mean anything.
fn count_switches(visits: &mut [(i64, String)]) -> u32 {
    visits.sort_by(|a, b| a.0.cmp(&b.0));
    visits
        .windows(2)
        .filter(|pair| pair[0].1 != pair[1].1)
        .count() as u32
}

/// Walks `root` for today's transcripts and folds them into one set of counts.
fn scan_transcripts(root: &Path, start_ms: i64) -> PulseTranscriptStats {
    let mut stats = PulseTranscriptStats::default();
    let mut repos: HashSet<String> = HashSet::new();
    let mut visits: Vec<(i64, String)> = Vec::new();
    let mut test_ids: HashSet<String> = HashSet::new();

    for file in recent_transcripts(root, start_ms) {
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        for line in content.lines() {
            if line.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            fold_event(
                &event,
                start_ms,
                &mut stats,
                &mut repos,
                &mut visits,
                &mut test_ids,
            );
        }
    }

    stats.switches = count_switches(&mut visits);
    stats.repos = {
        let mut names: Vec<String> = repos.into_iter().collect();
        names.sort();
        names
    };
    stats
}

/// Local midnight, in epoch milliseconds.
fn local_midnight_ms() -> i64 {
    let now = Local::now();
    Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

/// Today's Claude transcript counters, plus the hook lines worth a timeline
/// row. A missing `~/.claude/projects` is an empty day, not an error.
#[tauri::command]
pub async fn pulse_transcript_stats() -> Result<PulseTranscriptStats, String> {
    let start_ms = local_midnight_ms();
    let Some(root) = claude_projects_root() else {
        return Ok(PulseTranscriptStats::default());
    };
    // Blocking file walk, off the async runtime's shared threads.
    tokio::task::spawn_blocking(move || scan_transcripts(&root, start_ms))
        .await
        .map_err(|e| format!("Transcript scan failed: {e}"))
}

/* ---- git collection ------------------------------------------------------ */

/// `<hash> <HH:MM><refs>` from `git log --pretty=%H %cd %D`.
fn parse_commit_line(line: &str) -> Option<PulseCommit> {
    let (hash, rest) = line.split_once(' ')?;
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let (time, refs) = rest.split_once(' ').unwrap_or((rest, ""));
    let (hour, minute) = time.split_once(':')?;
    if hour.is_empty()
        || minute.is_empty()
        || !hour.chars().chain(minute.chars()).all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some(PulseCommit {
        hash: hash.to_string(),
        time: time.to_string(),
        branch: parse_branch(refs),
    })
}

/// The branch a commit is decorated with: the `HEAD -> ` one if there is one,
/// otherwise the first ref listed.
fn parse_branch(refs: &str) -> String {
    let refs = refs.trim();
    if refs.is_empty() {
        return String::new();
    }
    let first = |value: &str| value.split(',').next().unwrap_or_default().trim().to_string();
    match refs.split_once("HEAD -> ") {
        Some((_, after)) => first(after),
        None => first(refs),
    }
}

/// One `--numstat` block: added, removed, and the files touched.
fn parse_numstat(output: &str) -> (u32, u32, Vec<String>) {
    let mut added = 0;
    let mut removed = 0;
    let mut files: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for line in output.lines() {
        let columns: Vec<&str> = line.split('\t').collect();
        if columns.len() != 3 {
            continue;
        }
        // Binary files report "-" for both counts; they still touch a file.
        added += columns[0].parse::<u32>().unwrap_or(0);
        removed += columns[1].parse::<u32>().unwrap_or(0);
        if !columns[2].is_empty() && seen.insert(columns[2].to_string()) {
            files.push(columns[2].to_string());
        }
    }
    (added, removed, files)
}

/// `YYYY-MM-DD` lines from `git log --date=format:%Y-%m-%d`, counted per day.
fn count_by_date(output: &str) -> BTreeMap<String, u32> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for line in output.lines().map(str::trim).filter(|l| !l.is_empty()) {
        *counts.entry(line.to_string()).or_insert(0) += 1;
    }
    counts
}

/// Runs a git command, treating any failure as empty output — one unreadable
/// repo must not blank the whole day.
async fn git_text(git: &Git, args: &[&str]) -> String {
    match git.run(args).await {
        Ok(output) => output.stdout,
        Err(error) => {
            log::debug!("pulse: git {args:?} failed in {:?}: {error}", git.repo_path());
            String::new()
        }
    }
}

async fn repo_activity(path: String, since_date: String) -> PulseRepoActivity {
    let git = Git::new(&path);
    let commits_raw = git_text(
        &git,
        &[
            "log",
            "--since=00:00:00",
            "--pretty=%H %cd %D",
            /* format-LOCAL: `--since=00:00:00` is resolved in local time, so
               rendering in the commit's own recorded zone puts a commit made
               at 09:15 here on the timeline at whatever o'clock it was where
               the committer was. Both ends of this must be local. */
            "--date=format-local:%H:%M",
            "--decorate=short",
        ],
    )
    .await;
    let numstat_raw = git_text(
        &git,
        &["log", "--since=00:00:00", "--numstat", "--pretty=tformat:"],
    )
    .await;
    let status_raw = git_text(&git, &["status", "--porcelain"]).await;
    let history_raw = git_text(
        &git,
        &[
            "log",
            &format!("--since={since_date} 00:00:00"),
            "--pretty=%cd",
            // Local, for the same reason as the timeline query above.
            "--date=format-local:%Y-%m-%d",
        ],
    )
    .await;

    let (added, removed, files) = parse_numstat(&numstat_raw);
    PulseRepoActivity {
        repo: basename(&path),
        path,
        commits: commits_raw.lines().filter_map(parse_commit_line).collect(),
        added,
        removed,
        files,
        dirty: status_raw.lines().filter(|l| !l.is_empty()).count() as u32,
        commits_by_date: count_by_date(&history_raw),
    }
}

/// Today's commits, churn and dirty state per repo, plus a commit count per
/// day over the last `days` days for the flow score's backfill.
///
/// Repos are read concurrently. Awaited in a loop this is four git processes
/// times the number of open tabs, strictly in series — on a ten-tab workspace
/// that is a wall-clock cost the caller pays every poll. The commands within
/// one repo stay sequential, so the spike is bounded by the tab count rather
/// than four times it.
#[tauri::command]
pub async fn pulse_git_activity(
    repo_paths: Vec<String>,
    days: u32,
) -> Result<Vec<PulseRepoActivity>, String> {
    let since = (Local::now() - Duration::days(days as i64))
        .format("%Y-%m-%d")
        .to_string();

    // Deduplicated: the same repo can back two open tabs, and counting its
    // commits twice would inflate every number downstream.
    let mut seen: HashSet<String> = HashSet::new();
    let mut running = Vec::new();
    for path in repo_paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        running.push(tokio::spawn(repo_activity(path, since.clone())));
    }

    let mut activity: Vec<PulseRepoActivity> = Vec::with_capacity(running.len());
    for handle in running {
        activity.push(handle.await.map_err(|e| format!("Repo scan failed: {e}"))?);
    }
    Ok(activity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tap_pass_and_fail() {
        assert_eq!(parse_test_result("# pass 28\n# fail 0\n"), Some((28, 0)));
        assert_eq!(parse_test_result("# fail 3\n"), Some((0, 3)));
    }

    #[test]
    fn parses_jest_vitest_pytest_and_mocha() {
        assert_eq!(
            parse_test_result("Tests: 1 failed, 2 skipped, 27 passed, 28 total"),
            Some((27, 1))
        );
        assert_eq!(
            parse_test_result("Tests  2 failed | 26 passed (28)"),
            Some((26, 2))
        );
        assert_eq!(parse_test_result("Tests  28 passed (28)"), Some((28, 0)));
        assert_eq!(
            parse_test_result("2 failed, 26 passed in 0.51s"),
            Some((26, 2))
        );
        assert_eq!(parse_test_result("28 passing\n2 failing\n"), Some((28, 2)));
    }

    #[test]
    fn ignores_prose_that_merely_mentions_passing() {
        assert_eq!(parse_test_result("28 passed checks in review"), None);
        assert_eq!(parse_test_result("the tests look fine"), None);
        assert_eq!(parse_test_result(""), None);
    }

    #[test]
    fn recognises_test_commands_on_word_boundaries() {
        assert!(is_test_command("npx vitest run src/lib"));
        assert!(is_test_command("cargo test --all"));
        assert!(is_test_command("go test ./..."));
        assert!(is_test_command("PYTEST_ADDOPTS=-q pytest"));
        // "latest" and "contest" are not test runners.
        assert!(!is_test_command("npm install react@latest"));
        assert!(!is_test_command("git log --oneline"));
    }

    #[test]
    fn parses_a_decorated_commit_line() {
        assert_eq!(
            parse_commit_line("abc1234 09:15 HEAD -> feat/x, origin/feat/x"),
            Some(PulseCommit {
                hash: "abc1234".into(),
                time: "09:15".into(),
                branch: "feat/x".into(),
            })
        );
    }

    #[test]
    fn falls_back_to_the_first_ref_and_tolerates_none() {
        assert_eq!(
            parse_commit_line("abc1234 09:15 tag: v1, origin/main")
                .map(|c| c.branch),
            Some("tag: v1".into())
        );
        assert_eq!(
            parse_commit_line("abc1234 09:15").map(|c| c.branch),
            Some(String::new())
        );
        assert_eq!(parse_commit_line("not-a-commit line here"), None);
        assert_eq!(parse_commit_line(""), None);
    }

    #[test]
    fn sums_numstat_and_dedupes_files() {
        let (added, removed, files) =
            parse_numstat("4\t2\tsrc/a.ts\n1\t0\tsrc/b.ts\n3\t3\tsrc/a.ts\n-\t-\tlogo.png\n");
        assert_eq!((added, removed), (8, 5));
        assert_eq!(files, vec!["src/a.ts", "src/b.ts", "logo.png"]);
    }

    #[test]
    fn counts_commits_per_day() {
        let counts = count_by_date("2026-08-28\n2026-08-27\n2026-08-28\n\n");
        assert_eq!(counts.get("2026-08-28"), Some(&2));
        assert_eq!(counts.get("2026-08-27"), Some(&1));
    }

    #[test]
    fn keeps_short_autopilot_reports_and_drops_prompts() {
        assert_eq!(
            autopilot_report("[AUTOPILOT]  re-ran   typecheck, formatted"),
            Some("[AUTOPILOT] re-ran typecheck, formatted".to_string())
        );
        assert_eq!(autopilot_report("Read the spec and [AUTOPILOT] port it"), None);
        assert_eq!(autopilot_report("You are a reviewer. [AUTOPILOT]"), None);
        // "Ported" is not the imperative "Port".
        assert!(autopilot_report("Ported the scoring [AUTOPILOT]").is_some());
        assert_eq!(autopilot_report(&"x".repeat(200)), None);
    }

    #[test]
    fn counts_switches_in_time_order_not_file_order() {
        // Two sessions, each in its own repo, interleaved through the morning.
        // Walked file by file this reads as one switch; in time order it is
        // the four it actually was.
        let mut visits = vec![
            (1_000, "alpha".to_string()),
            (3_000, "alpha".to_string()),
            (5_000, "alpha".to_string()),
            (2_000, "beta".to_string()),
            (4_000, "beta".to_string()),
        ];
        assert_eq!(count_switches(&mut visits), 4);
    }

    #[test]
    fn a_day_spent_in_one_repo_has_no_switches() {
        let mut visits = vec![
            (1_000, "alpha".to_string()),
            (2_000, "alpha".to_string()),
            (3_000, "alpha".to_string()),
        ];
        assert_eq!(count_switches(&mut visits), 0);
        assert_eq!(count_switches(&mut []), 0);
    }

    #[test]
    fn folds_a_days_transcripts_into_counters() {
        let dir = tempfile::tempdir().expect("temp dir");
        let nested = dir.path().join("-Users-alex-Repos-maestro");
        std::fs::create_dir_all(&nested).expect("nested dir");
        let lines = [
            r#"{"timestamp":"2026-08-28T09:15:00Z","cwd":"/Users/alex/Repos/maestro","message":{"content":[{"type":"tool_use","name":"Edit","id":"t1"}]}}"#,
            r#"{"timestamp":"2026-08-28T09:16:00Z","cwd":"/Users/alex/Repos/maestro","message":{"content":[{"type":"tool_use","name":"Bash","id":"t2","input":{"command":"npx vitest run"}}]}}"#,
            r#"{"timestamp":"2026-08-28T09:17:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"Tests  1 failed | 26 passed (27)"}]}}"#,
            r#"{"timestamp":"2026-08-28T09:18:00Z","cwd":"/Users/alex/Repos/nanoclaw","message":{"content":"Stop hook passed"}}"#,
            "not json at all",
        ];
        std::fs::write(nested.join("session.jsonl"), lines.join("\n")).expect("write");

        let stats = scan_transcripts(dir.path(), 0);

        assert_eq!(stats.edits, 1);
        assert_eq!(stats.tool_calls, 2);
        assert_eq!(stats.test_runs, 1);
        assert_eq!((stats.tests_pass, stats.tests_fail), (26, 1));
        assert_eq!(stats.repos, vec!["maestro", "nanoclaw"]);
        assert_eq!(stats.switches, 1);
        assert_eq!(stats.events.len(), 1);
        assert_eq!(stats.events[0].kind, "stopHook");
    }

    #[test]
    fn skips_transcripts_and_entries_from_before_today() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("session.jsonl"),
            r#"{"timestamp":"2020-01-01T09:15:00Z","cwd":"/repo/old","message":{"content":[{"type":"tool_use","name":"Edit"}]}}"#,
        )
        .expect("write");

        // The file's mtime is now, so it is read; the 2020 entry inside it
        // sits before the cutoff and is not counted.
        let stats = scan_transcripts(dir.path(), 1_600_000_000_000);
        assert_eq!(stats.tool_calls, 0);
        assert!(stats.repos.is_empty());
    }

    #[test]
    fn missing_transcript_root_is_an_empty_day() {
        let stats = scan_transcripts(Path::new("/no/such/directory"), 0);
        assert_eq!(stats, PulseTranscriptStats::default());
    }
}
