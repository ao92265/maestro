//! Tauri commands for the Samurai supervisor state machine and audit log
//! (Phase 1 — see `docs/samurai/prd.md` §5.2 and §5.10).
//!
//! The register/transition commands exist so transitions can be driven
//! manually from the frontend for testing; Phases 2–3 wire real triggers.
//! Project paths are canonicalized (and the Windows `\\?\` prefix stripped)
//! at this boundary so every layer below sees one spelling per project.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_store::StoreExt;

use crate::commands::ai_runner::{artifact_base_dir, canonical_project_path};
use crate::commands::usage::{get_claude_usage, UsageData};
use crate::core::samurai_audit::{AuditEvent, AuditEventKind, AuditLog, AuditReadResult};
use crate::core::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
use crate::core::samurai_files::{self, SamuraiFileEntry, SamuraiFilesRoots};
use crate::core::samurai_injector::strip_extended_prefix;
use crate::core::samurai_journal::{
    default_journal_file, JournalCategory, JournalEntry, JournalListResult, JournalStore,
};
use crate::core::samurai_prompts::{self, epic_slug};
use crate::core::samurai_replicator::{derive_repo_pin, SamuraiReplicator};
use crate::core::samurai_run_config::{RunConfigStatus, RunConfigStore, SamuraiRunConfig};
use crate::core::samurai_schedule::{SamuraiSchedule, ScheduleEntry};
use crate::core::samurai_test_gate::{self, SamuraiTestGate, TestGateProgress};
use crate::core::samurai_workflow::{self, WorkflowGraph};
use crate::core::supervisor::{SessionSnapshot, Supervisor, SupervisorState};
use crate::core::worktree_manager::WorktreeManager;
use crate::git::{Git, GitError};
use crate::github::{AuthStatus, GitHub};

/// Store filename for the Samurai config (app-data settings pattern, same
/// as `commands/marketplace.rs`).
const SAMURAI_CONFIG_STORE: &str = "samurai-config.json";
/// The single key the whole config object lives under.
const SAMURAI_CONFIG_KEY: &str = "config";

/// Loads the persisted Samurai config, falling back to PRD §7 defaults for
/// a missing/partial/unreadable store. Called once at startup (`lib.rs`) to
/// seed the shared state the allowance loop and the commands read.
pub fn load_config_from_store(app: &AppHandle) -> SamuraiConfig {
    let stored = app
        .store(SAMURAI_CONFIG_STORE)
        .ok()
        .and_then(|store| store.get(SAMURAI_CONFIG_KEY))
        .and_then(|v| serde_json::from_value::<SamuraiConfig>(v).ok())
        .unwrap_or_default();
    // A hand-edited store file could hold out-of-range values the set
    // command would have rejected — fall back to defaults rather than run
    // the watcher on garbage.
    if let Err(e) = stored.validate() {
        log::warn!("samurai: stored config invalid ({e}); using defaults");
        return SamuraiConfig::default();
    }
    stored
}

/// Current Samurai thresholds (PRD §7 defaults until the user edits them).
#[tauri::command]
pub fn samurai_get_config(config: State<'_, SharedSamuraiConfig>) -> SamuraiConfig {
    config
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Validates, persists and applies a new Samurai config. The allowance
/// loop reads the shared state every tick, so changes take effect within
/// one poll interval — no restart (that immediacy is the test mode, PRD
/// decision #7).
#[tauri::command]
pub fn samurai_set_config(
    app: AppHandle,
    state: State<'_, SharedSamuraiConfig>,
    config: SamuraiConfig,
) -> Result<SamuraiConfig, String> {
    config.validate()?;

    let store = app
        .store(SAMURAI_CONFIG_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;
    store.set(
        SAMURAI_CONFIG_KEY,
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    );
    store
        .save()
        .map_err(|e| format!("failed to save settings store: {e}"))?;

    *state
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = config.clone();
    Ok(config)
}

/// Places a session under supervision, starting in `WORKING` at `generation`
/// (default 1). Emits a `SPAWN` audit row and a `samurai-supervisor-event`.
///
/// Issue #55: a registration matching a successor the replicator staged
/// (same project, epic and generation) gets its SPAWN row linked to the
/// predecessor, and arms the verify-ritual delivery for the new session's
/// first `SessionStarted` hook signal.
#[tauri::command]
pub fn samurai_register_session(
    supervisor: State<'_, Arc<Supervisor>>,
    replicator: State<'_, Arc<SamuraiReplicator>>,
    session_id: u32,
    project_path: String,
    epic: String,
    generation: Option<u32>,
) -> Result<SessionSnapshot, String> {
    let project = canonical_project_path(&project_path);
    let generation = generation.unwrap_or(1);
    let snapshot = match replicator.spawn_details(&project, &epic, generation) {
        Some(details) => supervisor
            .register_session_with_details(session_id, project, epic, generation, details)?,
        None => supervisor.register_session(session_id, project, epic, generation)?,
    };
    replicator.on_registered(&snapshot);
    Ok(snapshot)
}

/// Drives one state transition, e.g. `to_state = "HANDOFF_REQUESTED"`.
/// Illegal transitions return an error (and land on the audit log as ALERT
/// rows); they never panic.
///
/// Testing affordance: this drives supervisor STATE only, never processes —
/// manually transitioning a live session to `KILLED` does not kill its PTY,
/// so the terminal keeps running, orphaned from the state machine.
#[tauri::command]
pub fn samurai_transition(
    supervisor: State<'_, Arc<Supervisor>>,
    session_id: u32,
    to_state: String,
) -> Result<SessionSnapshot, String> {
    let to: SupervisorState = to_state.parse()?;
    supervisor.transition(session_id, to)
}

/// Snapshots of every supervised session, ordered by session id.
#[tauri::command]
pub fn samurai_list_sessions(supervisor: State<'_, Arc<Supervisor>>) -> Vec<SessionSnapshot> {
    supervisor.list_sessions()
}

/// Every pending resume timer, all projects (issue #61; PRD §9 park
/// countdown — Phase 4's Files section reads it too). Seeds the frontend's
/// schedule state; live updates ride the `samurai-schedule-event` channel
/// (full current list on every arm/cancel/fire — see `lib.rs`).
#[tauri::command]
pub fn samurai_schedule_list(schedule: State<'_, Arc<SamuraiSchedule>>) -> Vec<ScheduleEntry> {
    schedule.list()
}

/// Reads a project's audit rows — optionally only those strictly after
/// `since_ts` (RFC 3339), optionally only the last `tail` of those — plus the
/// current audit file size in bytes.
#[tauri::command]
pub async fn samurai_audit_read(
    audit: State<'_, AuditLog>,
    project_path: String,
    tail: Option<usize>,
    since_ts: Option<String>,
) -> Result<AuditReadResult, String> {
    let project = canonical_project_path(&project_path);
    audit.read(&project, tail, since_ts).await
}

/// Deletes a project's audit log. User-initiated only — nothing in the
/// backend calls this, and there is no automatic trimming (PRD decision #15).
#[tauri::command]
pub async fn samurai_audit_clear(
    audit: State<'_, AuditLog>,
    project_path: String,
) -> Result<(), String> {
    let project = canonical_project_path(&project_path);
    audit.clear(&project).await
}

// ---------------------------------------------------------------------------
// Issue #63 (P3.5): run launcher — preflight, launch, cleanup, run listing
// ---------------------------------------------------------------------------

/// The `gh auth status` probe's structured result. A failed check is DATA
/// (`ok: false` + why), never a command error — the launcher renders it as a
/// red row, it does not explode.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GhAuthCheck {
    pub ok: bool,
    /// The authenticated `gh` user, when the check passed.
    pub username: Option<String>,
    /// Why the check failed (gh missing, not logged in, runner error).
    pub error: Option<String>,
}

/// Preflight results (PRD §5.8). Two probed checks. Agent-readiness of the
/// epic's issues used to be a third gate — a user checkbox (PRD decision
/// #11) — but a human ticking a box proved no more reliable than not asking:
/// gen-1 now assesses readiness itself as step 1 of its brief
/// (`launch_instruction`), so nothing about it appears here either.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SamuraiPreflight {
    pub gh_auth: GhAuthCheck,
    /// Whether the usage API reports a governing allowance window. `false`
    /// mirrors the `NoGoverningWindow` condition (allowance_watcher.rs):
    /// session AND weekly percent both unreported — or the poll itself
    /// failed/needs auth — means parking cannot govern this run: a
    /// launch-blocking error, not a warning.
    pub windows_reported: bool,
}

/// Folds the `gh auth status` outcome into the structured check.
fn gh_auth_check(auth: Result<AuthStatus, String>) -> GhAuthCheck {
    match auth {
        Ok(status) if status.logged_in => GhAuthCheck {
            ok: true,
            username: status.username,
            error: None,
        },
        Ok(_) => GhAuthCheck {
            ok: false,
            username: None,
            error: Some("gh is not authenticated — run `gh auth login`".to_string()),
        },
        Err(e) => GhAuthCheck {
            ok: false,
            username: None,
            error: Some(e),
        },
    }
}

/// `true` only when the usage poll succeeded, needs no auth, and at least
/// one governing window (5h session / 7d weekly) is actually reported.
/// `None` percents mean "window not reported", NOT 0% (`commands::usage`).
fn windows_reported(usage: &Result<UsageData, String>) -> bool {
    matches!(
        usage,
        Ok(u) if !u.needs_auth && (u.session_percent.is_some() || u.weekly_percent.is_some())
    )
}

/// Runs both probes. Shared by the preflight command and the launch
/// command's server-side re-check (the UI's earlier pass is advisory only).
async fn run_preflight(project: &str) -> SamuraiPreflight {
    let auth = GitHub::new(project)
        .auth_status()
        .await
        .map_err(|e| e.to_string());
    let usage = get_claude_usage(None).await;
    SamuraiPreflight {
        gh_auth: gh_auth_check(auth),
        windows_reported: windows_reported(&usage),
    }
}

/// Preflight for the launcher UI (PRD §5.8): `gh auth status` + allowance
/// windows reported. Structured pass/fail per check — an `Err` here means
/// the command itself broke, never that a check failed.
#[tauri::command]
pub async fn samurai_preflight(project_path: String) -> Result<SamuraiPreflight, String> {
    let project = canonical_project_path(&project_path);
    Ok(run_preflight(&project).await)
}

/// The epic's dedicated branch: `samurai-<epic_slug>` (PRD §5.9 — one stable
/// worktree per epic; the slug is the same identity the handoff files and run
/// configs use).
///
/// A HYPHEN, not a slash, on purpose. Git stores each branch as a file under
/// `refs/heads/`, so `samurai/38` needs `samurai` to be a DIRECTORY — which
/// is impossible while the repo also has a branch literally named `samurai`.
/// The PRD mandates that staging branch (§9), so the run branches are the
/// side that has to move out of the namespace.
fn epic_branch(epic: &str) -> String {
    format!("samurai-{}", epic_slug(epic))
}

/// Canonical spelling of what the user typed in the launcher's "Issues" field.
///
/// The field accepts an epic ref, ONE issue, or a comma-separated list
/// (`77, 78`) — a run is scoped to a set of issues, and an epic is just the
/// common case where that set is named by one parent. Splitting on commas
/// lets `#77,78` and `#77 , 78` land on the same identity, which matters:
/// this string is the run's key everywhere (branch slug, worktree, handoff
/// filenames, resume timers), so two spellings of one run must not produce
/// two runs. Whitespace inside a single ref is collapsed for the same reason.
fn normalize_epic_ref(epic: &str) -> String {
    epic.split(',')
        .map(|part| part.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The launch refusal matrix, in check order. `None` = clear to launch.
fn launch_refusal(preflight: &SamuraiPreflight, live_session: bool) -> Option<String> {
    if live_session {
        return Some(
            "launch refused: this epic already has a live supervised session — let it finish \
             or clean the epic up first"
                .to_string(),
        );
    }
    if !preflight.gh_auth.ok {
        return Some(format!(
            "launch refused: gh auth check failed — {}",
            preflight
                .gh_auth
                .error
                .as_deref()
                .unwrap_or("not authenticated"),
        ));
    }
    if !preflight.windows_reported {
        return Some(
            "launch refused: the usage API reports no governing allowance window (session and \
             weekly both unreported) — allowance parking cannot govern this run"
                .to_string(),
        );
    }
    None
}

/// Creates — or REUSES — the epic worktree at its STABLE deterministic path
/// (PRD §5.9: reconciliation and resume depend on the path being the same
/// across generations, so never the UUID `force_new` variant). The branch is
/// created from HEAD when missing; a branch already checked out in another
/// worktree means the epic worktree already exists — its path is returned,
/// not an error.
async fn ensure_epic_worktree(
    worktrees: &WorktreeManager,
    project: &str,
    branch: &str,
    base_override: Option<&Path>,
) -> Result<PathBuf, String> {
    let repo = PathBuf::from(project);
    let git = Git::new(&repo);
    let branches = git
        .list_branches()
        .await
        .map_err(|e| format!("could not list branches in {project}: {e}"))?;
    if !branches.iter().any(|b| !b.is_remote && b.name == branch) {
        git.create_branch(branch, None)
            .await
            .map_err(|e| format!("could not create branch {branch}: {e}"))?;
    }
    // Checked out in the MAIN worktree (someone explored the branch by
    // hand): `worktree add` then needs --force — the
    // `prepare_session_worktree` precedent.
    let branch_in_main = git.current_branch().await.ok().as_deref() == Some(branch);
    match worktrees
        .create_with_base(branch, &repo, base_override, branch_in_main)
        .await
    {
        Ok(path) => Ok(path),
        // REUSE, not an error: the guard's payload carries where the epic
        // worktree already lives.
        Err(GitError::BranchAlreadyCheckedOut { path, .. }) => Ok(PathBuf::from(path)),
        Err(e) => Err(format!("could not create the epic worktree: {e}")),
    }
}

/// What a successful launch set up — echoed to the launcher UI.
#[derive(Debug, Clone, Serialize)]
pub struct SamuraiLaunchResult {
    pub epic: String,
    pub branch: String,
    pub worktree_path: String,
    pub repo_pin: Option<String>,
    /// Review F5: a stale resume timer from the epic's previous run was
    /// found and cancelled before this launch.
    pub stale_timer_cancelled: bool,
}

/// The gen-1 opening brief: the launch instruction (carrying the run's
/// compiled workflow section, issue #91) plus the issue-#72 journaling
/// rider, so the first orchestrator records its own friction in the ops
/// journal (PRD §5.12). The journal path is resolved at this call site per
/// the P5.1 contract (`default_journal_file`); a single space joins the two
/// single-line instructions, keeping the brief one paste-able line.
fn launch_brief(epic: &str, repo_pin: Option<&str>, workflow: &WorkflowGraph) -> String {
    format!(
        "{} {}",
        samurai_prompts::launch_instruction(epic, repo_pin, &samurai_workflow::compile(workflow)),
        samurai_prompts::journal_instruction(&default_journal_file()),
    )
}

/// The launch sequence after preflight, extracted from the Tauri command for
/// testability (the `cleanup_epic_inner` precedent; `preflight` is passed in
/// so tests never hit gh or the usage API, `worktree_base` exists only so
/// tests never touch the real app-data worktree base).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn launch_run_inner(
    supervisor: &Supervisor,
    schedule: &SamuraiSchedule,
    worktrees: &WorktreeManager,
    run_configs: &RunConfigStore,
    replicator: &Arc<SamuraiReplicator>,
    audit: &AuditLog,
    test_gate: &SamuraiTestGate,
    skip_test_gate: bool,
    preflight: &SamuraiPreflight,
    global_config: SamuraiConfig,
    project: &str,
    epic: &str,
    model: Option<String>,
    handoff_context_pct: Option<f64>,
    workflow: Option<WorkflowGraph>,
    worktree_base: Option<&Path>,
) -> Result<SamuraiLaunchResult, String> {
    let epic = normalize_epic_ref(epic);
    if epic.is_empty() {
        return Err("an epic reference is required".to_string());
    }
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());

    // The refusal matrix runs server-side regardless of what the UI showed.
    let live_session = supervisor.list_sessions().iter().any(|s| {
        s.project == project && epic_slug(&s.epic) == epic_slug(&epic) && !s.state.is_terminal()
    });
    if let Some(refusal) = launch_refusal(preflight, live_session) {
        return Err(refusal);
    }

    // Review F4: the one per-run threshold the UI exposes — a launch-time
    // `handoff_context_pct` override stores the GLOBAL config with that one
    // field replaced; empty = None = global applies. Validated before any
    // side effect below.
    let thresholds = handoff_context_pct.map(|pct| SamuraiConfig {
        handoff_context_pct: pct,
        ..global_config
    });
    if let Some(t) = &thresholds {
        t.validate()?;
    }

    // Review F5: a stale resume timer from the epic's PREVIOUS run must not
    // survive the relaunch — left armed it would fire into the fresh run
    // and double-spawn a generation. After the refusal matrix on purpose: a
    // refused launch must not touch the old run's state. Cancelled by SLUG,
    // not exact string — a relaunch typed as "38" must still cancel a timer
    // armed under "#38": every other surface (config, worktree, handoffs)
    // unifies spellings via epic_slug, and the timer must not be the one
    // holdout that lets a second orchestrator spawn into the worktree.
    let mut stale_timer_cancelled = false;
    for entry in schedule.list() {
        if entry.project_path == project && epic_slug(&entry.epic) == epic_slug(&epic) {
            stale_timer_cancelled |= schedule.cancel(&entry.project_path, &entry.epic)?;
        }
    }
    if stale_timer_cancelled {
        log::info!(
            "samurai launch: cancelled a stale resume timer for epic {epic} in {project} before relaunch"
        );
    }

    let branch = epic_branch(&epic);
    let worktree = ensure_epic_worktree(worktrees, project, &branch, worktree_base).await?;
    let worktree_path = strip_extended_prefix(&worktree.to_string_lossy()).to_string();

    // Issue #90b: the test-suite gate — bootstrap the epic worktree, then
    // `cargo test --workspace` inside it; red = launch blocked (the skip
    // toggle is the explicit override, and it bypasses the bootstrap too).
    // ORDERING IS THE CRASH-SAFETY: the gate runs BEFORE the ACTIVE run
    // config reaches disk, and cold-start reconciliation only iterates
    // ACTIVE configs — so a red gate or a crash mid-gate leaves nothing for
    // reconciliation to respawn into a half-bootstrapped worktree. The
    // leftover worktree itself is the launcher's existing
    // crash-before-config-write case: cleanup removes it by stable path.
    if skip_test_gate {
        log::info!("samurai launch: test-suite gate SKIPPED by user for epic {epic} in {project}");
    } else if let Err(failure) = test_gate
        .run(project, &epic, Path::new(&worktree_path))
        .await
    {
        // The block is a durable audit fact (ALERT, the reconciler's
        // account-wide convention: generation 0, session 0), not just a
        // transient UI error.
        audit.append(
            project,
            AuditEvent::now(
                &epic,
                AuditEventKind::Alert,
                0,
                0,
                json!({
                    "kind": "launch_test_gate",
                    "phase": failure.kind.as_str(),
                    "error": failure.message,
                }),
            ),
        );
        return Err(failure.message);
    }

    // The `--repo` pin from the worktree's origin remote (PRD §10: gen-1
    // runs with --dangerously-skip-permissions). Blocking git → blocking
    // pool; an unparseable remote yields None and the brief carries its
    // caution instead — never a blocked launch.
    let pin_dir = PathBuf::from(worktree_path.clone());
    let repo_pin = tokio::task::spawn_blocking(move || derive_repo_pin(&pin_dir))
        .await
        .unwrap_or(None);

    // P3.4 contract: the ACTIVE config reaches disk BEFORE gen-1 spawns —
    // but only AFTER the test gate passed (issue #90b), so a blocked launch
    // persists nothing. A crash between the write and the spawn leaves a
    // config cold-start reconciliation flags as reconcile_unstartable — the
    // human relaunches (accepted).
    // Issue #91: the run's workflow graph — the UI's edited graph, or the
    // default template when the launch names none — SNAPSHOTTED into the
    // run config, so successor and recovery briefs recompile exactly this
    // workflow after every handoff.
    let workflow = workflow.unwrap_or_default();
    let mut config =
        SamuraiRunConfig::new(project.to_string(), epic.clone(), worktree_path.clone());
    config.repo_pin = repo_pin.clone();
    config.model = model;
    config.thresholds = thresholds;
    config.workflow = Some(workflow.clone());
    run_configs.save(&config)?;

    let instruction = launch_brief(&epic, repo_pin.as_deref(), &workflow);
    replicator.spawn_first_generation(project, &epic, &worktree_path, instruction);

    log::info!(
        "samurai launch: epic {epic} launched in {project} — worktree {worktree_path}, branch {branch}, pin {repo_pin:?}"
    );
    Ok(SamuraiLaunchResult {
        epic,
        branch,
        worktree_path,
        repo_pin,
        stale_timer_cancelled,
    })
}

/// Launches an epic run (PRD §5.8, §12 T+0): server-side preflight →
/// create/reuse the epic worktree → test-suite gate in that worktree
/// (issue #90b; `skip_test_gate` is the user's explicit override, progress
/// streams as `samurai-test-gate-event`) → derive the `--repo` pin → write
/// the ACTIVE run config → spawn gen-1 with its opening brief. The SPAWN
/// audit row lands via the existing registration path with
/// `details.trigger: "launch"`.
// Every `State` parameter is Tauri's dependency injection: the macro resolves
// them by type, so they cannot be bundled into one struct without losing it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn samurai_launch_run(
    app: AppHandle,
    supervisor: State<'_, Arc<Supervisor>>,
    schedule: State<'_, Arc<SamuraiSchedule>>,
    worktrees: State<'_, WorktreeManager>,
    run_configs: State<'_, Arc<RunConfigStore>>,
    replicator: State<'_, Arc<SamuraiReplicator>>,
    audit: State<'_, AuditLog>,
    config: State<'_, SharedSamuraiConfig>,
    project_path: String,
    epic: String,
    model: Option<String>,
    handoff_context_pct: Option<f64>,
    skip_test_gate: Option<bool>,
    workflow: Option<WorkflowGraph>,
) -> Result<SamuraiLaunchResult, String> {
    let project = canonical_project_path(&project_path);
    let preflight = run_preflight(&project).await;
    let global_config = config
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    // The real gate: system processes, progress mirrored to the frontend.
    let gate_app = app.clone();
    let test_gate = SamuraiTestGate::new(
        samurai_test_gate::system_runner(),
        Arc::new(move |p: &TestGateProgress| {
            let _ = gate_app.emit("samurai-test-gate-event", p);
        }),
    );
    launch_run_inner(
        &supervisor,
        &schedule,
        &worktrees,
        &run_configs,
        &replicator,
        &audit,
        &test_gate,
        skip_test_gate.unwrap_or(false),
        &preflight,
        global_config,
        &project,
        &epic,
        model,
        handoff_context_pct,
        workflow,
        None,
    )
    .await
}

/// The DEFAULT workflow graph (issue #91) — the single source of truth for
/// the launcher UI's reset-to-default, and the exact template a launch
/// without an explicit graph snapshots into its run config. Pure data.
#[tauri::command]
pub fn samurai_default_workflow() -> WorkflowGraph {
    WorkflowGraph::default()
}

/// Every unarchived run config across all projects — the launcher panel's
/// runs list: ACTIVE (live) plus COMPLETED (issue #96 — verified finished,
/// awaiting the manual cleanup that archives it).
#[tauri::command]
pub fn samurai_list_runs(run_configs: State<'_, Arc<RunConfigStore>>) -> Vec<SamuraiRunConfig> {
    run_configs.load_unarchived()
}

/// What one cleanup pass removed (PRD §5.9: surfaced in the UI, never
/// silent). Every flag reports "was there something to remove?" — an
/// already-clean epic returns all-false, not an error (idempotence).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SamuraiCleanupReport {
    /// The epic spelling everything was cleaned under (the run config's,
    /// when one existed).
    pub epic: String,
    pub branch: String,
    /// A gen-N spawn was staged but never registered — cancelled here, or it
    /// would have fired into the worktree this cleanup deletes.
    pub spawn_cancelled: bool,
    pub timer_cancelled: bool,
    pub config_archived: bool,
    pub worktree_removed: bool,
    /// The removed worktree's path, when one was removed.
    pub worktree_path: Option<String>,
    pub branch_deleted: bool,
}

/// The cleanup sequence, extracted from the Tauri command for testability
/// (the `prepare_worktree_inner` precedent; `worktree_base` override exists
/// only so tests never touch the real app-data worktree base).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn cleanup_epic_inner(
    supervisor: &Supervisor,
    schedule: &SamuraiSchedule,
    run_configs: &RunConfigStore,
    worktrees: &WorktreeManager,
    replicator: &SamuraiReplicator,
    project: &str,
    epic: &str,
    worktree_base: Option<&Path>,
) -> Result<SamuraiCleanupReport, String> {
    // The config's spelling of the epic is the identity every other surface
    // was registered under (the launcher wrote them all); the store finds it
    // by slug whatever spelling the caller used.
    let config = run_configs.get(project, epic);
    let epic = config
        .as_ref()
        .map(|c| c.epic.as_str())
        .unwrap_or(epic)
        .to_string();

    // Destructive: refuse while any non-terminal supervised session exists
    // for the epic — deleting git state under a live orchestrator is exactly
    // the shared-checkout hazard the worktree isolation kills.
    if let Some(live) = supervisor.list_sessions().into_iter().find(|s| {
        s.project == project && epic_slug(&s.epic) == epic_slug(&epic) && !s.state.is_terminal()
    }) {
        return Err(format!(
            "cleanup refused: epic {epic} still has a live supervised session (session {} is {}) — let it finish, or kill it first",
            live.session_id,
            live.state.as_str(),
        ));
    }

    // 0. Cancel a staged-but-unregistered spawn. The live-session refusal
    //    above only sees SUPERVISED sessions, and a launch the frontend has
    //    not registered yet is invisible to the supervisor while its spawn
    //    event is still being re-emitted (~15 min). Left staged it fires into
    //    the worktree step 3 deletes, and it blocks a relaunch of the epic
    //    until it gives up. Before any deletion, so no re-emit can be armed
    //    once the directory is gone.
    let spawn_cancelled = replicator.cancel_pending_for_epic(project, &epic);

    // 1. Cancel the resume timer — left armed it would respawn the epic
    //    into a deleted worktree. Cancelling twice is not an error (P3.1).
    let timer_cancelled = schedule.cancel(project, &epic)?;

    // 2. Archive the run config (P3.4: an un-archived ACTIVE config makes
    //    cold-start reconciliation respawn the epic forever; a COMPLETED one
    //    — issue #96 — would sit in the runs list forever). Missing or
    //    already ARCHIVED by an earlier pass → reported, not an error.
    let config_archived = match &config {
        Some(c) if c.status != RunConfigStatus::Archived => {
            run_configs.archive(project, &epic)?;
            true
        }
        _ => false,
    };

    // 3. Remove the epic worktree — the config's recorded path when known,
    //    else the stable deterministic path. Already gone → reported (stale
    //    refs still pruned so the branch delete below cannot trip on a
    //    half-removed worktree).
    let repo = PathBuf::from(project);
    let git = Git::new(&repo);
    let branch = epic_branch(&epic);
    let wt_path = match &config {
        Some(c) => PathBuf::from(strip_extended_prefix(&c.worktree_path)),
        None => {
            worktrees
                .worktree_path_with_base(&repo, &branch, worktree_base)
                .await
        }
    };
    let (worktree_removed, worktree_path) = if wt_path.exists() {
        worktrees.remove(&repo, &wt_path).await.map_err(|e| {
            format!(
                "could not remove the epic worktree {}: {e}",
                wt_path.display()
            )
        })?;
        (true, Some(wt_path.display().to_string()))
    } else {
        if let Err(e) = git.worktree_prune().await {
            log::warn!("samurai cleanup: worktree prune failed: {e}");
        }
        (false, None)
    };

    // 4. Delete the samurai-<slug> branch. `-D` on purpose: by the time a
    //    human confirms this destructive cleanup, completed work lives in
    //    PRs on the fork (PRD §5.9/§12). Already gone → reported.
    let branches = git
        .list_branches()
        .await
        .map_err(|e| format!("could not list branches: {e}"))?;
    let branch_deleted = if branches.iter().any(|b| !b.is_remote && b.name == branch) {
        git.delete_branch(&branch, true)
            .await
            .map_err(|e| format!("could not delete branch {branch}: {e}"))?;
        true
    } else {
        false
    };

    log::info!(
        "samurai cleanup: epic {epic} in {project} — spawn_cancelled={spawn_cancelled} timer_cancelled={timer_cancelled} config_archived={config_archived} worktree_removed={worktree_removed} branch_deleted={branch_deleted}"
    );
    Ok(SamuraiCleanupReport {
        epic,
        branch,
        spawn_cancelled,
        timer_cancelled,
        config_archived,
        worktree_removed,
        worktree_path,
        branch_deleted,
    })
}

/// One-click epic cleanup (PRD §5.9): cancel the resume timer, archive the
/// run config, remove the epic worktree, delete the `samurai-<slug>` branch.
/// Refuses while a live supervised session exists; idempotent otherwise —
/// already-gone pieces are reported in the [`SamuraiCleanupReport`], never
/// errors. The UI confirms before calling (destructive, never silent).
#[tauri::command]
pub async fn samurai_cleanup_epic(
    supervisor: State<'_, Arc<Supervisor>>,
    schedule: State<'_, Arc<SamuraiSchedule>>,
    run_configs: State<'_, Arc<RunConfigStore>>,
    worktrees: State<'_, WorktreeManager>,
    replicator: State<'_, Arc<SamuraiReplicator>>,
    project_path: String,
    epic: String,
) -> Result<SamuraiCleanupReport, String> {
    let project = canonical_project_path(&project_path);
    cleanup_epic_inner(
        &supervisor,
        &schedule,
        &run_configs,
        &worktrees,
        &replicator,
        &project,
        &epic,
        None,
    )
    .await
}

// ---------------------------------------------------------------------------
// Issue #65 (P4.1): Second Brain file inventory + guarded delete
// ---------------------------------------------------------------------------

/// The app-data roots the inventory scans — the SAME `artifact_base_dir`
/// kinds the stores are constructed with in `lib.rs` (`audit`, `runs`,
/// `samurai`) plus the Phase 5 journal/harvest dirs (PRD §5.12), which stay
/// empty until that phase writes them.
fn samurai_files_roots() -> SamuraiFilesRoots {
    SamuraiFilesRoots {
        audit_dir: artifact_base_dir("audit"),
        runs_dir: artifact_base_dir("runs"),
        samurai_dir: artifact_base_dir("samurai"),
        journal_dir: artifact_base_dir("journal"),
        harvest_dir: artifact_base_dir("harvest"),
    }
}

/// Every Samurai-managed file (PRD §8) as one flat list: handoffs, run
/// configs (active + archived), pending timers (with their fire time, for
/// the "resumes at 14:32" rendering), per-project audit logs, and Phase 5
/// journal/harvest reports once they exist. `in_use` marks entries
/// referenced by an active run config, a live supervised session, or a
/// pending timer. All logic lives in `core::samurai_files` (unit-tested
/// there); this command only snapshots the managed stores.
#[tauri::command]
pub fn samurai_files_list(
    supervisor: State<'_, Arc<Supervisor>>,
    schedule: State<'_, Arc<SamuraiSchedule>>,
    run_configs: State<'_, Arc<RunConfigStore>>,
) -> Vec<SamuraiFileEntry> {
    samurai_files::list_files(
        &samurai_files_roots(),
        &run_configs.list_with_paths(),
        &schedule.list(),
        &supervisor.list_sessions(),
    )
}

/// Deletes one Samurai-managed file (user-initiated, UI confirms first —
/// PRD §5.11). Refuses any path outside the managed roots this command
/// computed itself (canonicalized, `\\?\`-stripped comparison), and refuses
/// `in_use` files unless `force` is true — that refusal starts with
/// `core::samurai_files::IN_USE_ERROR_PREFIX` (`"IN_USE:"`) so the UI can
/// route it to a harder confirm. `schedule.json` is refused outright, force
/// or not (PRD §8 row 3: it self-cleans, and the in-memory timers would
/// re-persist a raw delete anyway) — cancel timers via
/// [`samurai_timer_cancel`] or the epic cleanup instead.
#[tauri::command]
pub fn samurai_file_delete(
    supervisor: State<'_, Arc<Supervisor>>,
    schedule: State<'_, Arc<SamuraiSchedule>>,
    run_configs: State<'_, Arc<RunConfigStore>>,
    path: String,
    force: bool,
) -> Result<(), String> {
    let roots = samurai_files_roots();
    let configs = run_configs.list_with_paths();
    let entries = samurai_files::list_files(
        &roots,
        &configs,
        &schedule.list(),
        &supervisor.list_sessions(),
    );
    samurai_files::delete_file(&roots, &configs, &entries, &path, force)
}

/// The cancel itself, extracted from the Tauri command for testability (the
/// `cleanup_epic_inner` precedent): the same `SamuraiSchedule::cancel` path
/// cleanup step 1 uses, on its own. Like cleanup, the outcome is logged, not
/// audited — nothing resumed or spawned, so there is no audit row to write.
pub(crate) fn timer_cancel_inner(
    schedule: &SamuraiSchedule,
    project: &str,
    epic: &str,
) -> Result<bool, String> {
    let cancelled = schedule.cancel(project, epic)?;
    log::info!("samurai timer cancel: epic {epic} in {project} — cancelled={cancelled}");
    Ok(cancelled)
}

/// Cancels one epic's pending resume timer (issue #66 review F1 — the Second
/// Brain's per-timer action; the UI confirms first, naming the consequence:
/// the parked run will NOT resume on its own afterwards). `Ok(false)` when
/// nothing was armed — cancelling twice is not an error (P3.1), matching
/// `SamuraiSchedule::cancel`.
#[tauri::command]
pub fn samurai_timer_cancel(
    schedule: State<'_, Arc<SamuraiSchedule>>,
    project_path: String,
    epic: String,
) -> Result<bool, String> {
    let project = canonical_project_path(&project_path);
    timer_cancel_inner(&schedule, &project, &epic)
}

// ---------------------------------------------------------------------------
// Issue #69 (P5.1): ops journal — add + list
// ---------------------------------------------------------------------------

/// Adds one user-authored ops-journal entry (PRD §5.12). The optional
/// project is canonicalized at this boundary like every samurai command.
/// There is deliberately no agent parameter — agents append their entries
/// to the JSONL directly from shell prompts; this command is the user/UI
/// path, so `agent` stays unset.
#[tauri::command]
pub fn samurai_journal_add(
    journal: State<'_, Arc<JournalStore>>,
    category: JournalCategory,
    text: String,
    project: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("journal entry text must not be empty".to_string());
    }
    let project = project.map(|p| canonical_project_path(&p));
    journal.append_entry(&JournalEntry::now(category, text, project, None))
}

/// The active journal (`journal.jsonl`) — every entry with its consumption
/// status derived from the harvest markers, newest last, plus the file size
/// (the `samurai_audit_read` reporting convention). All logic lives in
/// `core::samurai_journal` (unit-tested there); this command only reads.
#[tauri::command]
pub fn samurai_journal_list(
    journal: State<'_, Arc<JournalStore>>,
) -> Result<JournalListResult, String> {
    journal.list()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_audit::AuditLog;
    use crate::core::windows_process::StdCommandExt;
    use tempfile::tempdir;

    // --- pure decisions ---

    fn auth(logged_in: bool, username: Option<&str>) -> AuthStatus {
        AuthStatus {
            logged_in,
            username: username.map(str::to_string),
            scopes: vec![],
        }
    }

    #[test]
    fn test_gh_auth_check_table() {
        // Logged in: ok + username, no error.
        let check = gh_auth_check(Ok(auth(true, Some("nachogl1"))));
        assert_eq!(
            check,
            GhAuthCheck {
                ok: true,
                username: Some("nachogl1".to_string()),
                error: None
            }
        );
        // gh ran but says logged out: structured failure, actionable hint.
        let check = gh_auth_check(Ok(auth(false, None)));
        assert!(!check.ok);
        assert!(check.error.as_deref().unwrap().contains("gh auth login"));
        // Runner error (gh missing, timeout): the failure text is the data.
        let check = gh_auth_check(Err("GitHub CLI (gh) not found".to_string()));
        assert!(!check.ok);
        assert_eq!(check.username, None);
        assert_eq!(check.error.as_deref(), Some("GitHub CLI (gh) not found"));
    }

    #[test]
    fn test_windows_reported_table() {
        let usage = |session: Option<f64>, weekly: Option<f64>, needs_auth: bool| UsageData {
            session_percent: session,
            weekly_percent: weekly,
            needs_auth,
            ..UsageData::default()
        };
        // Either governing window present → reported.
        assert!(windows_reported(&Ok(usage(Some(10.0), None, false))));
        assert!(windows_reported(&Ok(usage(None, Some(50.0), false))));
        assert!(windows_reported(&Ok(usage(Some(0.0), Some(0.0), false))));
        // Both None = the NoGoverningWindow condition — a launch BLOCKER
        // (None means "window not reported", never 0%).
        assert!(!windows_reported(&Ok(usage(None, None, false))));
        // needs_auth / errored polls are data gaps, not evidence: blocked.
        assert!(!windows_reported(&Ok(usage(Some(10.0), None, true))));
        assert!(!windows_reported(&Err("network error".to_string())));
    }

    fn preflight(gh_ok: bool, windows: bool) -> SamuraiPreflight {
        SamuraiPreflight {
            gh_auth: GhAuthCheck {
                ok: gh_ok,
                username: gh_ok.then(|| "nachogl1".to_string()),
                error: (!gh_ok).then(|| "not authenticated".to_string()),
            },
            windows_reported: windows,
        }
    }

    #[test]
    fn test_launch_refusal_matrix() {
        // All gates pass → clear to launch.
        assert_eq!(launch_refusal(&preflight(true, true), false), None);
        // Each failing gate refuses with its own reason, in check order.
        let live = launch_refusal(&preflight(true, true), true).unwrap();
        assert!(live.contains("live supervised session"));
        let no_auth = launch_refusal(&preflight(false, true), false).unwrap();
        assert!(no_auth.contains("gh auth"));
        assert!(no_auth.contains("not authenticated"));
        let no_window = launch_refusal(&preflight(true, false), false).unwrap();
        assert!(no_window.contains("no governing allowance window"));
        // A live session outranks everything (destructive-adjacent first).
        let both = launch_refusal(&preflight(false, false), true).unwrap();
        assert!(both.contains("live supervised session"));
    }

    #[test]
    fn test_epic_branch_shape() {
        assert_eq!(epic_branch("#38"), "samurai-38");
        assert_eq!(epic_branch("Epic 12: Auth"), "samurai-epic-12-auth");
        // The empty-ref fallback still yields a legal branch name.
        assert_eq!(epic_branch(""), "samurai-epic");
        // A comma-separated list is one run, so it is one branch.
        assert_eq!(epic_branch("77, 78"), "samurai-77-78");
    }

    #[test]
    fn test_normalize_epic_ref_collapses_spellings_of_one_run() {
        // A single ref is just trimmed and internally collapsed.
        assert_eq!(normalize_epic_ref("  #38  "), "#38");
        assert_eq!(normalize_epic_ref("Epic  12:\tAuth"), "Epic 12: Auth");
        // Every spelling of the same list lands on one identity — otherwise
        // the same two issues could be launched twice as two separate runs.
        for spelling in ["77,78", "77, 78", " 77 ,  78 ", "77,,78", "77, 78,"] {
            assert_eq!(
                normalize_epic_ref(spelling),
                "77, 78",
                "spelling: {spelling}"
            );
        }
        // Empty stays empty so the caller's "epic required" check still fires.
        assert_eq!(normalize_epic_ref("   ,  , "), "");
    }

    #[test]
    fn test_launch_brief_is_launch_instruction_plus_journal_rider() {
        // Issue #72: the composed gen-1 brief = the unmodified launch
        // instruction, then the journaling rider, one paste-able line.
        let workflow = WorkflowGraph::default();
        let brief = launch_brief("#38", Some("nachogl1/maestro"), &workflow);
        let launch = samurai_prompts::launch_instruction(
            "#38",
            Some("nachogl1/maestro"),
            &samurai_workflow::compile(&workflow),
        );
        assert!(
            brief.starts_with(&launch),
            "launch text must ride first, unmodified"
        );
        assert!(brief.contains("journal.jsonl"));
        for category in ["BOTTLENECK", "ERROR", "IMPROVEMENT", "SKILL", "CONCERN"] {
            assert!(
                brief.contains(&format!("\"{category}\"")),
                "missing category {category}"
            );
        }
        assert!(brief.contains("NEVER rewrite or delete existing lines"));
        assert!(!brief.contains('\n'), "brief must stay a single line");
    }

    #[test]
    fn test_launch_brief_carries_the_compiled_workflow_section() {
        // Issue #91: the gen-1 brief embeds the graph it is launched with —
        // an edited node text reaches the compiled section verbatim.
        let mut workflow = WorkflowGraph::default();
        workflow
            .nodes
            .iter_mut()
            .find(|n| n.id == "review")
            .unwrap()
            .text = "Custom review ritual".to_string();
        let brief = launch_brief("#38", None, &workflow);
        assert!(
            brief.contains("WORKFLOW — the process for this run"),
            "{brief}"
        );
        assert!(brief.contains("Step 2: Custom review ritual"), "{brief}");
        assert!(brief.contains("END OF WORKFLOW"), "{brief}");
        assert!(!brief.contains('\n'), "brief must stay a single line");
    }

    #[test]
    fn test_default_workflow_command_returns_the_template() {
        // The UI's reset-to-default has ONE source of truth.
        assert_eq!(samurai_default_workflow(), WorkflowGraph::default());
    }

    // --- worktree + cleanup (tempfile git fixtures) ---

    /// `git init` + one commit; identity is repo-local (the sibling suites'
    /// fixture).
    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .hide_console_window()
                .output()
                .expect("git must be runnable in tests");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("tracked.txt"), "v1\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-q", "-m", "init"]);
    }

    /// Commits extra fixture files (paths may be nested) so the launched
    /// epic worktree contains them — the test gate detects its bootstrap
    /// steps from files in the WORKTREE, not the repo.
    fn commit_fixture_files(dir: &Path, files: &[(&str, &str)]) {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .hide_console_window()
                .output()
                .expect("git must be runnable in tests");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        for (name, content) in files {
            let path = dir.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, content).unwrap();
            run(&["add", name]);
        }
        run(&["commit", "-q", "-m", "fixture files"]);
    }

    /// A test gate whose runner records `"program args…"` per call and
    /// answers from a per-command-prefix script; unscripted commands
    /// succeed with empty output. Progress emission is discarded — the
    /// event payloads have their own suite in `core::samurai_test_gate`.
    fn recording_gate(
        script: Vec<(
            &'static str,
            crate::core::samurai_test_gate::GateCommandOutput,
        )>,
    ) -> (SamuraiTestGate, Arc<std::sync::Mutex<Vec<String>>>) {
        use crate::core::samurai_test_gate::{GateCommandOutput, GateCommandRunner};
        let calls: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls_rec = calls.clone();
        let runner: GateCommandRunner = Arc::new(move |_cwd, program, args| {
            let call = format!("{program} {}", args.join(" "));
            calls_rec.lock().unwrap().push(call.clone());
            for (prefix, out) in &script {
                if call.starts_with(prefix) {
                    return Ok(out.clone());
                }
            }
            Ok(GateCommandOutput {
                success: true,
                stdout: String::new(),
                stderr: String::new(),
            })
        });
        (SamuraiTestGate::new(runner, Arc::new(|_| {})), calls)
    }

    #[tokio::test]
    async fn test_ensure_epic_worktree_creates_then_reuses_the_stable_path() {
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let base = tempdir().unwrap();
        let worktrees = WorktreeManager::new();
        let project = repo.path().to_string_lossy().into_owned();

        // First launch: the branch is created from HEAD and the worktree
        // lands at the stable deterministic path under the base.
        let first = ensure_epic_worktree(&worktrees, &project, "samurai-38", Some(base.path()))
            .await
            .unwrap();
        assert!(first.exists());
        assert!(first.starts_with(base.path()));

        // Relaunch: REUSE — same path, no error (reconciliation depends on
        // path stability, PRD §5.9).
        let second = ensure_epic_worktree(&worktrees, &project, "samurai-38", Some(base.path()))
            .await
            .unwrap();
        assert_eq!(first, second);
    }

    /// Everything cleanup (and the gated launch) needs, rooted in tempdirs.
    struct CleanupHarness {
        supervisor: Arc<Supervisor>,
        schedule: Arc<SamuraiSchedule>,
        replicator: Arc<SamuraiReplicator>,
        spawns: Arc<std::sync::Mutex<Vec<crate::core::samurai_replicator::SuccessorSpawn>>>,
        run_configs: RunConfigStore,
        worktrees: WorktreeManager,
        audit: AuditLog,
        project: String,
        _dirs: (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir),
        base: tempfile::TempDir,
        repo: tempfile::TempDir,
    }

    /// A replicator wired to inert collaborators — enough for the staging /
    /// cancellation paths the launch and cleanup suites exercise. Returns the
    /// spawn-event sink so a test can assert on what was (not) emitted.
    fn test_replicator(
        supervisor: Arc<Supervisor>,
        audit: AuditLog,
    ) -> (
        Arc<SamuraiReplicator>,
        Arc<std::sync::Mutex<Vec<crate::core::samurai_replicator::SuccessorSpawn>>>,
    ) {
        use crate::core::samurai_injector::SessionDirResolver;
        use crate::core::samurai_replicator::{
            EnterResender, SessionTeardown, StdinWriter, SuccessorEmitter, SuccessorSpawn,
            TranscriptPathResolver,
        };
        use std::sync::{Mutex, RwLock};

        let spawns: Arc<Mutex<Vec<SuccessorSpawn>>> = Arc::new(Mutex::new(Vec::new()));
        let spawns_rec = spawns.clone();
        let emit_spawn: SuccessorEmitter =
            Arc::new(move |s| spawns_rec.lock().unwrap().push(s.clone()));
        let session_dirs: SessionDirResolver = Arc::new(|_| None);
        let transcript_paths: TranscriptPathResolver = Arc::new(|_| None);
        let teardown: SessionTeardown = Arc::new(|_| Box::pin(async {}));
        let write_stdin: StdinWriter = Arc::new(|_, _| {});
        let resend_enter: EnterResender = Arc::new(|_| {});
        let shared: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let replicator = Arc::new(SamuraiReplicator::new(
            supervisor,
            audit,
            shared,
            session_dirs,
            transcript_paths,
            teardown,
            emit_spawn,
            write_stdin,
            resend_enter,
        ));
        (replicator, spawns)
    }

    fn cleanup_harness() -> CleanupHarness {
        let audit_dir = tempdir().unwrap();
        let schedule_dir = tempdir().unwrap();
        let runs_dir = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let (audit, task) = AuditLog::new(audit_dir.path().to_path_buf(), None);
        tokio::spawn(task);
        let (schedule, _task) =
            SamuraiSchedule::new(schedule_dir.path().to_path_buf(), Arc::new(|_| {}), None);
        let project = repo.path().to_string_lossy().into_owned();
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let (replicator, spawns) = test_replicator(supervisor.clone(), audit.clone());
        CleanupHarness {
            supervisor,
            schedule,
            replicator,
            spawns,
            run_configs: RunConfigStore::new(runs_dir.path().to_path_buf()),
            worktrees: WorktreeManager::new(),
            audit,
            project,
            _dirs: (audit_dir, schedule_dir, runs_dir),
            base: tempdir().unwrap(),
            repo,
        }
    }

    /// Launch through the harness with an all-green preflight and the
    /// global default config — the gate and skip flag are what varies.
    async fn run_launch(
        h: &CleanupHarness,
        gate: &SamuraiTestGate,
        skip_test_gate: bool,
        epic: &str,
    ) -> Result<SamuraiLaunchResult, String> {
        launch_run_inner(
            &h.supervisor,
            &h.schedule,
            &h.worktrees,
            &h.run_configs,
            &h.replicator,
            &h.audit,
            gate,
            skip_test_gate,
            &preflight(true, true),
            SamuraiConfig::default(),
            &h.project,
            epic,
            None,
            None,
            None,
            Some(h.base.path()),
        )
        .await
    }

    async fn run_cleanup(h: &CleanupHarness, epic: &str) -> Result<SamuraiCleanupReport, String> {
        cleanup_epic_inner(
            &h.supervisor,
            &h.schedule,
            &h.run_configs,
            &h.worktrees,
            &h.replicator,
            &h.project,
            epic,
            Some(h.base.path()),
        )
        .await
    }

    #[tokio::test]
    async fn test_cleanup_removes_everything_then_reports_all_gone() {
        let h = cleanup_harness();
        // A launched epic: worktree at the stable path, ACTIVE config with
        // that path, an armed resume timer.
        let worktree =
            ensure_epic_worktree(&h.worktrees, &h.project, "samurai-38", Some(h.base.path()))
                .await
                .unwrap();
        h.run_configs
            .save(&SamuraiRunConfig::new(
                h.project.clone(),
                "#38",
                worktree.to_string_lossy().into_owned(),
            ))
            .unwrap();
        h.schedule
            .arm(ScheduleEntry {
                project_path: h.project.clone(),
                epic: "#38".to_string(),
                fire_at: "2030-01-01T00:00:00+00:00".to_string(),
                reason: "park".to_string(),
            })
            .unwrap();
        // A terminal leftover session must NOT block cleanup.
        h.supervisor
            .register_session(1, h.project.clone(), "#38".to_string(), 2)
            .unwrap();
        h.supervisor
            .transition(1, SupervisorState::ParkRequested)
            .unwrap();
        h.supervisor.transition(1, SupervisorState::Parked).unwrap();

        // The caller may spell the epic differently ("38" vs "#38"): the
        // slug identity resolves it to the config's spelling.
        let report = run_cleanup(&h, "38").await.unwrap();
        assert_eq!(report.epic, "#38");
        assert_eq!(report.branch, "samurai-38");
        assert!(report.timer_cancelled);
        assert!(report.config_archived);
        assert!(report.worktree_removed);
        assert_eq!(
            report.worktree_path.as_deref(),
            Some(&*worktree.to_string_lossy())
        );
        assert!(report.branch_deleted);

        // The pieces are really gone.
        assert!(!worktree.exists());
        assert!(h.schedule.list().is_empty());
        assert!(h.run_configs.load_active().is_empty(), "config archived");
        let git = Git::new(h.repo.path());
        assert!(
            !git.list_branches()
                .await
                .unwrap()
                .iter()
                .any(|b| b.name == "samurai-38"),
            "branch deleted"
        );

        // Idempotent: a second pass reports nothing left, no errors.
        let again = run_cleanup(&h, "#38").await.unwrap();
        assert!(!again.timer_cancelled);
        assert!(!again.config_archived);
        assert!(!again.worktree_removed);
        assert_eq!(again.worktree_path, None);
        assert!(!again.branch_deleted);
    }

    #[tokio::test]
    async fn test_cleanup_archives_a_completed_config() {
        // Issue #96: a verified-complete run sits COMPLETED until the human
        // cleans it up — that cleanup must archive the config exactly like
        // an ACTIVE one, or the finished run would stay listed forever.
        let h = cleanup_harness();
        h.run_configs
            .save(&SamuraiRunConfig::new(
                h.project.clone(),
                "#38",
                h.base.path().join("gone").to_string_lossy().into_owned(),
            ))
            .unwrap();
        h.run_configs.complete(&h.project, "#38").unwrap();

        let report = run_cleanup(&h, "#38").await.unwrap();
        assert!(report.config_archived);
        assert!(h.run_configs.load_unarchived().is_empty());
    }

    #[tokio::test]
    async fn test_launch_cancels_stale_timer_and_stores_overrides() {
        // Review F5: a relaunch must cancel the previous run's resume timer
        // (left armed it would double-spawn into the fresh run). Review F4:
        // the launch-time model + handoff-% override reach the run config,
        // and the gen-1 spawn event already carries the model.
        use crate::core::samurai_injector::SessionDirResolver;
        use crate::core::samurai_replicator::{
            EnterResender, SessionTeardown, StdinWriter, SuccessorEmitter, SuccessorSpawn,
            TranscriptPathResolver,
        };
        use std::sync::{Arc, Mutex, RwLock};

        let audit_dir = tempdir().unwrap();
        let schedule_dir = tempdir().unwrap();
        let runs_dir = tempdir().unwrap();
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let (audit, task) = AuditLog::new(audit_dir.path().to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let (schedule, _task) =
            SamuraiSchedule::new(schedule_dir.path().to_path_buf(), Arc::new(|_| {}), None);
        let run_configs = RunConfigStore::new(runs_dir.path().to_path_buf());
        let run_configs = Arc::new(run_configs);
        let worktrees = WorktreeManager::new();
        let project = repo.path().to_string_lossy().into_owned();

        let spawns: Arc<Mutex<Vec<SuccessorSpawn>>> = Arc::new(Mutex::new(Vec::new()));
        let spawns_rec = spawns.clone();
        let emit_spawn: SuccessorEmitter =
            Arc::new(move |s| spawns_rec.lock().unwrap().push(s.clone()));
        let session_dirs: SessionDirResolver = Arc::new(|_| None);
        let transcript_paths: TranscriptPathResolver = Arc::new(|_| None);
        let teardown: SessionTeardown = Arc::new(|_| Box::pin(async {}));
        let write_stdin: StdinWriter = Arc::new(|_, _| {});
        let resend_enter: EnterResender = Arc::new(|_| {});
        let shared: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let replicator = Arc::new(SamuraiReplicator::new(
            supervisor.clone(),
            audit.clone(),
            shared,
            session_dirs,
            transcript_paths,
            teardown,
            emit_spawn,
            write_stdin,
            resend_enter,
        ));
        replicator.set_run_configs(run_configs.clone());

        // A stale timer from the epic's previous run — armed under the "#38"
        // spelling while the relaunch below types "38": the cancel must match
        // by slug (re-review F5), not exact string.
        schedule
            .arm(ScheduleEntry {
                project_path: project.clone(),
                epic: "#38".to_string(),
                fire_at: "2030-01-01T00:00:00+00:00".to_string(),
                reason: "park".to_string(),
            })
            .unwrap();

        // The fixture repo has no Cargo.toml, so the gate is skipped here —
        // its own launch behavior has dedicated tests below.
        let (gate, _calls) = recording_gate(vec![]);
        let global = SamuraiConfig::default();
        let result = launch_run_inner(
            &supervisor,
            &schedule,
            &worktrees,
            &run_configs,
            &replicator,
            &audit,
            &gate,
            true,
            &preflight(true, true),
            global.clone(),
            &project,
            "38",
            Some("opus".to_string()),
            Some(30.0),
            None,
            Some(base.path()),
        )
        .await
        .unwrap();

        // F5: the "#38"-spelled timer is gone despite the "38" launch
        // spelling, and the result reports it.
        assert!(result.stale_timer_cancelled);
        assert!(schedule.list().is_empty(), "stale timer cancelled");

        // F4: model + the one-field thresholds override are persisted.
        let config = run_configs.get(&project, "#38").unwrap();
        assert_eq!(config.model.as_deref(), Some("opus"));
        let thresholds = config.thresholds.expect("override stored");
        assert_eq!(thresholds.handoff_context_pct, 30.0);
        assert_eq!(
            thresholds.park_hard_5h_pct, global.park_hard_5h_pct,
            "only handoff_context_pct is replaced — the rest stays global"
        );

        // …and the gen-1 spawn event already carries the model.
        {
            let spawns = spawns.lock().unwrap();
            assert_eq!(spawns.len(), 1);
            assert_eq!(spawns[0].generation, 1);
            assert_eq!(spawns[0].model.as_deref(), Some("opus"));
        }

        // Relaunch without a timer or overrides: nothing cancelled, no
        // thresholds stored (empty = the global config applies).
        let again = launch_run_inner(
            &supervisor,
            &schedule,
            &worktrees,
            &run_configs,
            &replicator,
            &audit,
            &gate,
            true,
            &preflight(true, true),
            global,
            &project,
            "#38",
            None,
            None,
            None,
            Some(base.path()),
        )
        .await
        .unwrap();
        assert!(!again.stale_timer_cancelled);
        assert_eq!(run_configs.get(&project, "#38").unwrap().thresholds, None);
    }

    #[tokio::test]
    async fn test_launch_snapshots_the_workflow_graph_into_the_run_config() {
        // Issue #91: the launch stores the graph it ran with — the caller's
        // edited graph, or the default template when none is given — so
        // successor briefs recompile the SAME workflow after handoffs.
        let h = cleanup_harness();
        let (gate, _calls) = recording_gate(vec![]);

        // No explicit graph → the default template is snapshotted.
        run_launch(&h, &gate, true, "#38").await.unwrap();
        let config = h.run_configs.get(&h.project, "#38").unwrap();
        assert_eq!(config.workflow, Some(WorkflowGraph::default()));

        // An explicit (edited) graph is stored verbatim.
        let mut custom = WorkflowGraph::default();
        custom
            .nodes
            .iter_mut()
            .find(|n| n.id == "review")
            .unwrap()
            .text = "Custom review ritual".to_string();
        launch_run_inner(
            &h.supervisor,
            &h.schedule,
            &h.worktrees,
            &h.run_configs,
            &h.replicator,
            &h.audit,
            &gate,
            true,
            &preflight(true, true),
            SamuraiConfig::default(),
            &h.project,
            "#39",
            None,
            None,
            Some(custom.clone()),
            Some(h.base.path()),
        )
        .await
        .unwrap();
        let config = h.run_configs.get(&h.project, "#39").unwrap();
        assert_eq!(config.workflow, Some(custom));
    }

    // --- issue #90b: the launch test-suite gate ---

    #[tokio::test]
    async fn test_launch_gate_green_bootstraps_then_spawns() {
        // The full maestro-shaped worktree: npm install → mcp build →
        // cargo test, in that order, then the launch proceeds normally.
        let h = cleanup_harness();
        commit_fixture_files(
            h.repo.path(),
            &[
                ("Cargo.toml", "[workspace]\nmembers = []\n"),
                ("package.json", "{}"),
                ("maestro-mcp-server/Cargo.toml", "[package]\n"),
            ],
        );
        let (gate, calls) = recording_gate(vec![]);

        let result = run_launch(&h, &gate, false, "#38").await.unwrap();
        assert_eq!(result.branch, "samurai-38");

        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                "npm install".to_string(),
                "cargo build --release -p maestro-mcp-server".to_string(),
                "cargo test --workspace".to_string(),
            ]
        );
        assert_eq!(h.spawns.lock().unwrap().len(), 1, "gen-1 spawned");
        assert_eq!(h.run_configs.load_active().len(), 1, "ACTIVE config saved");
    }

    #[tokio::test]
    async fn test_launch_gate_red_blocks_spawn_config_and_alerts() {
        let h = cleanup_harness();
        commit_fixture_files(
            h.repo.path(),
            &[("Cargo.toml", "[workspace]\nmembers = []\n")],
        );
        let (gate, calls) = recording_gate(vec![(
            "cargo test",
            crate::core::samurai_test_gate::GateCommandOutput {
                success: false,
                stdout: "test result: FAILED. 40 passed; 2 failed; 0 ignored\n".to_string(),
                stderr: String::new(),
            },
        )]);

        let err = run_launch(&h, &gate, false, "#38").await.unwrap_err();
        assert!(err.contains("launch blocked"), "{err}");
        assert!(
            err.contains("test result: FAILED. 40 passed; 2 failed"),
            "the failing summary line must surface: {err}"
        );

        // Blocked means BLOCKED: no gen-1 spawn, and no ACTIVE config for
        // cold-start reconciliation to respawn into the worktree (the
        // config write is ordered AFTER the gate on purpose).
        assert!(h.spawns.lock().unwrap().is_empty(), "no gen-1 spawn");
        assert!(h.run_configs.load_active().is_empty(), "no ACTIVE config");

        // …and the block is a durable ALERT audit row.
        let read = h.audit.read(&h.project, None, None).await.unwrap();
        let alert = read
            .events
            .iter()
            .find(|e| e.event == AuditEventKind::Alert)
            .expect("an ALERT row records the block");
        assert_eq!(alert.epic, "#38");
        assert_eq!(alert.details["kind"], "launch_test_gate");
        assert_eq!(alert.details["phase"], "red_suite");

        // No package.json in the fixture → the suite was the only command.
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["cargo test --workspace".to_string()]
        );
    }

    #[tokio::test]
    async fn test_launch_gate_skip_bypasses_gate_and_bootstrap_entirely() {
        // No Cargo.toml anywhere — an armed gate would block this repo.
        // Skip must not even probe: no bootstrap, no commands at all.
        let h = cleanup_harness();
        let (gate, calls) = recording_gate(vec![]);

        let result = run_launch(&h, &gate, true, "#38").await.unwrap();
        assert_eq!(result.epic, "#38");
        assert!(calls.lock().unwrap().is_empty(), "no gate command ran");
        assert_eq!(h.spawns.lock().unwrap().len(), 1, "gen-1 spawned");
        assert_eq!(h.run_configs.load_active().len(), 1, "ACTIVE config saved");
    }

    #[tokio::test]
    async fn test_launch_gate_bootstrap_failure_blocks_with_distinct_error() {
        let h = cleanup_harness();
        commit_fixture_files(
            h.repo.path(),
            &[
                ("Cargo.toml", "[workspace]\nmembers = []\n"),
                ("package.json", "{}"),
            ],
        );
        let (gate, calls) = recording_gate(vec![(
            "npm install",
            crate::core::samurai_test_gate::GateCommandOutput {
                success: false,
                stdout: String::new(),
                stderr: "npm ERR! network timeout\n".to_string(),
            },
        )]);

        let err = run_launch(&h, &gate, false, "#38").await.unwrap_err();
        assert!(
            err.contains("bootstrap failed at `npm install`"),
            "a broken bootstrap is its own error, not a red suite: {err}"
        );
        assert!(err.contains("npm ERR! network timeout"), "{err}");
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["npm install".to_string()],
            "the suite never ran"
        );
        assert!(h.spawns.lock().unwrap().is_empty());
        assert!(h.run_configs.load_active().is_empty());
        let read = h.audit.read(&h.project, None, None).await.unwrap();
        let alert = read
            .events
            .iter()
            .find(|e| e.event == AuditEventKind::Alert)
            .expect("an ALERT row records the block");
        assert_eq!(alert.details["kind"], "launch_test_gate");
        assert_eq!(alert.details["phase"], "bootstrap");
    }

    #[test]
    fn test_timer_cancel_cancels_only_the_named_epic() {
        // Review F1: the per-timer cancel must remove exactly the one
        // (project, epic) timer — every other project's and epic's timer
        // stays armed and persisted.
        let dir = tempdir().unwrap();
        let (schedule, _task) =
            SamuraiSchedule::new(dir.path().to_path_buf(), Arc::new(|_| {}), None);
        for (project, epic) in [
            ("C:/git/alpha", "#38"),
            ("C:/git/alpha", "#40"),
            ("C:/git/beta", "#38"),
        ] {
            schedule
                .arm(ScheduleEntry {
                    project_path: project.to_string(),
                    epic: epic.to_string(),
                    fire_at: "2030-01-01T00:00:00+00:00".to_string(),
                    reason: "park".to_string(),
                })
                .unwrap();
        }

        assert!(timer_cancel_inner(&schedule, "C:/git/alpha", "#38").unwrap());

        let mut left: Vec<(String, String)> = schedule
            .list()
            .into_iter()
            .map(|e| (e.project_path, e.epic))
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                ("C:/git/alpha".to_string(), "#40".to_string()),
                ("C:/git/beta".to_string(), "#38".to_string()),
            ]
        );

        // Cancelling twice is not an error — it just reports nothing armed.
        assert!(!timer_cancel_inner(&schedule, "C:/git/alpha", "#38").unwrap());
    }

    #[tokio::test]
    async fn test_cleanup_cancels_a_staged_but_unregistered_spawn() {
        // The live-session refusal only sees SUPERVISED sessions. A launch
        // the frontend never registered is invisible to it, but the
        // replicator keeps re-emitting its spawn event for ~15 min — into a
        // worktree this cleanup is about to delete. Cleanup must cancel it.
        let h = cleanup_harness();
        let worktree =
            ensure_epic_worktree(&h.worktrees, &h.project, "samurai-38", Some(h.base.path()))
                .await
                .unwrap();
        h.run_configs
            .save(&SamuraiRunConfig::new(
                h.project.clone(),
                "#38",
                worktree.to_string_lossy().into_owned(),
            ))
            .unwrap();
        h.replicator.spawn_first_generation(
            &h.project,
            "#38",
            &worktree.to_string_lossy(),
            "opening brief".to_string(),
        );
        assert_eq!(
            h.spawns.lock().unwrap().len(),
            1,
            "gen-1 staged and emitted"
        );

        // Cleaned up under a DIFFERENT spelling than it was staged with: the
        // cancel matches by slug, like every other surface.
        let report = run_cleanup(&h, "38").await.unwrap();
        assert!(report.spawn_cancelled, "the staged gen-1 was cancelled");
        assert!(report.worktree_removed);

        // …and the re-emit ladder is really gone: no further spawn events for
        // an epic whose worktree no longer exists.
        h.replicator.tick();
        assert_eq!(
            h.spawns.lock().unwrap().len(),
            1,
            "no re-emit into the deleted worktree"
        );

        // Idempotent: a second pass has nothing left to cancel.
        let again = run_cleanup(&h, "#38").await.unwrap();
        assert!(!again.spawn_cancelled);
    }

    #[tokio::test]
    async fn test_cleanup_refuses_while_a_live_session_exists() {
        let h = cleanup_harness();
        h.run_configs
            .save(&SamuraiRunConfig::new(
                h.project.clone(),
                "#38",
                h.base.path().to_string_lossy().into_owned(),
            ))
            .unwrap();
        h.supervisor
            .register_session(1, h.project.clone(), "#38".to_string(), 1)
            .unwrap();

        let err = run_cleanup(&h, "#38").await.unwrap_err();
        assert!(err.contains("live supervised session"), "{err}");
        // Nothing was touched: the config is still ACTIVE.
        assert_eq!(h.run_configs.load_active().len(), 1);
    }

    #[tokio::test]
    async fn test_cleanup_without_a_config_still_cleans_by_stable_path() {
        // The crash-before-config-write case: no run config, but the
        // launcher's worktree and branch exist at the deterministic path.
        let h = cleanup_harness();
        let worktree =
            ensure_epic_worktree(&h.worktrees, &h.project, "samurai-38", Some(h.base.path()))
                .await
                .unwrap();

        let report = run_cleanup(&h, "#38").await.unwrap();
        assert!(!report.config_archived);
        assert!(report.worktree_removed);
        assert!(report.branch_deleted);
        assert!(!worktree.exists());
    }
}
