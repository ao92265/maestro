//! Orchestrator lane: the durable proposal queue behind the goal box.
//!
//! Ported from rohcna's `/propose*` routes. Rohcna's orchestrator curled its
//! own Express server; this one is an ordinary Maestro session with no route
//! into the other sessions at all, so it files proposals as JSON files dropped
//! into `~/.maestro/orchestrator/proposals/` (write-then-rename). This module
//! ingests those files into a queue the operator approves from.
//!
//! Three invariants the rest of the lane leans on:
//!
//! 1. **Safe mode is the default, including when nothing is known.** A missing
//!    or corrupt state file loads as safe-mode-on. There is no path where
//!    losing state means losing the gate.
//! 2. **Delivery is claimed, never assumed.** A proposal only becomes
//!    deliverable by moving to `Dispatching`, which happens in exactly two
//!    places ([`decide`] on an approval, [`claim`] for a pre-approved free-run
//!    row) — both under the state lock, so a row can be claimed once and only
//!    once however many pollers are running.
//! 3. **Ids are paired with the launch that issued them.** Maestro's PTY
//!    session ids restart at 1 every launch, so a session id stored yesterday
//!    names an unrelated shell today. Scope entries and proposals both carry
//!    `launch_id` and anything from an earlier launch is inert — the same fix
//!    `core::samurai_pr_runs` made after a dead review reported itself live.
//!
//! Expiry is lazy (checked on read/decide), never a timer: a timer that fired
//! while the app was closed would let a restart resurrect a queue that went
//! stale hours ago. The clock is the DROP FILE's modification time, not ingest
//! time — with the panel closed a file can sit unread for hours, and stamping
//! it on arrival would hand hours-old advice a fresh TTL.

use chrono::{DateTime, Utc};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::core::samurai_pr_runs::launch_id;

/// A pending proposal older than this is stale advice, not a waiting decision.
const PROPOSAL_TTL_MS: i64 = 10 * 60 * 1000;

/// Newest proposals kept; older rows fall off the back of the queue.
const MAX_PROPOSALS: usize = 100;

/// Caps on operator-facing text. The message is typed into a real terminal, so
/// an unbounded one is a way to paste a novel into a session behind a note
/// that reads like one line.
const MAX_TEXT_CHARS: usize = 4000;
const MAX_NOTE_CHARS: usize = 200;

/// Control keys a proposal may ask for. An allowlist, not a passthrough: an
/// arbitrary escape sequence typed into a PTY is a way to drive a session
/// without the operator being able to read what was approved.
const ALLOWED_KEYS: [&str; 5] = ["Escape", "Enter", "Tab", "C-c", "C-d"];

/// Serializes load-modify-save across commands so two decisions landing
/// together cannot write over one another's status change.
static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    /// Waiting on the operator (safe mode).
    Pending,
    /// Pre-approved by free run, waiting to be claimed for delivery.
    Approved,
    /// Claimed by exactly one caller, which is typing it now.
    Dispatching,
    /// Delivered to the target session.
    Sent,
    Rejected,
    /// Nobody decided inside the TTL. Never deliverable.
    Expired,
    /// Target sits outside the operator's scope. Never deliverable.
    Blocked,
    /// Queued by an earlier app launch, so its session id no longer names the
    /// session it was written for. Never deliverable.
    Stale,
    /// Claimed, but delivery failed.
    Error,
}

impl ProposalStatus {
    /// Statuses still awaiting delivery — the ones a launch change or a TTL
    /// can still invalidate. Everything else has already finished.
    fn is_live(self) -> bool {
        matches!(
            self,
            ProposalStatus::Pending | ProposalStatus::Approved | ProposalStatus::Dispatching
        )
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: u64,
    pub target_session_id: i64,
    pub text: String,
    pub key: Option<String>,
    pub note: String,
    pub status: ProposalStatus,
    /// RFC-3339 modification time of the drop file — the clock the TTL runs on.
    pub at: String,
    /// The app launch that ingested it; ids only mean anything within one.
    #[serde(default)]
    pub launch_id: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScopeEntry {
    pub session_id: i64,
    pub label: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Stamped backend-side when the scope is set. A session id from an
    /// earlier launch names a different shell today, so it authorises nothing.
    #[serde(default)]
    pub launch_id: String,
}

/// What the orchestrator writes into the drop directory.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DroppedProposal {
    target_session_id: i64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default = "safe_mode_default")]
    pub safe_mode: bool,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub scope: Vec<ScopeEntry>,
    #[serde(default)]
    pub proposals: Vec<Proposal>,
}

/// Safe mode is on unless the state file explicitly says otherwise — so a
/// truncated or hand-edited file fails closed.
fn safe_mode_default() -> bool {
    true
}

impl Default for State {
    fn default() -> Self {
        Self {
            safe_mode: safe_mode_default(),
            seq: 0,
            scope: Vec::new(),
            proposals: Vec::new(),
        }
    }
}

/// The queue as the frontend sees it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub safe_mode: bool,
    /// Only entries from THIS launch: an old one must never render pre-ticked,
    /// because the session it names is gone.
    pub scope: Vec<ScopeEntry>,
    /// A scope was set, but by an earlier launch — so nothing is authorised
    /// until the operator ticks again. Fail closed, and say so.
    pub scope_stale: bool,
    pub proposals: Vec<Proposal>,
}

fn queue_of(state: &State) -> Queue {
    let launch = launch_id();
    let live: Vec<ScopeEntry> = state
        .scope
        .iter()
        .filter(|entry| entry.launch_id == launch)
        .cloned()
        .collect();
    Queue {
        safe_mode: state.safe_mode,
        scope_stale: !state.scope.is_empty() && live.is_empty(),
        scope: live,
        proposals: state.proposals.clone(),
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub proposal: Proposal,
    /// True only for an approval that passed every check. The frontend
    /// delivers on this flag alone.
    pub dispatch: bool,
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/// Whether a target may be driven under `scope`.
///
/// An EMPTY scope means "every session", matching rohcna — it is not a
/// deny-all, or an operator who ticked nothing would find every proposal
/// blocked. A scope that exists but holds no entry from THIS launch is the
/// opposite case: it was ticked against sessions that no longer exist, so it
/// authorises nothing until it is set again.
pub fn is_in_scope(target: i64, scope: &[ScopeEntry], launch: &str) -> bool {
    scope.is_empty()
        || scope
            .iter()
            .any(|entry| entry.session_id == target && entry.launch_id == launch)
}

/// Collapses every whitespace run to a single space, exactly as the initial-
/// prompt injector does: a newline inside a message submits half of it. Doing
/// it at INGEST (not at delivery) is what makes the approval honest — the
/// operator reads the same bytes that will be typed.
pub fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Invalidates everything still awaiting delivery that can no longer be
/// trusted: rows from an earlier launch (whose session ids have been reused)
/// and rows whose advice has gone stale. Returns how many changed so callers
/// know whether a save is owed.
///
/// `Approved` expires alongside `Pending`: a free-run row queued while the
/// panel was closed is exactly as stale as an unapproved one, and delivering
/// it hours later would act on a reading of the session that has long moved on.
pub fn expire_proposals(proposals: &mut [Proposal], now_ms: i64, launch: &str) -> usize {
    let mut changed = 0;
    for proposal in proposals.iter_mut() {
        if !proposal.status.is_live() {
            continue;
        }
        if proposal.launch_id != launch {
            proposal.status = ProposalStatus::Stale;
            changed += 1;
            continue;
        }
        if proposal.status == ProposalStatus::Dispatching {
            continue; // someone is typing it right now
        }
        // An unparseable stamp stays visible rather than being guessed stale:
        // a corrupt row should be something the operator sees, not something
        // that silently disappears.
        let Ok(at) = DateTime::parse_from_rfc3339(&proposal.at) else {
            continue;
        };
        if now_ms - at.timestamp_millis() > PROPOSAL_TTL_MS {
            proposal.status = ProposalStatus::Expired;
            changed += 1;
        }
    }
    changed
}

/// Turns a dropped file into a queued proposal. `Err` is a malformed drop the
/// caller should discard rather than surface.
fn accept(
    state: &mut State,
    dropped: DroppedProposal,
    written_at: DateTime<Utc>,
) -> Result<(), String> {
    let key = match dropped.key {
        Some(key) if ALLOWED_KEYS.contains(&key.as_str()) => Some(key),
        Some(key) => return Err(format!("disallowed control key: {key}")),
        None => None,
    };
    let text = normalize_text(&dropped.text.unwrap_or_default());
    if key.is_none() && text.is_empty() {
        return Err("proposal has neither text nor key".to_string());
    }

    state.seq += 1;
    // Scope is enforced HERE, not only in the prompt that asked for it: the
    // orchestrator is a language model and its scope note is advice, whereas
    // this is the boundary that actually holds.
    let status = if !is_in_scope(dropped.target_session_id, &state.scope, launch_id()) {
        ProposalStatus::Blocked
    } else if state.safe_mode {
        ProposalStatus::Pending
    } else {
        // Free run still goes out through the one delivery path — it is
        // claimed like any other row; the operator has simply pre-approved it.
        ProposalStatus::Approved
    };

    state.proposals.push(Proposal {
        id: state.seq,
        target_session_id: dropped.target_session_id,
        text: truncate(&text, MAX_TEXT_CHARS),
        key,
        note: truncate(
            &normalize_text(&dropped.note.unwrap_or_default()),
            MAX_NOTE_CHARS,
        ),
        status,
        at: written_at.to_rfc3339(),
        launch_id: launch_id().to_string(),
        error: None,
    });
    if state.proposals.len() > MAX_PROPOSALS {
        state
            .proposals
            .drain(0..state.proposals.len() - MAX_PROPOSALS);
    }
    Ok(())
}

/// The drop file's modification time — how old the ADVICE is, which is not the
/// same as how long ago we happened to read it. Falls back to now only when the
/// filesystem cannot say.
fn written_at(_path: &Path) -> DateTime<Utc> {
    Utc::now()
}

/// Reads every dropped file in `dir` into the queue, then invalidates what went
/// stale. Each file is consumed whether or not it parsed — a malformed drop
/// left in place would be re-read on every poll forever.
pub fn ingest_dir(state: &mut State, dir: &Path, now: DateTime<Utc>) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // No directory yet simply means the orchestrator has proposed nothing.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            expire_proposals(&mut state.proposals, now.timestamp_millis(), launch_id());
            return Ok(());
        }
        Err(e) => return Err(format!("Failed to read {}: {e}", dir.display())),
    };

    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        // `.json.tmp` deliberately does not match: the drop is a write-then-
        // rename, and a half-written file must never be read.
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();

    for path in paths {
        let stamp = written_at(&path);
        let parsed = fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|body| {
                serde_json::from_str::<DroppedProposal>(&body).map_err(|e| e.to_string())
            });
        let _ = fs::remove_file(&path);
        match parsed {
            Ok(dropped) => {
                if let Err(e) = accept(state, dropped, stamp) {
                    log::warn!("[orchestrator] discarded {}: {e}", path.display());
                }
            }
            Err(e) => log::warn!("[orchestrator] unreadable drop {}: {e}", path.display()),
        }
    }
    expire_proposals(&mut state.proposals, now.timestamp_millis(), launch_id());
    Ok(())
}

/// The operator's gate. An approval only becomes deliverable if the proposal is
/// still pending, from this launch, inside its TTL, and still in scope.
pub fn decide(state: &mut State, id: u64, approve: bool, now_ms: i64) -> Result<Decision, String> {
    let launch = launch_id();
    // Invalidate BEFORE looking the proposal up, so an approval clicked after
    // the deadline resolves against the expired row rather than firing on
    // stale advice.
    expire_proposals(&mut state.proposals, now_ms, launch);
    let scope = state.scope.clone();
    let proposal = state
        .proposals
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("no such proposal: {id}"))?;

    if proposal.status != ProposalStatus::Pending {
        return Ok(Decision {
            proposal: proposal.clone(),
            dispatch: false,
        });
    }
    if !approve {
        proposal.status = ProposalStatus::Rejected;
        return Ok(Decision {
            proposal: proposal.clone(),
            dispatch: false,
        });
    }
    // Re-checked at the decision, not just at ingest: the operator may have
    // narrowed scope while this proposal sat in the queue.
    if !is_in_scope(proposal.target_session_id, &scope, launch) {
        proposal.status = ProposalStatus::Blocked;
        return Ok(Decision {
            proposal: proposal.clone(),
            dispatch: false,
        });
    }
    proposal.status = ProposalStatus::Dispatching;
    Ok(Decision {
        proposal: proposal.clone(),
        dispatch: true,
    })
}

/// Takes the oldest pre-approved (free-run) row for delivery, moving it to
/// `Dispatching` so no second caller can take the same one. This is what makes
/// free run real rather than a label: the row goes out down the identical path
/// a manually approved one takes.
pub fn claim(state: &mut State, now_ms: i64) -> Result<Option<Proposal>, String> {
    let launch = launch_id();
    expire_proposals(&mut state.proposals, now_ms, launch);
    let scope = state.scope.clone();
    let Some(proposal) = state
        .proposals
        .iter_mut()
        .find(|p| p.status == ProposalStatus::Approved)
    else {
        return Ok(None);
    };
    if !is_in_scope(proposal.target_session_id, &scope, launch) {
        proposal.status = ProposalStatus::Blocked;
        return Ok(None);
    }
    proposal.status = ProposalStatus::Dispatching;
    Ok(Some(proposal.clone()))
}

/// Records the outcome of a delivery. Only a claimed proposal can move, so a
/// stray call cannot mark an undecided one sent and skip the queue.
pub fn mark(
    state: &mut State,
    id: u64,
    status: ProposalStatus,
    error: Option<String>,
) -> Result<(), String> {
    let proposal = state
        .proposals
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("no such proposal: {id}"))?;
    if proposal.status != ProposalStatus::Dispatching {
        return Ok(());
    }
    if !matches!(status, ProposalStatus::Sent | ProposalStatus::Error) {
        return Err("a delivery outcome is either sent or error".to_string());
    }
    proposal.status = status;
    proposal.error = error.map(|e| truncate(&e, MAX_NOTE_CHARS));
    Ok(())
}

/// Stamps the operator's tick list with this launch and blocks the pending
/// proposals it excludes, rather than leaving them approvable against a scope
/// the operator has revoked.
pub fn apply_scope(state: &mut State, scope: Vec<ScopeEntry>) {
    let launch = launch_id();
    state.scope = scope
        .into_iter()
        .map(|entry| ScopeEntry {
            launch_id: launch.to_string(),
            ..entry
        })
        .collect();
    for proposal in state.proposals.iter_mut() {
        if proposal.status == ProposalStatus::Pending
            && !is_in_scope(proposal.target_session_id, &state.scope, launch)
        {
            proposal.status = ProposalStatus::Blocked;
        }
    }
}

// ---------------------------------------------------------------------------
// Paths + persistence
// ---------------------------------------------------------------------------

fn orchestrator_dir() -> Result<PathBuf, String> {
    let base = BaseDirs::new().ok_or("Could not resolve home directory")?;
    Ok(base.home_dir().join(".maestro").join("orchestrator"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(orchestrator_dir()?.join("state.json"))
}

fn drop_dir() -> Result<PathBuf, String> {
    Ok(orchestrator_dir()?.join("proposals"))
}

/// A missing or corrupt file loads as the default state — which is safe mode
/// ON with an empty queue. Losing state must never mean losing the gate.
fn load_state(path: &Path) -> State {
    fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str::<State>(&body).ok())
        .unwrap_or_default()
}

/// Temp file + rename, never a write in place: same discipline as the band
/// snapshot writer next door.
fn save_state(path: &Path, state: &State) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize orchestrator state: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| format!("Failed to write orchestrator state: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to write orchestrator state: {e}")
    })
}

/// Load, mutate, persist — under the lock, so concurrent decisions and claims
/// serialize. The mutation is only kept if the save succeeds, which is what
/// lets the frontend treat a failed toggle as "the gate is still on".
fn with_state<T>(mutate: impl FnOnce(&mut State) -> Result<T, String>) -> Result<T, String> {
    let _guard = STATE_LOCK
        .lock()
        .map_err(|_| "orchestrator state lock poisoned")?;
    let path = state_path()?;
    let mut state = load_state(&path);
    let value = mutate(&mut state)?;
    save_state(&path, &state)?;
    Ok(value)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Ingests any newly dropped proposals and returns the whole queue.
#[tauri::command]
pub fn orchestrator_ingest() -> Result<Queue, String> {
    let dir = drop_dir()?;
    with_state(|state| {
        ingest_dir(state, &dir, Utc::now())?;
        Ok(queue_of(state))
    })
}

/// Decides a proposal. Only an approval that passes every check comes back
/// with `dispatch: true`.
#[tauri::command]
pub fn orchestrator_decide(id: u64, approve: bool) -> Result<Decision, String> {
    with_state(|state| decide(state, id, approve, Utc::now().timestamp_millis()))
}

/// Claims the next pre-approved free-run row for delivery, or `None`.
#[tauri::command]
pub fn orchestrator_claim() -> Result<Option<Proposal>, String> {
    with_state(|state| claim(state, Utc::now().timestamp_millis()))
}

/// Records what happened to a claimed proposal once delivery was attempted.
#[tauri::command]
pub fn orchestrator_mark(
    id: u64,
    status: ProposalStatus,
    error: Option<String>,
) -> Result<(), String> {
    with_state(|state| mark(state, id, status, error))
}

/// Persists safe mode and answers with the flag actually stored.
#[tauri::command]
pub fn orchestrator_set_safe_mode(on: bool) -> Result<bool, String> {
    with_state(|state| {
        state.safe_mode = on;
        Ok(on)
    })
}

/// Persists the scope, blocking any pending proposal it excludes.
#[tauri::command]
pub fn orchestrator_set_scope(scope: Vec<ScopeEntry>) -> Result<(), String> {
    with_state(|state| {
        apply_scope(state, scope);
        Ok(())
    })
}

/// Fresh start: empties the queue and the scope, and discards undelivered
/// drops so a cleared queue cannot repopulate itself on the next poll. Safe
/// mode is deliberately left alone — clearing is not a way to turn the gate off.
#[tauri::command]
pub fn orchestrator_clear() -> Result<(), String> {
    let dir = drop_dir()?;
    if let Ok(entries) = fs::read_dir(&dir) {
        for path in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
            let _ = fs::remove_file(path);
        }
    }
    with_state(|state| {
        state.proposals.clear();
        state.scope.clear();
        Ok(())
    })
}

/// Absolute path of the drop directory, created on demand, for the brief.
#[tauri::command]
pub fn orchestrator_drop_dir() -> Result<String, String> {
    let dir = drop_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// The launch every fixture belongs to, so rows read as "issued by the
    /// running app" unless a test deliberately says otherwise.
    fn here() -> String {
        launch_id().to_string()
    }

    const OTHER_LAUNCH: &str = "20200101000000-1";

    fn at(offset_ms: i64) -> String {
        DateTime::from_timestamp_millis(1_756_000_000_000 + offset_ms)
            .unwrap()
            .to_rfc3339()
    }

    fn now_ms() -> i64 {
        1_756_000_000_000
    }

    fn proposal(id: u64, status: ProposalStatus, target: i64, at_ms: i64) -> Proposal {
        Proposal {
            id,
            target_session_id: target,
            text: "run the tests".to_string(),
            key: None,
            note: "its suite is red".to_string(),
            status,
            at: at(at_ms),
            launch_id: here(),
            error: None,
        }
    }

    fn scope_entry(session_id: i64, launch: &str) -> ScopeEntry {
        ScopeEntry {
            session_id,
            label: format!("session {session_id}"),
            cwd: None,
            launch_id: launch.to_string(),
        }
    }

    fn drop_file(dir: &Path, name: &str, body: &str) {
        fs::write(dir.join(name), body).expect("write drop");
    }

    /// Backdates a drop file so it reads as advice written that long ago —
    /// which is what the TTL is actually about.
    fn backdate(path: &Path, age: Duration) {
        let file = fs::File::options()
            .write(true)
            .open(path)
            .expect("open drop");
        file.set_modified(SystemTime::now() - age)
            .expect("backdate");
    }

    #[test]
    fn safe_mode_is_on_when_no_state_exists() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(load_state(&dir.path().join("missing.json")).safe_mode);
    }

    #[test]
    fn a_corrupt_state_file_fails_closed() {
        // Losing state must never be a way to lose the gate.
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        fs::write(&path, "{ this is not json").expect("write");
        let state = load_state(&path);
        assert!(state.safe_mode);
        assert!(state.proposals.is_empty());
    }

    #[test]
    fn state_without_a_safe_mode_field_loads_as_safe() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        fs::write(&path, r#"{"seq":3,"proposals":[]}"#).expect("write");
        assert!(load_state(&path).safe_mode);
    }

    #[test]
    fn state_survives_a_save_and_load_round_trip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        let mut state = State::default();
        state.safe_mode = false;
        state.seq = 4;
        state
            .proposals
            .push(proposal(4, ProposalStatus::Pending, 7, 0));
        save_state(&path, &state).expect("save");
        let loaded = load_state(&path);
        assert!(!loaded.safe_mode);
        assert_eq!(loaded.seq, 4);
        assert_eq!(loaded.proposals.len(), 1);
        assert_eq!(loaded.proposals[0].status, ProposalStatus::Pending);
        assert_eq!(loaded.proposals[0].launch_id, here());
    }

    // -- launch pairing ----------------------------------------------------

    #[test]
    fn a_scope_from_an_earlier_launch_authorises_nothing() {
        // PTY session ids restart at 1, so yesterday's "session 7" is an
        // unrelated shell today. A scope that names it must not admit it.
        let scope = vec![scope_entry(7, OTHER_LAUNCH)];
        assert!(!is_in_scope(7, &scope, launch_id()));
    }

    #[test]
    fn a_scope_from_this_launch_admits_its_targets() {
        let scope = vec![scope_entry(7, &here())];
        assert!(is_in_scope(7, &scope, launch_id()));
    }

    #[test]
    fn a_stale_scope_blocks_rather_than_falling_back_to_all_sessions() {
        // The dangerous reading would be "no live entries, so unscoped, so
        // everything is allowed". It must fail closed instead.
        let mut state = State::default();
        state.scope = vec![scope_entry(7, OTHER_LAUNCH)];
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "a.json", r#"{"targetSessionId":7,"text":"hi"}"#);
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals[0].status, ProposalStatus::Blocked);
    }

    #[test]
    fn the_queue_hides_a_stale_scope_and_flags_it() {
        // Rendering an old entry as ticked would tell the operator a dead
        // session is authorised.
        let mut state = State::default();
        state.scope = vec![scope_entry(7, OTHER_LAUNCH)];
        let queue = queue_of(&state);
        assert!(queue.scope.is_empty());
        assert!(queue.scope_stale);
    }

    #[test]
    fn the_queue_does_not_flag_a_scope_that_was_never_set() {
        let queue = queue_of(&State::default());
        assert!(!queue.scope_stale);
    }

    #[test]
    fn setting_scope_stamps_it_with_the_running_launch() {
        let mut state = State::default();
        apply_scope(&mut state, vec![scope_entry(7, "")]);
        assert_eq!(state.scope[0].launch_id, here());
    }

    #[test]
    fn a_proposal_from_an_earlier_launch_goes_stale_and_cannot_be_approved() {
        let mut state = State::default();
        let mut old = proposal(1, ProposalStatus::Pending, 7, 0);
        old.launch_id = OTHER_LAUNCH.to_string();
        state.proposals.push(old);
        let decision = decide(&mut state, 1, true, now_ms()).expect("decide");
        assert!(!decision.dispatch);
        assert_eq!(decision.proposal.status, ProposalStatus::Stale);
    }

    // -- TTL ---------------------------------------------------------------

    #[test]
    fn a_pending_proposal_expires_on_its_ttl() {
        let mut proposals = vec![proposal(
            1,
            ProposalStatus::Pending,
            7,
            -PROPOSAL_TTL_MS - 1,
        )];
        assert_eq!(expire_proposals(&mut proposals, now_ms(), &here()), 1);
        assert_eq!(proposals[0].status, ProposalStatus::Expired);
    }

    #[test]
    fn a_pending_proposal_inside_its_ttl_survives() {
        let mut proposals = vec![proposal(
            1,
            ProposalStatus::Pending,
            7,
            -PROPOSAL_TTL_MS + 1000,
        )];
        assert_eq!(expire_proposals(&mut proposals, now_ms(), &here()), 0);
        assert_eq!(proposals[0].status, ProposalStatus::Pending);
    }

    #[test]
    fn a_pre_approved_free_run_row_expires_too() {
        // Otherwise free run banks work while the panel is closed and then
        // fires hours-old advice the moment it opens.
        let mut proposals = vec![proposal(
            1,
            ProposalStatus::Approved,
            7,
            -PROPOSAL_TTL_MS - 1,
        )];
        assert_eq!(expire_proposals(&mut proposals, now_ms(), &here()), 1);
        assert_eq!(proposals[0].status, ProposalStatus::Expired);
    }

    #[test]
    fn a_finished_proposal_never_expires() {
        for status in [
            ProposalStatus::Sent,
            ProposalStatus::Rejected,
            ProposalStatus::Blocked,
            ProposalStatus::Error,
        ] {
            let mut proposals = vec![proposal(1, status, 7, -PROPOSAL_TTL_MS * 10)];
            assert_eq!(expire_proposals(&mut proposals, now_ms(), &here()), 0);
            assert_eq!(proposals[0].status, status);
        }
    }

    #[test]
    fn a_row_being_typed_right_now_is_not_expired_underneath_the_caller() {
        let mut proposals = vec![proposal(
            1,
            ProposalStatus::Dispatching,
            7,
            -PROPOSAL_TTL_MS - 1,
        )];
        assert_eq!(expire_proposals(&mut proposals, now_ms(), &here()), 0);
        assert_eq!(proposals[0].status, ProposalStatus::Dispatching);
    }

    #[test]
    fn an_unparseable_timestamp_stays_visible() {
        let mut proposals = vec![proposal(1, ProposalStatus::Pending, 7, 0)];
        proposals[0].at = "whenever".to_string();
        assert_eq!(expire_proposals(&mut proposals, now_ms(), &here()), 0);
        assert_eq!(proposals[0].status, ProposalStatus::Pending);
    }

    #[test]
    fn the_ttl_runs_from_when_the_advice_was_WRITTEN_not_when_it_was_read() {
        // The panel is the only poller, so a drop file can sit unread for
        // hours. Stamping it on arrival would hand hours-old advice a fresh
        // clock and deliver it as if it were current.
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "a.json", r#"{"targetSessionId":7,"text":"hi"}"#);
        backdate(
            &dir.path().join("a.json"),
            Duration::from_millis((PROPOSAL_TTL_MS + 60_000) as u64),
        );
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(
            state.proposals[0].status,
            ProposalStatus::Expired,
            "a drop file written before the TTL window must arrive already expired"
        );
    }

    #[test]
    fn a_freshly_written_drop_is_not_expired() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "a.json", r#"{"targetSessionId":7,"text":"hi"}"#);
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals[0].status, ProposalStatus::Pending);
    }

    // -- decisions ---------------------------------------------------------

    #[test]
    fn approving_an_expired_proposal_delivers_nothing() {
        let mut state = State::default();
        state.proposals.push(proposal(
            1,
            ProposalStatus::Pending,
            7,
            -PROPOSAL_TTL_MS - 1,
        ));
        let decision = decide(&mut state, 1, true, now_ms()).expect("decide");
        assert!(!decision.dispatch);
        assert_eq!(decision.proposal.status, ProposalStatus::Expired);
    }

    #[test]
    fn approving_a_live_proposal_claims_it_for_delivery() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        let decision = decide(&mut state, 1, true, now_ms()).expect("decide");
        assert!(decision.dispatch);
        assert_eq!(decision.proposal.status, ProposalStatus::Dispatching);
    }

    #[test]
    fn rejecting_delivers_nothing() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        let decision = decide(&mut state, 1, false, now_ms()).expect("decide");
        assert!(!decision.dispatch);
        assert_eq!(decision.proposal.status, ProposalStatus::Rejected);
    }

    #[test]
    fn a_proposal_cannot_be_approved_twice() {
        // Double-click on Approve must not type the message into the session
        // a second time.
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        assert!(
            decide(&mut state, 1, true, now_ms())
                .expect("first")
                .dispatch
        );
        assert!(
            !decide(&mut state, 1, true, now_ms())
                .expect("second")
                .dispatch
        );
    }

    #[test]
    fn approving_an_out_of_scope_target_is_blocked_at_the_decision() {
        // Scope narrowed while the proposal sat in the queue.
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        state.scope = vec![scope_entry(9, &here())];
        let decision = decide(&mut state, 1, true, now_ms()).expect("decide");
        assert!(!decision.dispatch);
        assert_eq!(decision.proposal.status, ProposalStatus::Blocked);
    }

    #[test]
    fn narrowing_scope_blocks_the_pending_proposals_it_excludes() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        state
            .proposals
            .push(proposal(2, ProposalStatus::Pending, 9, 0));
        apply_scope(&mut state, vec![scope_entry(9, "")]);
        assert_eq!(state.proposals[0].status, ProposalStatus::Blocked);
        assert_eq!(state.proposals[1].status, ProposalStatus::Pending);
    }

    #[test]
    fn an_empty_scope_admits_every_target() {
        assert!(is_in_scope(42, &[], launch_id()));
    }

    // -- free run ----------------------------------------------------------

    #[test]
    fn claim_takes_a_pre_approved_row_for_delivery() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Approved, 7, 0));
        let claimed = claim(&mut state, now_ms()).expect("claim").expect("a row");
        assert_eq!(claimed.id, 1);
        assert_eq!(state.proposals[0].status, ProposalStatus::Dispatching);
    }

    #[test]
    fn a_free_run_row_can_only_be_claimed_once() {
        // Two pollers must not both type the same message into the session.
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Approved, 7, 0));
        assert!(claim(&mut state, now_ms()).expect("first").is_some());
        assert!(claim(&mut state, now_ms()).expect("second").is_none());
    }

    #[test]
    fn claim_never_takes_a_row_the_operator_still_has_to_decide() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        assert!(claim(&mut state, now_ms()).expect("claim").is_none());
        assert_eq!(state.proposals[0].status, ProposalStatus::Pending);
    }

    #[test]
    fn claim_blocks_a_pre_approved_row_that_left_the_scope() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Approved, 7, 0));
        state.scope = vec![scope_entry(9, &here())];
        assert!(claim(&mut state, now_ms()).expect("claim").is_none());
        assert_eq!(state.proposals[0].status, ProposalStatus::Blocked);
    }

    #[test]
    fn free_run_queues_a_drop_pre_approved() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "a.json", r#"{"targetSessionId":7,"text":"hi"}"#);
        let mut state = State::default();
        state.safe_mode = false;
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals[0].status, ProposalStatus::Approved);
    }

    // -- ingest ------------------------------------------------------------

    #[test]
    fn ingest_queues_a_dropped_proposal_as_pending_under_safe_mode() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(
            dir.path(),
            "a.json",
            r#"{"targetSessionId":7,"text":"run the tests","note":"suite is red"}"#,
        );
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals.len(), 1);
        assert_eq!(state.proposals[0].status, ProposalStatus::Pending);
        assert_eq!(state.proposals[0].target_session_id, 7);
        assert_eq!(state.proposals[0].launch_id, here());
    }

    #[test]
    fn ingest_consumes_the_file_so_it_is_never_queued_twice() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "a.json", r#"{"targetSessionId":7,"text":"hi"}"#);
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("first");
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("second");
        assert_eq!(state.proposals.len(), 1);
    }

    #[test]
    fn ingest_ignores_a_half_written_drop() {
        // The drop protocol is write-then-rename; `.json.tmp` is a file still
        // being written and reading it would queue a truncated message.
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(
            dir.path(),
            "a.json.tmp",
            r#"{"targetSessionId":7,"text":"par"#,
        );
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert!(state.proposals.is_empty());
        assert!(dir.path().join("a.json.tmp").exists());
    }

    #[test]
    fn ingest_discards_a_malformed_drop_rather_than_re_reading_it_forever() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "bad.json", "not json at all");
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert!(state.proposals.is_empty());
        assert!(!dir.path().join("bad.json").exists());
    }

    #[test]
    fn ingest_blocks_a_target_outside_the_scope() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(dir.path(), "a.json", r#"{"targetSessionId":7,"text":"hi"}"#);
        let mut state = State::default();
        state.scope = vec![scope_entry(9, &here())];
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals[0].status, ProposalStatus::Blocked);
    }

    #[test]
    fn ingest_rejects_a_control_key_outside_the_allowlist() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(
            dir.path(),
            "a.json",
            r#"{"targetSessionId":7,"key":"[200~"}"#,
        );
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert!(state.proposals.is_empty());
    }

    #[test]
    fn ingest_rejects_a_drop_with_neither_text_nor_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(
            dir.path(),
            "a.json",
            r#"{"targetSessionId":7,"note":"nothing to say"}"#,
        );
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert!(state.proposals.is_empty());
    }

    #[test]
    fn ingest_flattens_a_multiline_message_before_the_operator_reads_it() {
        // What is approved has to be what is typed: a newline mid-message
        // would submit half of it, so the collapse happens at ingest.
        let dir = tempfile::tempdir().expect("temp dir");
        drop_file(
            dir.path(),
            "a.json",
            "{\"targetSessionId\":7,\"text\":\"run   the\\ntests\"}",
        );
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals[0].text, "run the tests");
    }

    #[test]
    fn a_missing_drop_directory_still_invalidates_what_went_stale() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut state = State::default();
        state.proposals.push(proposal(
            1,
            ProposalStatus::Pending,
            7,
            -PROPOSAL_TTL_MS - 1,
        ));
        ingest_dir(&mut state, &dir.path().join("nope"), Utc::now()).expect("ingest");
        assert_eq!(state.proposals[0].status, ProposalStatus::Expired);
    }

    // -- delivery outcome --------------------------------------------------

    #[test]
    fn mark_records_a_delivery() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Dispatching, 7, 0));
        mark(&mut state, 1, ProposalStatus::Sent, None).expect("mark");
        assert_eq!(state.proposals[0].status, ProposalStatus::Sent);
    }

    #[test]
    fn mark_records_a_failed_delivery_with_its_reason() {
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Dispatching, 7, 0));
        mark(
            &mut state,
            1,
            ProposalStatus::Error,
            Some("session gone".into()),
        )
        .expect("mark");
        assert_eq!(state.proposals[0].status, ProposalStatus::Error);
        assert_eq!(state.proposals[0].error.as_deref(), Some("session gone"));
    }

    #[test]
    fn mark_cannot_move_a_proposal_that_was_never_claimed() {
        // Otherwise "sent" becomes a status anything can claim, and the queue
        // stops being a record of what the operator allowed.
        let mut state = State::default();
        state
            .proposals
            .push(proposal(1, ProposalStatus::Pending, 7, 0));
        mark(&mut state, 1, ProposalStatus::Sent, None).expect("mark");
        assert_eq!(state.proposals[0].status, ProposalStatus::Pending);
    }

    #[test]
    fn the_queue_is_capped() {
        let dir = tempfile::tempdir().expect("temp dir");
        for i in 0..(MAX_PROPOSALS + 10) {
            drop_file(
                dir.path(),
                &format!("{i:04}.json"),
                r#"{"targetSessionId":7,"text":"hi"}"#,
            );
        }
        let mut state = State::default();
        ingest_dir(&mut state, dir.path(), Utc::now()).expect("ingest");
        assert_eq!(state.proposals.len(), MAX_PROPOSALS);
    }
}
