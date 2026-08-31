/*!
Night runs: driving ACT's intake loop from Vanguard, on a schedule.

The loop is ACT's ScrumMaster (the `/api/scrum-master` routes), which is what `act
start` runs as a daemon. Four controls travel with it — check interval, the
GitHub label the intake pulls from, the agent cap, and the autonomy rung the
ladder is set to before anything spawns.

The SCHEDULE lives here rather than in the webview, because the Factory is an
overlay that spends most of its life unmounted and a window that only ticks
while a panel is on screen is a window that quietly never fires. ACT's own
`workingHours` cannot express an overnight window either — its check is
`hour < start || hour >= end`, which is every hour of the day once start is
23:00 — so the fork owns the clock and ACT is told plainly to start and stop.

Two rules carried over from the engine supervisor next door:
- The schedule only stops a loop the schedule started. A loop someone else
  started is left alone, and the panel says so.
- An unreachable ACT is a normal state. The window, its settings and last
  night's outcomes are local facts that stay on screen regardless.
*/

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Local, NaiveDateTime, TimeZone, Timelike};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use super::act::{client, endpoint, failure_with_body, truthy_string, with_act_token};
use super::act_control::{act_get_policy, act_set_autonomy, count, dashboard_get, flag, ActAutonomyInput};
use super::act_engine::{ActEngineState, EngineState};

pub const MINUTES_IN_DAY: u32 = 1440;

/// How often the schedule looks at the clock. Half a minute is fine grain for
/// a window measured in hours, and cheap: a tick outside the window costs
/// nothing but a comparison.
const TICK: Duration = Duration::from_secs(30);

/// How many outcomes to keep. Enough to cover several nights, so "did last
/// night run?" is answerable without a log file.
const OUTCOME_LIMIT: usize = 20;

const INTERVAL_MINUTES: (u32, u32) = (1, 240);
const MAX_AGENTS: (u32, u32) = (1, 10);

/// What Vanguard hands ACT when it starts the loop, plus the window itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NightRunSettings {
    /// ACT's `pollInterval`, in minutes rather than the wire's milliseconds.
    pub interval_minutes: u32,
    /// GitHub issue label the intake pulls from; empty means every issue.
    pub label: String,
    /// ACT's `maxConcurrentAgents`.
    pub max_agents: u32,
    /// Applied to ACT's autonomy ladder before the loop starts.
    pub autonomy: String,
    pub window_enabled: bool,
    /// Local minutes past midnight. `stop` before `start` crosses midnight.
    pub start_minute: u32,
    pub stop_minute: u32,
}

impl Default for NightRunSettings {
    fn default() -> Self {
        Self {
            interval_minutes: 5,
            label: String::new(),
            max_agents: 2,
            autonomy: "L1".to_string(),
            window_enabled: false,
            start_minute: 23 * 60,
            stop_minute: 6 * 60,
        }
    }
}

impl NightRunSettings {
    /// Clamp on the way in. These bounds are the fork's, not ACT's: ACT takes
    /// a 0-minute interval or a 50-agent cap without complaint and then
    /// behaves in ways nobody asked for at three in the morning.
    fn clamped(mut self) -> Self {
        self.interval_minutes = self.interval_minutes.clamp(INTERVAL_MINUTES.0, INTERVAL_MINUTES.1);
        self.max_agents = self.max_agents.clamp(MAX_AGENTS.0, MAX_AGENTS.1);
        self.start_minute %= MINUTES_IN_DAY;
        self.stop_minute %= MINUTES_IN_DAY;
        self.label = self.label.trim().to_string();
        if !matches!(self.autonomy.as_str(), "L0" | "L1" | "L2") {
            self.autonomy = "L1".to_string();
        }
        self
    }
}

/// ACT's `/api/scrum-master/status`, normalized.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NightRunLoop {
    pub is_running: bool,
    pub active_agents: u32,
    pub pending_tasks: u32,
    pub in_progress_tasks: u32,
    pub completed_today: u32,
    pub blocked_tasks: u32,
    pub last_check: Option<String>,
    pub next_check: Option<String>,
}

/// One thing the schedule (or the user) did, kept so a silent night shows up
/// as a row rather than as an absence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NightRunOutcome {
    pub at: String,
    pub action: String,
    pub scheduled: bool,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NightRunView {
    pub settings: NightRunSettings,
    /// None when ACT did not answer this read; `loop_error` says why.
    pub r#loop: Option<NightRunLoop>,
    pub loop_error: Option<String>,
    /// Last successful loop read, ms epoch; 0 = never.
    pub fetched_at: i64,
    pub in_window: bool,
    pub next_start_at: Option<String>,
    pub next_stop_at: Option<String>,
    /// True when the schedule started what is running, and so may stop it.
    pub schedule_owns_loop: bool,
    /// Newest first.
    pub outcomes: Vec<NightRunOutcome>,
}

/// What the schedule believes about the loop right now. Kept in memory only:
/// after a restart the schedule re-derives it from ACT rather than assuming
/// it still owns a loop it may no longer have anything to do with.
#[derive(Debug, Clone, PartialEq, Default)]
enum Phase {
    /// Outside the window, or nothing attempted yet.
    #[default]
    Idle,
    /// The schedule started this loop, so the schedule may stop it.
    Owned,
    /// A loop was already running when the window opened. Left alone.
    Foreign,
    /// The window is open and the loop could not be started. The reason is
    /// kept so the same failure is recorded once, not twice a minute.
    Failed(String),
    /// Stopped by hand inside the window: the schedule does not restart it
    /// until the next window.
    Suppressed,
}

#[derive(Debug, Default)]
struct Runtime {
    phase: Phase,
    /// Whether the loop actually ran at some point in the current window.
    /// Without this, a window that ends in a failed restart is indistinguish-
    /// able from a window where nothing ever started.
    ran_this_window: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Persisted {
    settings: NightRunSettings,
    outcomes: Vec<NightRunOutcome>,
}

#[derive(Default)]
pub struct NightRunState {
    persisted: Mutex<Persisted>,
    runtime: Mutex<Runtime>,
    fetched_at: Mutex<i64>,
}

fn state_path() -> Option<PathBuf> {
    Some(
        BaseDirs::new()?
            .home_dir()
            .join(".maestro")
            .join("night-run.json"),
    )
}

/// Temp file + rename, same discipline as the band snapshot: the schedule is
/// re-read at every launch and a half-written file would lose the window.
fn write_state(path: &Path, persisted: &Persisted) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(persisted).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

impl NightRunState {
    /// Read the saved window at startup. A missing or unreadable file is a
    /// fresh install, not an error: defaults leave the window off.
    pub fn load() -> Self {
        let persisted = state_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|body| serde_json::from_str::<Persisted>(&body).ok())
            .unwrap_or_default();
        Self {
            persisted: Mutex::new(Persisted {
                settings: persisted.settings.clamped(),
                outcomes: persisted.outcomes,
            }),
            ..Default::default()
        }
    }

    fn settings(&self) -> NightRunSettings {
        self.persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .settings
            .clone()
    }

    fn set_settings(&self, settings: NightRunSettings) {
        let mut guard = self.persisted.lock().unwrap_or_else(PoisonError::into_inner);
        guard.settings = settings;
        persist(&guard);
    }

    fn outcomes(&self) -> Vec<NightRunOutcome> {
        self.persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .outcomes
            .clone()
    }

    fn record(&self, action: &str, scheduled: bool, ok: bool, detail: String) {
        log::info!("night run: {action} (scheduled={scheduled}, ok={ok}): {detail}");
        let mut guard = self.persisted.lock().unwrap_or_else(PoisonError::into_inner);
        guard.outcomes.insert(
            0,
            NightRunOutcome {
                at: Local::now().to_rfc3339(),
                action: action.to_string(),
                scheduled,
                ok,
                detail,
            },
        );
        guard.outcomes.truncate(OUTCOME_LIMIT);
        persist(&guard);
    }

    fn phase(&self) -> Phase {
        self.runtime
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .phase
            .clone()
    }

    fn set_phase(&self, phase: Phase) {
        self.runtime.lock().unwrap_or_else(PoisonError::into_inner).phase = phase;
    }

    /// Enter the "the loop is up and it is ours" state.
    fn own(&self) {
        let mut guard = self.runtime.lock().unwrap_or_else(PoisonError::into_inner);
        guard.phase = Phase::Owned;
        guard.ran_this_window = true;
    }

    fn ran_this_window(&self) -> bool {
        self.runtime
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .ran_this_window
    }

    fn reset_window(&self) {
        let mut guard = self.runtime.lock().unwrap_or_else(PoisonError::into_inner);
        guard.phase = Phase::Idle;
        guard.ran_this_window = false;
    }

    fn fetched_at(&self) -> i64 {
        *self.fetched_at.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn mark_fetched(&self) {
        *self.fetched_at.lock().unwrap_or_else(PoisonError::into_inner) =
            Local::now().timestamp_millis();
    }
}

/// Best effort by design: losing the window to a read-only home directory is
/// worth a log line, never a failed start.
fn persist(persisted: &Persisted) {
    let Some(path) = state_path() else { return };
    if let Err(error) = write_state(&path, persisted) {
        log::warn!("night run: could not save {}: {error}", path.display());
    }
}

// ---------------------------------------------------------------------------
// Schedule maths
// ---------------------------------------------------------------------------

/// Whether a local minute-of-day falls inside the window. A window whose stop
/// is before its start crosses midnight, which is the normal case here.
///
/// A zero-length window (start == stop) never opens. That is the shape a slip
/// of the finger produces, and a loop that runs unattended for 24 hours is a
/// worse answer to a typo than one that does not run at all.
pub fn in_window(now_minute: u32, start_minute: u32, stop_minute: u32) -> bool {
    if start_minute == stop_minute {
        return false;
    }
    if start_minute < stop_minute {
        now_minute >= start_minute && now_minute < stop_minute
    } else {
        now_minute >= start_minute || now_minute < stop_minute
    }
}

/// How long the window lasts, counting across the day boundary.
pub fn window_length_minutes(start_minute: u32, stop_minute: u32) -> u32 {
    (stop_minute + MINUTES_IN_DAY - start_minute) % MINUTES_IN_DAY
}

/// The next occurrence of a time of day, strictly after `now`.
pub fn next_occurrence(now: NaiveDateTime, minute: u32) -> NaiveDateTime {
    let minute = minute % MINUTES_IN_DAY;
    let candidate = now
        .date()
        .and_hms_opt(minute / 60, minute % 60, 0)
        .unwrap_or(now);
    if candidate > now {
        candidate
    } else {
        candidate + ChronoDuration::days(1)
    }
}

/// A local wall-clock instant as RFC 3339.
///
/// The hour that does not exist on a spring-forward night has no local
/// instant; rather than report "not scheduled", shift past the gap. The
/// window itself still opens on the tick that sees the clock inside it, so
/// this only affects the countdown the panel prints.
fn local_instant(naive: NaiveDateTime) -> Option<String> {
    let resolve = |value: NaiveDateTime| Local.from_local_datetime(&value).earliest();
    resolve(naive)
        .or_else(|| resolve(naive + ChronoDuration::hours(1)))
        .map(|instant: DateTime<Local>| instant.to_rfc3339())
}

fn minute_of_day(now: &DateTime<Local>) -> u32 {
    now.time().num_seconds_from_midnight() / 60
}

/// The three schedule facts the panel renders: are we inside, when does the
/// next window open, when does the current or next one shut.
fn schedule_facts(
    settings: &NightRunSettings,
    now: &DateTime<Local>,
) -> (bool, Option<String>, Option<String>) {
    if !settings.window_enabled
        || window_length_minutes(settings.start_minute, settings.stop_minute) == 0
    {
        return (false, None, None);
    }
    let inside = in_window(minute_of_day(now), settings.start_minute, settings.stop_minute);
    let naive = now.naive_local();
    (
        inside,
        local_instant(next_occurrence(naive, settings.start_minute)),
        local_instant(next_occurrence(naive, settings.stop_minute)),
    )
}

// ---------------------------------------------------------------------------
// Talking to ACT
// ---------------------------------------------------------------------------

fn normalize_loop(raw: &Value) -> NightRunLoop {
    NightRunLoop {
        is_running: flag(raw.get("isRunning")),
        active_agents: count(raw.get("activeAgents")),
        pending_tasks: count(raw.get("pendingTasks")),
        in_progress_tasks: count(raw.get("inProgressTasks")),
        completed_today: count(raw.get("completedToday")),
        blocked_tasks: count(raw.get("blockedTasks")),
        last_check: truthy_string(raw.get("lastCheck")),
        next_check: truthy_string(raw.get("nextCheck")),
    }
}

async fn read_loop() -> Result<NightRunLoop, String> {
    let payload = dashboard_get(&["api", "scrum-master", "status"], &[]).await?;
    Ok(normalize_loop(&payload))
}

async fn post(segments: &[&str], body: Value) -> Result<(), String> {
    let url = endpoint(segments)?;
    let response = with_act_token(client()?.post(url))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(failure_with_body(response).await);
    }
    Ok(())
}

/// The ScrumMaster config four controls turn into. Pure, so the mapping is
/// testable without an engine: this is the only place the fork's vocabulary
/// (interval, label, max) meets ACT's.
pub fn start_body(settings: &NightRunSettings) -> Value {
    // An empty label means "every issue", which is what `github: true` asks
    // for. A label narrows the intake to issues carrying it.
    let github = if settings.label.is_empty() {
        json!(true)
    } else {
        json!({ "labels": [settings.label] })
    };
    json!({
        "pollInterval": settings.interval_minutes as u64 * 60_000,
        "maxConcurrentAgents": settings.max_agents,
        // Continuous, self-refilling and auto-spawning: a night run that
        // stops at the end of the first queue is not a night run.
        "continuousMode": true,
        "autoAssign": true,
        "autoSpawn": true,
        "autoRefillQueue": true,
        "keepAlive": true,
        "autoDiscovery": { "github": github, "branches": true, "docs": true },
    })
}

fn started_detail(settings: &NightRunSettings) -> String {
    let scope = if settings.label.is_empty() {
        "every open issue".to_string()
    } else {
        format!("issues labelled {}", settings.label)
    };
    format!(
        "Checking every {}m at {}, up to {} agent(s), taking {scope}.",
        settings.interval_minutes, settings.autonomy, settings.max_agents
    )
}

/// Start the loop: autonomy first, then the loop itself.
///
/// The ladder is set before anything spawns and a failed ladder write aborts
/// the start. Running a night at whatever rung was left over — possibly one
/// that auto-merges — because a policy write quietly failed is the one
/// outcome worth refusing outright.
async fn start_loop(settings: &NightRunSettings) -> Result<String, String> {
    let current = act_get_policy().await.map_err(|error| {
        format!("Could not read the current policy ({error}), so the loop was not started.")
    })?;
    act_set_autonomy(ActAutonomyInput {
        default: settings.autonomy.clone(),
        classes: current.autonomy.classes,
        l2_sample_rate: current.autonomy.l2_sample_rate,
        human_sample_rate: current.autonomy.human_sample_rate,
        allow_all_classes: current.autonomy.allow_all_classes,
        direct_merge: current.autonomy.direct_merge,
    })
    .await
    .map_err(|error| {
        format!(
            "Autonomy could not be set to {} ({error}), so the loop was not started.",
            settings.autonomy
        )
    })?;
    post(&["api", "scrum-master", "start"], start_body(settings)).await?;
    Ok(started_detail(settings))
}

async fn stop_loop() -> Result<(), String> {
    post(&["api", "scrum-master", "stop"], json!({})).await
}

/// Bring the engine up if it is not answering. A window that opens onto a
/// dead ACT is exactly the silent night this feature exists to prevent, and
/// the supervisor next door already refuses to race an ACT it did not start.
async fn ensure_engine(app: &AppHandle) -> Result<bool, String> {
    let status = super::act_engine::act_engine_status(app.state::<ActEngineState>()).await?;
    if status.state == EngineState::Live {
        return Ok(false);
    }
    super::act_engine::act_engine_start(app.state::<ActEngineState>()).await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/// Open the window: adopt a running loop, or start one.
async fn open_window(app: &AppHandle, state: &NightRunState, settings: &NightRunSettings) {
    let previous_failure = match state.phase() {
        // Ours and believed up: check it is still running. A loop that died
        // at 01:00 must not read as a night that ran.
        Phase::Owned => {
            match read_loop().await {
                Ok(status) if !status.is_running => {
                    state.record(
                        "start",
                        true,
                        false,
                        "The loop stopped inside the window; restarting it.".to_string(),
                    );
                    None
                }
                // Unreachable ACT is not proof the loop stopped: try again on
                // the next tick rather than restarting on a guess.
                _ => return,
            }
        }
        // Someone else's loop, or stopped by hand: both mean hands off until
        // the window closes.
        Phase::Foreign | Phase::Suppressed => return,
        Phase::Failed(reason) => Some(reason),
        Phase::Idle => None,
    };

    let mut engine_note = String::new();
    match read_loop().await {
        Ok(status) if status.is_running => {
            state.set_phase(Phase::Foreign);
            state.record(
                "start",
                true,
                true,
                "The loop was already running, so the schedule left it alone — and will not stop it."
                    .to_string(),
            );
            return;
        }
        Ok(_) => {}
        Err(read_error) => match ensure_engine(app).await {
            Ok(true) => engine_note = " ACT was down, so Vanguard started it first.".to_string(),
            Ok(false) => {}
            Err(engine_error) => {
                fail(state, previous_failure, format!("{read_error}. Starting ACT failed too: {engine_error}"));
                return;
            }
        },
    }

    match start_loop(settings).await {
        Ok(detail) => {
            state.own();
            state.record("start", true, true, format!("{detail}{engine_note}"));
        }
        Err(error) => fail(state, previous_failure, error),
    }
}

/// Record a failure once per distinct reason. The window retries every tick,
/// and an unreachable ACT would otherwise write the same row 120 times a
/// night and bury the outcome that matters.
fn fail(state: &NightRunState, previous: Option<String>, reason: String) {
    if previous.as_deref() != Some(reason.as_str()) {
        state.record("start", true, false, reason.clone());
    }
    state.set_phase(Phase::Failed(reason));
}

/// Close the window: stop what the schedule started, and say plainly when a
/// window went by without the loop ever running.
async fn close_window(state: &NightRunState) {
    match state.phase() {
        Phase::Owned => match stop_loop().await {
            Ok(()) => {
                state.record("stop", true, true, "The window closed.".to_string());
                state.reset_window();
            }
            Err(error) => {
                // Stay Owned so the next tick tries again: a loop left
                // running past its window is the failure to keep chasing.
                state.record("stop", true, false, format!("The window closed but ACT would not stop the loop: {error}"));
            }
        },
        Phase::Failed(reason) => {
            let detail = if state.ran_this_window() {
                format!("The window closed. The loop stopped early and could not be restarted: {reason}")
            } else {
                format!("The window closed and the loop never started: {reason}")
            };
            state.record("stop", true, false, detail);
            state.reset_window();
        }
        Phase::Foreign => {
            // Not ours to stop, but a loop that outlives its window costs
            // tokens all day. Say it once, on the way out, rather than
            // leaving it to be noticed on the bill.
            if matches!(read_loop().await, Ok(status) if status.is_running) {
                state.record(
                    "stop",
                    true,
                    false,
                    "The window closed, but the loop still running is not one the schedule started, so it was left alone. Stop it here if that was not deliberate."
                        .to_string(),
                );
            }
            state.reset_window();
        }
        Phase::Suppressed | Phase::Idle => state.reset_window(),
    }
}

async fn tick(app: &AppHandle, state: &NightRunState) {
    let settings = state.settings();
    if !settings.window_enabled {
        state.reset_window();
        return;
    }
    let now = Local::now();
    if in_window(minute_of_day(&now), settings.start_minute, settings.stop_minute) {
        open_window(app, state, &settings).await;
    } else {
        close_window(state).await;
    }
}

/// Spawn the schedule.
///
/// The first tick is deliberately one interval late: launching the app should
/// not immediately spawn an ACT process before the window has been looked at
/// once. A machine that sleeps through the start of a window opens it on the
/// first tick after waking, late but recorded, rather than skipping the night.
pub fn spawn_night_run_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + TICK, TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let state = app.state::<NightRunState>();
            tick(&app, &state).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async fn build_view(state: &NightRunState) -> NightRunView {
    let settings = state.settings();
    let (r#loop, loop_error) = match read_loop().await {
        Ok(status) => {
            state.mark_fetched();
            (Some(status), None)
        }
        Err(error) => (None, Some(error)),
    };
    let (in_window, next_start_at, next_stop_at) = schedule_facts(&settings, &Local::now());
    NightRunView {
        settings,
        r#loop,
        loop_error,
        fetched_at: state.fetched_at(),
        in_window,
        next_start_at,
        next_stop_at,
        schedule_owns_loop: state.phase() == Phase::Owned,
        outcomes: state.outcomes(),
    }
}

/// Never fails as a whole: the schedule and its history are local facts, and
/// a down ACT only empties the `loop` field.
#[tauri::command]
pub async fn night_run_status(state: State<'_, NightRunState>) -> Result<NightRunView, String> {
    Ok(build_view(&state).await)
}

#[tauri::command]
pub async fn night_run_save_settings(
    settings: NightRunSettings,
    state: State<'_, NightRunState>,
) -> Result<NightRunView, String> {
    state.set_settings(settings.clamped());
    Ok(build_view(&state).await)
}

/// Start now, with whatever is on screen — saved as part of starting, so the
/// window that fires tonight is the one the user just pressed the button on.
///
/// A hand-started loop is NOT adopted by the schedule: the schedule stops
/// only what it started. The panel says so rather than surprising anyone at
/// six in the morning.
#[tauri::command]
pub async fn night_run_start(
    settings: NightRunSettings,
    state: State<'_, NightRunState>,
) -> Result<NightRunView, String> {
    let settings = settings.clamped();
    state.set_settings(settings.clone());
    match start_loop(&settings).await {
        Ok(detail) => {
            state.set_phase(Phase::Foreign);
            state.record("start", false, true, detail);
        }
        Err(error) => state.record("start", false, false, error),
    }
    Ok(build_view(&state).await)
}

#[tauri::command]
pub async fn night_run_stop(state: State<'_, NightRunState>) -> Result<NightRunView, String> {
    match stop_loop().await {
        Ok(()) => {
            // Inside a window, a hand stop has to stick: without this the
            // next tick would start the loop again half a minute later.
            state.set_phase(Phase::Suppressed);
            state.record("stop", false, true, "Stopped by hand.".to_string());
        }
        Err(error) => state.record("stop", false, false, error),
    }
    Ok(build_view(&state).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 8, 28)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    /* The case the whole feature turns on. An overnight window runs from one
       day into the next, and every naive start < now < stop comparison gets
       it backwards — which reads as a window that silently never fires. */
    #[test]
    fn an_overnight_window_is_open_on_both_sides_of_midnight() {
        let (start, stop) = (23 * 60, 6 * 60);
        assert!(in_window(23 * 60, start, stop), "the minute it opens");
        assert!(in_window(23 * 60 + 30, start, stop), "before midnight");
        assert!(in_window(0, start, stop), "midnight itself");
        assert!(in_window(5 * 60 + 59, start, stop), "the minute before it shuts");
    }

    #[test]
    fn an_overnight_window_is_shut_through_the_working_day() {
        let (start, stop) = (23 * 60, 6 * 60);
        assert!(!in_window(6 * 60, start, stop), "the minute it shuts");
        assert!(!in_window(12 * 60, start, stop));
        assert!(!in_window(22 * 60 + 59, start, stop));
    }

    #[test]
    fn a_same_day_window_still_works() {
        let (start, stop) = (9 * 60, 17 * 60);
        assert!(in_window(9 * 60, start, stop));
        assert!(in_window(16 * 60, start, stop));
        assert!(!in_window(8 * 60 + 59, start, stop));
        assert!(!in_window(17 * 60, start, stop));
    }

    #[test]
    fn a_zero_length_window_never_opens() {
        assert!(!in_window(10 * 60, 10 * 60, 10 * 60));
        assert!(!in_window(3 * 60, 10 * 60, 10 * 60));
        assert_eq!(window_length_minutes(10 * 60, 10 * 60), 0);
    }

    #[test]
    fn a_window_is_measured_across_the_day_boundary() {
        assert_eq!(window_length_minutes(23 * 60, 6 * 60), 420);
        assert_eq!(window_length_minutes(9 * 60, 17 * 60), 480);
        assert_eq!(window_length_minutes(23 * 60 + 30, 0), 30);
    }

    #[test]
    fn the_next_start_is_tonight_when_tonight_is_still_ahead() {
        assert_eq!(next_occurrence(at(20, 0), 23 * 60), at(23, 0));
    }

    /* Getting this backwards is how a schedule ends up permanently five
       minutes away from firing. */
    #[test]
    fn the_next_start_rolls_to_tomorrow_once_tonights_has_passed() {
        assert_eq!(
            next_occurrence(at(23, 30), 23 * 60),
            at(23, 0) + ChronoDuration::days(1)
        );
        assert_eq!(
            next_occurrence(at(2, 0), 23 * 60),
            at(23, 0),
            "02:00 is already past midnight, so tonight's 23:00 is later today"
        );
        assert_eq!(next_occurrence(at(2, 0), 6 * 60), at(6, 0));
    }

    #[test]
    fn the_next_occurrence_of_now_is_a_full_day_away() {
        assert_eq!(next_occurrence(at(6, 0), 6 * 60), at(6, 0) + ChronoDuration::days(1));
    }

    /* Inside an overnight window the countdown has to point at this
       morning's stop, not tomorrow's. */
    #[test]
    fn inside_an_overnight_window_the_stop_is_the_one_a_few_hours_away() {
        let settings = NightRunSettings {
            window_enabled: true,
            start_minute: 23 * 60,
            stop_minute: 6 * 60,
            ..Default::default()
        };
        let now = Local
            .from_local_datetime(&at(1, 0))
            .earliest()
            .expect("01:00 exists");
        let (inside, next_start, next_stop) = schedule_facts(&settings, &now);
        assert!(inside);
        assert!(next_stop.expect("a stop").starts_with("2026-08-28T06:00"));
        assert!(
            next_start.expect("a start").starts_with("2026-08-28T23:00"),
            "the next start is tonight, not the one that already fired"
        );
    }

    #[test]
    fn a_window_that_is_off_schedules_nothing() {
        let settings = NightRunSettings::default();
        let now = Local
            .from_local_datetime(&at(1, 0))
            .earliest()
            .expect("01:00 exists");
        assert_eq!(schedule_facts(&settings, &now), (false, None, None));
    }

    #[test]
    fn the_four_controls_become_acts_own_config_keys() {
        let body = start_body(&NightRunSettings {
            interval_minutes: 5,
            label: "night-run".to_string(),
            max_agents: 3,
            ..Default::default()
        });
        assert_eq!(body["pollInterval"], json!(300_000));
        assert_eq!(body["maxConcurrentAgents"], json!(3));
        assert_eq!(body["autoDiscovery"]["github"]["labels"], json!(["night-run"]));
        assert_eq!(body["continuousMode"], json!(true));
    }

    #[test]
    fn no_label_means_every_issue_rather_than_none() {
        let body = start_body(&NightRunSettings::default());
        assert_eq!(body["autoDiscovery"]["github"], json!(true));
    }

    #[test]
    fn settings_are_clamped_to_what_a_night_can_survive() {
        let clamped = NightRunSettings {
            interval_minutes: 0,
            max_agents: 99,
            autonomy: "L9".to_string(),
            label: "  night-run  ".to_string(),
            start_minute: 25 * 60,
            ..Default::default()
        }
        .clamped();
        assert_eq!(clamped.interval_minutes, INTERVAL_MINUTES.0);
        assert_eq!(clamped.max_agents, MAX_AGENTS.1);
        assert_eq!(clamped.autonomy, "L1");
        assert_eq!(clamped.label, "night-run");
        assert_eq!(clamped.start_minute, 60);
    }

    /* `loop` is a Rust keyword and the field carries a raw identifier. The
       frontend reads `view.loop`, so pin the name the wire actually uses. */
    #[test]
    fn the_view_serializes_the_loop_field_under_its_plain_name() {
        let view = NightRunView {
            settings: NightRunSettings::default(),
            r#loop: Some(normalize_loop(&json!({ "isRunning": true }))),
            loop_error: None,
            fetched_at: 0,
            in_window: false,
            next_start_at: None,
            next_stop_at: None,
            schedule_owns_loop: false,
            outcomes: Vec::new(),
        };
        let wire = serde_json::to_value(&view).expect("serialize");
        assert_eq!(wire["loop"]["isRunning"], json!(true));
        assert_eq!(wire["settings"]["intervalMinutes"], json!(5));
    }

    #[test]
    fn a_missing_status_field_reads_as_zero_rather_than_a_failed_read() {
        let status = normalize_loop(&json!({ "isRunning": true, "pendingTasks": 4 }));
        assert!(status.is_running);
        assert_eq!(status.pending_tasks, 4);
        assert_eq!(status.active_agents, 0);
        assert_eq!(status.last_check, None);
    }

    #[test]
    fn saved_settings_survive_a_round_trip_through_the_state_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("night-run.json");
        let persisted = Persisted {
            settings: NightRunSettings {
                window_enabled: true,
                label: "night-run".to_string(),
                ..Default::default()
            },
            outcomes: vec![NightRunOutcome {
                at: "2026-08-28T23:00:00+01:00".to_string(),
                action: "start".to_string(),
                scheduled: true,
                ok: true,
                detail: "Checking every 5m".to_string(),
            }],
        };
        write_state(&path, &persisted).expect("write");
        let read: Persisted =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parse");
        assert!(read.settings.window_enabled);
        assert_eq!(read.settings.label, "night-run");
        assert_eq!(read.outcomes.len(), 1);
    }

    /* An older state file predates fields added later; it must load as a
       window rather than as a fresh install with the window off. */
    #[test]
    fn an_older_state_file_keeps_the_window_it_knew_about() {
        let persisted: Persisted =
            serde_json::from_str(r#"{"settings":{"windowEnabled":true,"startMinute":1320}}"#)
                .expect("parse");
        assert!(persisted.settings.window_enabled);
        assert_eq!(persisted.settings.start_minute, 1320);
        assert_eq!(persisted.settings.max_agents, NightRunSettings::default().max_agents);
        assert!(persisted.outcomes.is_empty());
    }
}
