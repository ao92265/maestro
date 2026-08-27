/*!
Supervises the ACT process Maestro talks to.

The Factory lane could always *read* ACT (see `act.rs`), but nothing could
start it: the badge said OFFLINE and the empty state said "Start it, then
refresh", which assumed Alex knew which of several checkouts was the real one.
Maestro now owns that process — contract edge 6 in the ecosystem's
INTEGRATION-CONTRACTS.md, which also makes Maestro responsible for stopping it
on quit so no orphan is left holding the port.

Only a process Maestro spawned is ever killed here. An ACT someone started in a
terminal shows as live and unmanaged, and Start refuses rather than racing it
for the port.
*/

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::process::{Child, Command};

/// A health probe has to be short: it runs on every status poll, and a hung
/// socket must never freeze the badge.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long Start waits for the port to answer before it gives up and says so.
const STARTUP_GRACE: Duration = Duration::from_secs(45);
const PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// What the badge shows. Deliberately three states, not two: "starting" is the
/// window where the process exists but the port has not answered yet, and
/// collapsing it into offline is what made the old badge feel broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    NotRunning,
    Starting,
    Live,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    /// True only when this Maestro spawned the process that is answering.
    pub managed: bool,
    /// Where the engine was launched from, so the UI can say which ACT is live.
    pub directory: Option<String>,
    /// Plain-English reason when something is wrong. Never a raw error dump.
    pub detail: Option<String>,
}

#[derive(Default)]
pub struct ActEngineState {
    child: Mutex<Option<Child>>,
    directory: Mutex<Option<PathBuf>>,
}

impl ActEngineState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Health beats bookkeeping: if the port answers, the engine is live whoever
/// owns it. A tracked child that is not answering yet is still starting.
pub fn classify(has_child: bool, health_ok: bool) -> EngineState {
    if health_ok {
        EngineState::Live
    } else if has_child {
        EngineState::Starting
    } else {
        EngineState::NotRunning
    }
}

/// `MAESTRO_ACT_DIR` wins so a second checkout can be driven without touching
/// the PATH. Otherwise derive the repo from the resolved `act` executable,
/// which lives at `<repo>/bin/act.js`.
pub fn resolve_act_dir(env_dir: Option<&str>, act_bin: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = env_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    act_bin
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

/// Prefer the built server; fall back to the npm script, which builds first.
pub fn server_command(dist_exists: bool) -> (&'static str, Vec<&'static str>) {
    if dist_exists {
        ("node", vec!["dist/dashboard-api/server.js"])
    } else {
        ("npm", vec!["run", "serve"])
    }
}

/// Ask the port whether anything is home. Any failure is a no, never an error
/// the UI has to render: an absent ACT is a normal state.
async fn health_ok() -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() else {
        return false;
    };
    let url = format!("{}/api/health", super::act::base_url());
    matches!(client.get(url).send().await, Ok(response) if response.status().is_success())
}

/// Where `act` lives when the PATH cannot be trusted. An app launched from
/// Finder inherits a minimal PATH with neither Homebrew prefix on it, so
/// looking only at `which` would make the Start button work from a terminal
/// and silently fail from the Dock.
const ACT_FALLBACK_BINS: [&str; 2] = ["/opt/homebrew/bin/act", "/usr/local/bin/act"];

/// Follow `act` on the PATH to the checkout it actually runs. Symlinks matter
/// here: the global command is usually an npm link into a working tree, and
/// the link target is the answer to "which ACT is this".
async fn act_bin_on_path() -> Option<PathBuf> {
    let output = Command::new("/usr/bin/which")
        .arg("act")
        .stderr(Stdio::null())
        .output()
        .await
        .ok();
    let from_path = output
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|path| !path.is_empty());

    let candidates = from_path
        .into_iter()
        .chain(ACT_FALLBACK_BINS.iter().map(|path| path.to_string()));
    candidates.filter_map(|path| std::fs::canonicalize(path).ok()).next()
}

async fn engine_dir() -> Option<PathBuf> {
    let env_dir = std::env::var("MAESTRO_ACT_DIR").ok();
    let bin = act_bin_on_path().await;
    resolve_act_dir(env_dir.as_deref(), bin.as_deref())
}

/// Drop the handle if the child has already exited, so a crashed engine stops
/// reporting as "starting" forever.
fn reap(state: &ActEngineState) -> bool {
    let mut slot = state.child.lock().unwrap();
    if let Some(child) = slot.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => {
                *slot = None;
                false
            }
            Ok(None) => true,
        }
    } else {
        false
    }
}

fn recorded_dir(state: &ActEngineState) -> Option<String> {
    state
        .directory
        .lock()
        .unwrap()
        .as_ref()
        .map(|dir| dir.display().to_string())
}

async fn status_now(state: &ActEngineState) -> EngineStatus {
    let has_child = reap(state);
    let live = health_ok().await;
    let engine_state = classify(has_child, live);
    let directory = match recorded_dir(state) {
        Some(dir) => Some(dir),
        None => engine_dir().await.map(|dir| dir.display().to_string()),
    };
    let detail = match engine_state {
        EngineState::Live if !has_child => {
            Some("Answering on its port, started outside Vanguard.".to_string())
        }
        EngineState::Live => None,
        EngineState::Starting => Some("Started, waiting for it to answer.".to_string()),
        EngineState::NotRunning if directory.is_none() => Some(
            "No ACT checkout found. Set MAESTRO_ACT_DIR, or put `act` on your PATH.".to_string(),
        ),
        EngineState::NotRunning => Some("Not running.".to_string()),
    };
    EngineStatus {
        state: engine_state,
        managed: has_child,
        directory,
        detail,
    }
}

#[tauri::command]
pub async fn act_engine_status(state: State<'_, ActEngineState>) -> Result<EngineStatus, String> {
    Ok(status_now(&state).await)
}

#[tauri::command]
pub async fn act_engine_start(state: State<'_, ActEngineState>) -> Result<EngineStatus, String> {
    // Never race an ACT that is already answering: two servers on one port
    // means the second dies silently and the badge lies about which is live.
    let current = status_now(&state).await;
    if current.state != EngineState::NotRunning {
        return Ok(current);
    }

    let dir = engine_dir().await.ok_or_else(|| {
        "No ACT checkout found. Set MAESTRO_ACT_DIR, or put `act` on your PATH.".to_string()
    })?;
    if !dir.join("package.json").is_file() {
        return Err(format!(
            "{} does not look like an ACT checkout.",
            dir.display()
        ));
    }

    let child = spawn_engine(&dir)?;
    *state.child.lock().unwrap() = Some(child);
    *state.directory.lock().unwrap() = Some(dir.clone());

    let deadline = std::time::Instant::now() + STARTUP_GRACE;
    while std::time::Instant::now() < deadline {
        if health_ok().await {
            return Ok(status_now(&state).await);
        }
        if !reap(&state) {
            return Err(format!(
                "ACT exited while starting. Run it by hand in {} to see why.",
                dir.display()
            ));
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
    Err(format!(
        "ACT did not answer within {} seconds of starting.",
        STARTUP_GRACE.as_secs()
    ))
}

/// The spawn itself, separated so it can be driven against a real ACT checkout
/// without a running app. Output goes nowhere on purpose: ACT's own logs are
/// the place to read what it did, and piping them into Maestro would fill a
/// buffer nobody drains.
pub fn spawn_engine(dir: &Path) -> Result<Child, String> {
    let (program, args) = server_command(dir.join("dist/dashboard-api/server.js").is_file());
    Command::new(program)
        .args(&args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start ACT from {}: {error}", dir.display()))
}

#[tauri::command]
pub async fn act_engine_stop(state: State<'_, ActEngineState>) -> Result<EngineStatus, String> {
    stop_managed(&state).await;
    Ok(status_now(&state).await)
}

/// The quit path. Tauri's Exit event is synchronous and the async runtime is
/// already winding down, so signal the child rather than awaiting its reaping:
/// `kill_on_drop` and the OS finish the job.
pub fn stop_managed_blocking(state: &ActEngineState) {
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.start_kill();
    }
    *state.directory.lock().unwrap() = None;
}

/// Kill only what we spawned. Called on quit as well as from the UI, so an
/// engine Maestro started never outlives the window that started it.
pub async fn stop_managed(state: &ActEngineState) {
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill().await;
    }
    *state.directory.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_port_that_answers_is_live_whoever_owns_it() {
        assert_eq!(classify(true, true), EngineState::Live);
        assert_eq!(classify(false, true), EngineState::Live);
    }

    #[test]
    fn our_own_child_that_has_not_answered_yet_is_starting() {
        assert_eq!(classify(true, false), EngineState::Starting);
    }

    #[test]
    fn nothing_running_is_not_running() {
        assert_eq!(classify(false, false), EngineState::NotRunning);
    }

    #[test]
    fn env_override_wins_over_the_path() {
        let bin = PathBuf::from("/opt/homebrew/lib/node_modules/act/bin/act.js");
        assert_eq!(
            resolve_act_dir(Some("/Users/a/Repos/act-full"), Some(&bin)),
            Some(PathBuf::from("/Users/a/Repos/act-full"))
        );
    }

    #[test]
    fn the_repo_is_two_levels_up_from_the_act_executable() {
        let bin = PathBuf::from("/Users/a/Repos/act-full/bin/act.js");
        assert_eq!(
            resolve_act_dir(None, Some(&bin)),
            Some(PathBuf::from("/Users/a/Repos/act-full"))
        );
    }

    #[test]
    fn an_empty_env_var_is_not_an_override() {
        let bin = PathBuf::from("/Users/a/Repos/act-full/bin/act.js");
        assert_eq!(
            resolve_act_dir(Some("   "), Some(&bin)),
            Some(PathBuf::from("/Users/a/Repos/act-full"))
        );
    }

    #[test]
    fn no_env_and_no_executable_means_we_cannot_start_anything() {
        assert_eq!(resolve_act_dir(None, None), None);
    }

    #[test]
    fn a_built_server_is_run_directly() {
        assert_eq!(
            server_command(true),
            ("node", vec!["dist/dashboard-api/server.js"])
        );
    }

    #[test]
    fn without_a_build_we_go_through_the_npm_script_that_builds() {
        assert_eq!(server_command(false), ("npm", vec!["run", "serve"]));
    }

    /* The one test that proves the feature rather than the arithmetic: it
       spawns a real ACT from a real checkout and waits for the real port.
       Ignored by default because it needs that checkout and a free port; run
       it with `cargo test -- --ignored engine_actually_comes_up`. */
    #[tokio::test]
    #[ignore]
    async fn engine_actually_comes_up_and_goes_away_again() {
        let Some(dir) = std::env::var("MAESTRO_ACT_DIR").ok().map(PathBuf::from) else {
            panic!("set MAESTRO_ACT_DIR to an ACT checkout to run this");
        };
        assert!(!health_ok().await, "something already holds the ACT port");

        let mut child = spawn_engine(&dir).expect("spawn");

        let deadline = std::time::Instant::now() + STARTUP_GRACE;
        let mut came_up = false;
        while std::time::Instant::now() < deadline {
            if health_ok().await {
                came_up = true;
                break;
            }
            tokio::time::sleep(PROBE_INTERVAL).await;
        }
        assert!(came_up, "ACT never answered after being spawned");

        child.kill().await.expect("kill");
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(!health_ok().await, "ACT outlived the handle that spawned it");
    }
}
