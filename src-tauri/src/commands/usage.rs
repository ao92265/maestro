//! IPC commands for Claude Code usage tracking.
//!
//! Fetches real rate limit data from Anthropic's OAuth API.
//! Reads OAuth tokens from platform credential store (primary) or credentials file (fallback).

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// Flag to skip credential store after first failure (prevents repeated prompts).
static CREDENTIAL_STORE_FAILED: AtomicBool = AtomicBool::new(false);

/// Minimum seconds between actual API calls. Requests within this window return cached data.
const CACHE_TTL_SECS: u64 = 30;

/// Cached usage response to prevent duplicate API calls from multiple frontend
/// components or rapid re-renders. Stores (fetch_time, ttl_secs, data).
static USAGE_CACHE: Mutex<Option<(Instant, u64, UsageData)>> = Mutex::new(None);

/// Usage data from Anthropic's OAuth API.
///
/// Every window is optional: the API reports different windows per account
/// type. Pro/Max accounts get the session/weekly windows; enterprise seats
/// get a monthly spend budget instead, with the session/weekly windows
/// returned as null. `None` means "window not reported" — distinct from 0%.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    /// Session (5-hour window) usage percentage (0-100).
    pub session_percent: Option<f64>,
    /// When the session window resets (ISO 8601).
    pub session_resets_at: Option<String>,
    /// Weekly (7-day window) usage percentage for all models (0-100).
    pub weekly_percent: Option<f64>,
    /// When the weekly window resets (ISO 8601).
    pub weekly_resets_at: Option<String>,
    /// Weekly Opus-specific usage percentage (0-100).
    pub weekly_opus_percent: Option<f64>,
    /// When the weekly Opus window resets (ISO 8601).
    pub weekly_opus_resets_at: Option<String>,
    /// Weekly Sonnet-specific usage percentage (0-100).
    pub weekly_sonnet_percent: Option<f64>,
    /// When the weekly Sonnet window resets (ISO 8601).
    pub weekly_sonnet_resets_at: Option<String>,
    /// Weekly OAuth-apps usage percentage (0-100).
    pub weekly_oauth_apps_percent: Option<f64>,
    /// When the weekly OAuth-apps window resets (ISO 8601).
    pub weekly_oauth_apps_resets_at: Option<String>,
    /// Monthly spend-budget usage percentage (0-100). Enterprise seats
    /// report this window (named `cinder_cove` by the API) instead of the
    /// session/weekly windows.
    pub spend_percent: Option<f64>,
    /// When the spend budget resets (ISO 8601).
    pub spend_resets_at: Option<String>,
    /// Dollars spent so far in the monthly budget window (only present when
    /// the spend window is reported).
    pub spend_used_dollars: Option<f64>,
    /// Total dollar limit of the monthly budget window.
    pub spend_limit_dollars: Option<f64>,
    /// Error message if token is expired or unavailable.
    pub error_message: Option<String>,
    /// Whether authentication is needed (token expired or missing).
    pub needs_auth: bool,
}

/// Response from Anthropic's /api/oauth/usage endpoint.
///
/// Which windows are populated depends on the account type: Pro/Max accounts
/// report `five_hour`/`seven_day` plus per-model weekly windows
/// (`seven_day_opus`/`seven_day_sonnet`) and `seven_day_oauth_apps`, while
/// enterprise seats report all of those as null and carry their monthly
/// dollar budget under `cinder_cove` (observed with Claude Code 2.1.x,
/// 2026-08). Unknown keys (e.g. the `tangelo` experiment window and the
/// `extra_usage`/`spend`/`limits` blobs) are ignored by serde.
#[derive(Debug, Deserialize)]
struct ApiUsageResponse {
    five_hour: Option<UsageWindow>,
    seven_day: Option<UsageWindow>,
    seven_day_opus: Option<UsageWindow>,
    seven_day_sonnet: Option<UsageWindow>,
    seven_day_oauth_apps: Option<UsageWindow>,
    cinder_cove: Option<UsageWindow>,
}

#[derive(Debug, Deserialize)]
struct UsageWindow {
    /// Nullable: the API emits window-shaped objects with
    /// `"utilization": null` (seen in the `extra_usage` blob); a required
    /// f64 here would fail the whole response deserialize.
    utilization: Option<f64>,
    resets_at: Option<String>,
    /// Dollar fields only appear on the `cinder_cove` (spend budget) window.
    limit_dollars: Option<f64>,
    used_dollars: Option<f64>,
}

/// Credentials structure (same format in file and keychain).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsData {
    claude_ai_oauth: Option<OAuthCredentials>,
}

/// OAuth credentials structure.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthCredentials {
    access_token: String,
    expires_at: u64,
}

/// Check if token is expired (with 60 second buffer).
fn is_token_expired(expires_at: u64) -> bool {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    expires_at < now_ms + 60_000
}

/// Get the current username for credential store access.
fn get_username() -> Option<String> {
    // USER (Unix) or USERNAME (Windows)
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
}

/// Read credentials from macOS Keychain using the `security` CLI.
/// This avoids permission prompts since `security` is Apple-signed.
#[cfg(target_os = "macos")]
async fn read_keychain_credentials() -> Result<CredentialsData, String> {
    let username = get_username().ok_or("Could not get username")?;

    let output = tokio::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-a",
            &username,
            "-w",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run security: {}", e))?;

    if !output.status.success() {
        return Err("No keychain entry found".to_string());
    }

    let data = String::from_utf8(output.stdout).map_err(|_| "Invalid keychain data")?;

    serde_json::from_str(data.trim()).map_err(|e| format!("Failed to parse keychain data: {}", e))
}

/// Read credentials from platform credential store (Windows/Linux).
/// - Windows: Credential Manager
/// - Linux: Secret Service (D-Bus)
#[cfg(not(target_os = "macos"))]
async fn read_keychain_credentials() -> Result<CredentialsData, String> {
    let username = get_username().ok_or("Could not get username")?;

    let result = tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new("Claude Code-credentials", &username)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

        entry.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => "No credential entry found".to_string(),
            _ => format!("Credential store error: {}", e),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    serde_json::from_str(&result).map_err(|e| format!("Failed to parse credential data: {}", e))
}

/// Read credentials from file (fallback for non-macOS or if keychain fails).
async fn read_file_credentials() -> Result<CredentialsData, String> {
    let home = directories::UserDirs::new()
        .and_then(|dirs| Some(dirs.home_dir().to_path_buf()))
        .ok_or("Could not get home directory")?;

    let creds_path = home.join(".claude").join(".credentials.json");

    if !creds_path.exists() {
        return Err("Credentials file not found".to_string());
    }

    let content = tokio::fs::read_to_string(&creds_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse file: {}", e))
}

/// Get a valid access token, trying platform credential store first then file.
async fn get_access_token() -> Result<String, String> {
    // Try platform credential store first (skip if previously failed to avoid repeated prompts)
    if !CREDENTIAL_STORE_FAILED.load(Ordering::Relaxed) {
        match read_keychain_credentials().await {
            Ok(creds) => {
                if let Some(oauth) = creds.claude_ai_oauth {
                    if !is_token_expired(oauth.expires_at) {
                        log::debug!("Using token from platform credential store");
                        return Ok(oauth.access_token);
                    }
                    log::debug!("Credential store token expired");
                }
            }
            Err(e) => {
                log::debug!("Credential store failed, will use file fallback: {}", e);
                CREDENTIAL_STORE_FAILED.store(true, Ordering::Relaxed);
            }
        }
    }

    // Fall back to credentials file
    let creds = read_file_credentials().await?;
    let oauth = creds.claude_ai_oauth.ok_or("Not logged in")?;

    if is_token_expired(oauth.expires_at) {
        return Err("Session expired".to_string());
    }

    log::debug!("Using token from file");
    Ok(oauth.access_token)
}

/// Map the API response into the frontend-facing `UsageData`.
///
/// Absent windows — and windows whose `utilization` is null — stay `None`
/// so the UI can tell "not reported" apart from 0%.
///
/// Anthropic's API reports `utilization` already on a 0-100 scale for every
/// window (do NOT reintroduce a `> 1.0 ? val : val * 100` heuristic — it
/// pinned low session usage to 100%). Non-finite values are guarded
/// (→ 0, never 100) and the result is clamped to [0, 100].
fn to_usage_data(api: ApiUsageResponse) -> UsageData {
    let parse_window = |w: Option<UsageWindow>| -> (Option<f64>, Option<String>) {
        match w {
            Some(UsageWindow {
                utilization: Some(utilization),
                resets_at,
                ..
            }) => {
                let percent = if utilization.is_finite() {
                    utilization.clamp(0.0, 100.0)
                } else {
                    0.0
                };
                (Some(percent), resets_at)
            }
            _ => (None, None),
        }
    };

    // Dollar amounts only make sense while the spend window is reported
    // (utilization non-null) — keep them None otherwise, like the percents.
    let (spend_used_dollars, spend_limit_dollars) = match &api.cinder_cove {
        Some(w) if w.utilization.is_some() => (w.used_dollars, w.limit_dollars),
        _ => (None, None),
    };

    let (session_percent, session_resets_at) = parse_window(api.five_hour);
    let (weekly_percent, weekly_resets_at) = parse_window(api.seven_day);
    let (weekly_opus_percent, weekly_opus_resets_at) = parse_window(api.seven_day_opus);
    let (weekly_sonnet_percent, weekly_sonnet_resets_at) = parse_window(api.seven_day_sonnet);
    let (weekly_oauth_apps_percent, weekly_oauth_apps_resets_at) =
        parse_window(api.seven_day_oauth_apps);
    let (spend_percent, spend_resets_at) = parse_window(api.cinder_cove);

    UsageData {
        session_percent,
        session_resets_at,
        weekly_percent,
        weekly_resets_at,
        weekly_opus_percent,
        weekly_opus_resets_at,
        weekly_sonnet_percent,
        weekly_sonnet_resets_at,
        weekly_oauth_apps_percent,
        weekly_oauth_apps_resets_at,
        spend_percent,
        spend_resets_at,
        spend_used_dollars,
        spend_limit_dollars,
        error_message: None,
        needs_auth: false,
    }
}

/// Fetch usage data from Anthropic's OAuth API.
/// Responses are cached for 30 seconds to prevent 429 errors when multiple
/// components or re-renders trigger concurrent requests.
/// Pass `force_refresh: true` to bypass the cache (e.g. user-initiated refresh).
#[tauri::command]
pub async fn get_claude_usage(force_refresh: Option<bool>) -> Result<UsageData, String> {
    let force = force_refresh.unwrap_or(false);
    // Return cached response if still fresh (skip when force=true)
    if !force {
        if let Ok(guard) = USAGE_CACHE.lock() {
            if let Some((fetched_at, ttl, ref data)) = *guard {
                if fetched_at.elapsed().as_secs() < ttl {
                    log::debug!(
                        "Returning cached usage data (age: {}s, ttl: {}s)",
                        fetched_at.elapsed().as_secs(),
                        ttl
                    );
                    return Ok(data.clone());
                }
            }
        }
    }

    let result = fetch_usage_from_api().await;

    // Cache successful responses (and auth errors, since those won't change quickly)
    if let Ok(ref data) = result {
        if let Ok(mut guard) = USAGE_CACHE.lock() {
            *guard = Some((Instant::now(), CACHE_TTL_SECS, data.clone()));
        }
    }

    result
}

/// Actually fetch usage data from the API (uncached).
async fn fetch_usage_from_api() -> Result<UsageData, String> {
    let token = match get_access_token().await {
        Ok(t) => t,
        Err(e) => {
            log::debug!("No valid token: {}", e);
            return Ok(UsageData {
                error_message: Some(e),
                needs_auth: true,
                ..Default::default()
            });
        }
    };

    let client = reqwest::Client::new();
    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.0.32")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    // Handle auth errors
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        log::debug!("Usage API returned 401");
        return Ok(UsageData {
            error_message: Some("Session expired".to_string()),
            needs_auth: true,
            ..Default::default()
        });
    }

    // Handle rate limiting (429) — extend cache TTL to avoid hammering the API
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);
        log::warn!("Usage API returned 429, retry after {}s", retry_after);
        let data = UsageData {
            error_message: Some(format!("Rate limited, retrying in {}s", retry_after)),
            ..Default::default()
        };
        // Cache the 429 response using retry-after as TTL so we don't retry before the server allows
        if let Ok(mut guard) = USAGE_CACHE.lock() {
            *guard = Some((Instant::now(), retry_after, data.clone()));
        }
        return Ok(data);
    }

    if !response.status().is_success() {
        let status = response.status();
        log::warn!("Usage API returned {}", status);
        return Ok(UsageData {
            error_message: Some(format!("API error: {}", status)),
            ..Default::default()
        });
    }

    let api_response: ApiUsageResponse = response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let usage = to_usage_data(api_response);

    log::info!(
        "Usage: session={:?}, weekly={:?}, spend={:?}",
        usage.session_percent,
        usage.weekly_percent,
        usage.spend_percent
    );

    Ok(usage)
}

/// Account info reported by `claude auth status`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub logged_in: bool,
    pub email: Option<String>,
    pub subscription_type: Option<String>,
}

/// Subset of `claude auth status` JSON we care about. The CLI emits
/// camelCase keys ({"loggedIn": …, "subscriptionType": …}) — without the
/// rename every field silently fell back to its default and the account
/// always read as logged out.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAuthStatus {
    #[serde(default)]
    logged_in: bool,
    email: Option<String>,
    subscription_type: Option<String>,
}

/// Cached account info — `claude auth status` shells out, so cache for the lifetime
/// of the app (account doesn't change without an explicit re-login).
static ACCOUNT_CACHE: Mutex<Option<ClaudeAccount>> = Mutex::new(None);

/// Returns the email of the currently logged-in Claude Code account, by parsing
/// `claude auth status --json`. Returns `logged_in: false` if the CLI isn't on
/// PATH or reports a logged-out state.
#[tauri::command]
pub async fn get_claude_account() -> Result<ClaudeAccount, String> {
    if let Ok(guard) = ACCOUNT_CACHE.lock() {
        if let Some(ref data) = *guard {
            return Ok(data.clone());
        }
    }

    let output = {
        #[cfg(windows)]
        {
            use crate::core::windows_process::TokioCommandExt;
            tokio::process::Command::new("claude")
                .args(["auth", "status"])
                .hide_console_window()
                .output()
                .await
        }
        #[cfg(not(windows))]
        {
            tokio::process::Command::new("claude")
                .args(["auth", "status"])
                .output()
                .await
        }
    };

    let account = match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<ClaudeAuthStatus>(stdout.trim()) {
                Ok(parsed) => ClaudeAccount {
                    logged_in: parsed.logged_in,
                    email: parsed.email,
                    subscription_type: parsed.subscription_type,
                },
                Err(e) => {
                    log::debug!("Failed to parse claude auth status JSON: {}", e);
                    ClaudeAccount::default()
                }
            }
        }
        Ok(out) => {
            log::debug!("claude auth status exited with {:?}", out.status);
            ClaudeAccount::default()
        }
        Err(e) => {
            log::debug!("Could not run `claude auth status`: {}", e);
            ClaudeAccount::default()
        }
    };

    // Only cache a logged-in result: pinning a transient CLI failure (or a
    // parse miss) would report "logged out" for the whole app lifetime.
    if account.logged_in {
        if let Ok(mut guard) = ACCOUNT_CACHE.lock() {
            *guard = Some(account.clone());
        }
    }
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed real /api/oauth/usage response captured from an enterprise
    /// seat (Claude Code 2.1.x, 2026-08-04): the classic session/weekly
    /// windows are null and the monthly dollar budget arrives as the
    /// `cinder_cove` window. Unknown keys (experiment codenames, nested
    /// spend/extra_usage blobs) must be ignored.
    const ENTERPRISE_RESPONSE: &str = r#"{
        "five_hour": null,
        "seven_day": null,
        "seven_day_oauth_apps": null,
        "seven_day_opus": null,
        "seven_day_sonnet": null,
        "tangelo": null,
        "cinder_cove": {
            "utilization": 85.70003930000001,
            "resets_at": "2026-09-06T10:33:51.866730+00:00",
            "limit_dollars": 1000,
            "used_dollars": 857.000393,
            "remaining_dollars": 142.99960699999997
        },
        "extra_usage": {"is_enabled": true, "monthly_limit": 100, "utilization": null},
        "limits": [],
        "spend": {"percent": 0, "severity": "normal"}
    }"#;

    #[test]
    fn maps_enterprise_response_to_spend_window_only() {
        let parsed: ApiUsageResponse = serde_json::from_str(ENTERPRISE_RESPONSE).unwrap();
        let usage = to_usage_data(parsed);
        assert_eq!(usage.session_percent, None);
        assert_eq!(usage.session_resets_at, None);
        assert_eq!(usage.weekly_percent, None);
        assert_eq!(usage.weekly_opus_percent, None);
        assert_eq!(usage.weekly_sonnet_percent, None);
        assert_eq!(usage.weekly_oauth_apps_percent, None);
        let spend = usage.spend_percent.expect("spend percent from cinder_cove");
        assert!((spend - 85.70003930000001).abs() < 1e-9);
        assert_eq!(
            usage.spend_resets_at.as_deref(),
            Some("2026-09-06T10:33:51.866730+00:00")
        );
        assert_eq!(usage.spend_used_dollars, Some(857.000393));
        assert_eq!(usage.spend_limit_dollars, Some(1000.0));
        assert!(!usage.needs_auth);
        assert_eq!(usage.error_message, None);
    }

    #[test]
    fn maps_per_model_weekly_windows_when_reported() {
        let parsed: ApiUsageResponse = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": 10.0, "resets_at": null},
                "seven_day": {"utilization": 20.0, "resets_at": null},
                "seven_day_opus": {"utilization": 30.0, "resets_at": "2026-08-08T00:00:00Z"},
                "seven_day_sonnet": {"utilization": 40.0, "resets_at": "2026-08-08T00:00:00Z"},
                "seven_day_oauth_apps": {"utilization": 50.0, "resets_at": null}
            }"#,
        )
        .unwrap();
        let usage = to_usage_data(parsed);
        assert_eq!(usage.weekly_opus_percent, Some(30.0));
        assert_eq!(usage.weekly_sonnet_percent, Some(40.0));
        assert_eq!(
            usage.weekly_sonnet_resets_at.as_deref(),
            Some("2026-08-08T00:00:00Z")
        );
        assert_eq!(usage.weekly_oauth_apps_percent, Some(50.0));
        // No spend window reported → no dollar figures either.
        assert_eq!(usage.spend_used_dollars, None);
        assert_eq!(usage.spend_limit_dollars, None);
    }

    #[test]
    fn maps_pro_max_response_to_session_and_weekly() {
        let parsed: ApiUsageResponse = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": 42.0, "resets_at": "2026-08-04T20:00:00Z"},
                "seven_day": {"utilization": 63.5, "resets_at": null},
                "seven_day_opus": null
            }"#,
        )
        .unwrap();
        let usage = to_usage_data(parsed);
        assert_eq!(usage.session_percent, Some(42.0));
        assert_eq!(
            usage.session_resets_at.as_deref(),
            Some("2026-08-04T20:00:00Z")
        );
        assert_eq!(usage.weekly_percent, Some(63.5));
        assert_eq!(usage.weekly_resets_at, None);
        assert_eq!(usage.weekly_opus_percent, None);
        assert_eq!(usage.spend_percent, None);
        assert_eq!(usage.spend_resets_at, None);
    }

    #[test]
    fn treats_null_utilization_window_as_not_reported() {
        // A window object can arrive with `"utilization": null` (that exact
        // shape appears in the payload's extra_usage blob) — it must neither
        // fail the deserialize nor render as a 0% bar.
        let parsed: ApiUsageResponse = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": null, "resets_at": "2026-08-04T20:00:00Z"},
                "seven_day": null,
                "seven_day_opus": null,
                "cinder_cove": null
            }"#,
        )
        .unwrap();
        let usage = to_usage_data(parsed);
        assert_eq!(usage.session_percent, None);
        assert_eq!(usage.session_resets_at, None);
    }

    #[test]
    fn withholds_spend_dollars_when_spend_utilization_is_null() {
        // Dollar figures ride along only while the spend window itself is
        // reported — a null utilization must not leak them through.
        let parsed: ApiUsageResponse = serde_json::from_str(
            r#"{
                "cinder_cove": {
                    "utilization": null,
                    "resets_at": "2026-09-06T10:33:51.866730+00:00",
                    "limit_dollars": 1000,
                    "used_dollars": 857.000393
                }
            }"#,
        )
        .unwrap();
        let usage = to_usage_data(parsed);
        assert_eq!(usage.spend_percent, None);
        assert_eq!(usage.spend_resets_at, None);
        assert_eq!(usage.spend_used_dollars, None);
        assert_eq!(usage.spend_limit_dollars, None);
    }
}
