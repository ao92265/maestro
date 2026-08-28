//! HTTP relay for the ACT control panel — the engine's policy, guardrail and
//! ledger surfaces, alongside the run relay in `act.rs`.
//!
//! These sit on ACT's dashboard API rather than its portal API, so they carry
//! the dashboard token instead of the portal user header. Every read is
//! normalized here: ACT answers in a mix of camelCase (its guardrail and
//! budget types) and the task store's snake_case, and the frontend must never
//! have to know which. "ACT unreachable" stays a normal state — each read
//! fails on its own and the panel keeps the other subsystems.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::act::{
    client, endpoint, failure_with_body, response_error, truthy_string, with_act_token,
};

/// Cap on the intake ledger and replay index. ACT returns its full task list
/// unpaginated; the panel only ever shows the recent end of it.
const LEDGER_LIMIT: usize = 100;

/// Cap on one replay's event list. A long agent session can run to thousands
/// of events and the timeline is a scan surface, not an archive.
const REPLAY_EVENT_LIMIT: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActAutonomyPolicy {
    pub default: String,
    /// Per-class overrides, keyed by ACT's task classes.
    pub classes: Value,
    pub l2_sample_rate: f64,
    pub human_sample_rate: f64,
    pub allow_all_classes: bool,
    pub direct_merge: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActPolicySnapshot {
    pub autonomy: ActAutonomyPolicy,
    pub writes_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActInterventionRule {
    pub r#type: String,
    pub threshold: f64,
    pub action: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActInterventionEvent {
    pub rule_type: String,
    pub agent_id: String,
    pub action: String,
    pub reason: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActBudget {
    pub daily_tokens_used: f64,
    pub daily_tokens_remaining: f64,
    pub daily_cost_used: f64,
    pub daily_cost_remaining: f64,
    pub is_over_budget: bool,
    pub last_reset_date: Option<String>,
    pub weekly_tokens_used: f64,
    pub weekly_tokens_limit: f64,
    pub weekly_usage_percent: f64,
    pub cache_tokens_used: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActLedgerEntry {
    pub id: String,
    pub title: String,
    pub status: String,
    pub retry_count: u32,
    pub failover_count: u32,
    pub pr_url: Option<String>,
    pub branch_name: Option<String>,
    pub block_reason: Option<String>,
    pub last_failover_reason: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActReplay {
    pub session_id: String,
    pub agent_id: String,
    pub task_id: String,
    pub runtime: String,
    pub started_at: Option<String>,
    pub event_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActReplayEvent {
    pub timestamp: Option<String>,
    pub r#type: String,
    pub agent_id: String,
    pub summary: String,
}

/// A replay's events plus what was left out, so the view can say so rather
/// than imply it is showing the whole session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActReplayTimeline {
    pub events: Vec<ActReplayEvent>,
    /// Events in the stored replay, before truncation.
    pub total: usize,
}

/// Ledger rows plus the untruncated task count, for the same reason.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActLedger {
    pub entries: Vec<ActLedgerEntry>,
    pub total: usize,
}

/// The complete autonomy block to write. Every field is REQUIRED, and that is
/// the safety property: ACT's `PUT /api/policy` does a shallow top-level
/// spread (`{...this.policy, ...updates}`) and deep-merges only
/// `agent_priority`, `tool_policies` and `today_overrides` — `autonomy` is not
/// on that list, so whatever arrives REPLACES the stored block and is
/// persisted to disk (`policy/manager.ts` `updatePolicy`). Sending one changed
/// key would erase the default, both sample rates and both switches.
///
/// The caller therefore merges its change over the last known policy and sends
/// the whole thing; a partial object cannot be constructed here at all.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActAutonomyInput {
    pub default: String,
    pub classes: Value,
    pub l2_sample_rate: f64,
    pub human_sample_rate: f64,
    pub allow_all_classes: bool,
    pub direct_merge: bool,
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        // ACT persists some policy numbers through YAML, which can hand back
        // a quoted number.
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    number(value).unwrap_or(fallback)
}

fn count(value: Option<&Value>) -> u32 {
    number(value)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number as u32)
        .unwrap_or(0)
}

fn flag(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

/// ACT's `AutonomyPolicy` is entirely optional-fielded: an engine that has
/// never had its ladder configured returns `{}`. Fill in the same defaults
/// the engine itself applies (`autonomy.ts`: L1, 0.1, 0.2) so the panel shows
/// the behaviour in force rather than a row of blanks.
pub(crate) fn normalize_autonomy(raw: Option<&Value>) -> ActAutonomyPolicy {
    let raw = raw.and_then(Value::as_object);
    let classes = raw
        .and_then(|policy| policy.get("classes"))
        .filter(|classes| classes.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    ActAutonomyPolicy {
        default: truthy_string(raw.and_then(|policy| policy.get("default")))
            .unwrap_or_else(|| "L1".to_string()),
        classes,
        l2_sample_rate: number_or(raw.and_then(|policy| policy.get("l2_sample_rate")), 0.1),
        human_sample_rate: number_or(raw.and_then(|policy| policy.get("human_sample_rate")), 0.2),
        allow_all_classes: flag(raw.and_then(|policy| policy.get("allowAllClasses"))),
        direct_merge: flag(raw.and_then(|policy| policy.get("directMerge"))),
    }
}

pub(crate) fn normalize_intervention_rule(raw: &Value) -> Option<ActInterventionRule> {
    let raw = raw.as_object()?;
    Some(ActInterventionRule {
        r#type: truthy_string(raw.get("type"))?,
        threshold: number_or(raw.get("threshold"), 0.0),
        action: truthy_string(raw.get("action")).unwrap_or_default(),
        enabled: flag(raw.get("enabled")),
    })
}

pub(crate) fn normalize_intervention_event(raw: &Value) -> Option<ActInterventionEvent> {
    let raw = raw.as_object()?;
    Some(ActInterventionEvent {
        rule_type: truthy_string(raw.get("ruleType"))?,
        agent_id: truthy_string(raw.get("agentId")).unwrap_or_default(),
        action: truthy_string(raw.get("action")).unwrap_or_default(),
        reason: truthy_string(raw.get("reason")).unwrap_or_default(),
        timestamp: truthy_string(raw.get("timestamp")),
    })
}

pub(crate) fn normalize_budget(raw: &Value) -> ActBudget {
    let raw = raw.as_object();
    let get = |key: &str| raw.and_then(|budget| budget.get(key));
    ActBudget {
        daily_tokens_used: number_or(get("dailyTokensUsed"), 0.0),
        daily_tokens_remaining: number_or(get("dailyTokensRemaining"), 0.0),
        daily_cost_used: number_or(get("dailyCostUsed"), 0.0),
        daily_cost_remaining: number_or(get("dailyCostRemaining"), 0.0),
        is_over_budget: flag(get("isOverBudget")),
        last_reset_date: truthy_string(get("lastResetDate")),
        weekly_tokens_used: number_or(get("weeklyTokensUsed"), 0.0),
        weekly_tokens_limit: number_or(get("weeklyTokensLimit"), 0.0),
        weekly_usage_percent: number_or(get("weeklyUsagePercent"), 0.0),
        cache_tokens_used: number(get("cacheTokensUsed")),
    }
}

/// ACT's task rows come straight off its zod schema, so every field here is
/// snake_case on the wire and the attempt counters are absent (not zero) on a
/// task that has never been retried.
pub(crate) fn normalize_ledger_entry(raw: &Value) -> Option<ActLedgerEntry> {
    let raw = raw.as_object()?;
    let id = truthy_string(raw.get("id"))?;
    Some(ActLedgerEntry {
        title: truthy_string(raw.get("title")).unwrap_or_else(|| id.clone()),
        status: truthy_string(raw.get("status")).unwrap_or_else(|| "unknown".to_string()),
        retry_count: count(raw.get("retry_count")),
        failover_count: count(raw.get("failover_count")),
        pr_url: truthy_string(raw.get("pr_url")),
        branch_name: truthy_string(raw.get("branch_name")),
        block_reason: truthy_string(raw.get("block_reason")),
        last_failover_reason: truthy_string(raw.get("last_failover_reason")),
        created_at: truthy_string(raw.get("created_at")),
        completed_at: truthy_string(raw.get("completed_at")),
        id,
    })
}

pub(crate) fn normalize_replay(raw: &Value) -> Option<ActReplay> {
    let raw = raw.as_object()?;
    Some(ActReplay {
        session_id: truthy_string(raw.get("sessionId"))?,
        agent_id: truthy_string(raw.get("agentId")).unwrap_or_default(),
        task_id: truthy_string(raw.get("taskId")).unwrap_or_default(),
        runtime: truthy_string(raw.get("runtime")).unwrap_or_else(|| "unknown".to_string()),
        started_at: truthy_string(raw.get("startedAt")),
        event_count: count(raw.get("eventCount")),
    })
}

/// Flatten a replay event's free-form `data` bag into one scannable line.
/// The keys vary by event type (`tool_use` carries a tool name, `commit` a
/// sha, `output` a chunk of text), so this prefers the few that read well and
/// falls back to a compact key list rather than dumping raw JSON.
fn summarize_replay_event(data: Option<&Value>) -> String {
    let Some(data) = data.and_then(Value::as_object) else {
        return String::new();
    };
    for key in ["summary", "message", "content", "tool", "name", "text", "sha", "error"] {
        if let Some(value) = truthy_string(data.get(key)) {
            return value.chars().take(200).collect();
        }
    }
    let keys: Vec<&str> = data.keys().map(String::as_str).take(6).collect();
    keys.join(", ")
}

pub(crate) fn normalize_replay_event(raw: &Value) -> Option<ActReplayEvent> {
    let raw = raw.as_object()?;
    Some(ActReplayEvent {
        timestamp: truthy_string(raw.get("timestamp")),
        r#type: truthy_string(raw.get("type")).unwrap_or_else(|| "event".to_string()),
        agent_id: truthy_string(raw.get("agentId")).unwrap_or_default(),
        summary: summarize_replay_event(raw.get("data")),
    })
}

/// Shared GET: ACT's dashboard routes take the dashboard token (unlike the
/// portal routes in `act.rs`, which take a user header).
async fn dashboard_get(segments: &[&str], query: &[(&str, &str)]) -> Result<Value, String> {
    let mut url = endpoint(segments)?;
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    let response = with_act_token(client()?.get(url))
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response.status().as_u16()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("ACT returned malformed JSON: {error}"))
}

/// ACT returns bare arrays from these routes, but a misconfigured proxy or a
/// future wrapper object would otherwise normalize to an empty list and read
/// as "nothing happened". Name the mismatch instead.
fn expect_array<'a>(payload: &'a Value, what: &str) -> Result<&'a Vec<Value>, String> {
    payload
        .as_array()
        .ok_or_else(|| format!("ACT returned no {what} list"))
}

#[tauri::command]
pub async fn act_get_policy() -> Result<ActPolicySnapshot, String> {
    let payload = dashboard_get(&["api", "policy"], &[]).await?;
    let policy = payload.get("policy");
    Ok(ActPolicySnapshot {
        autonomy: normalize_autonomy(policy.and_then(|policy| policy.get("autonomy"))),
        writes_enabled: flag(payload.get("writes_enabled")),
    })
}

/// Build the exact request body for a policy write.
///
/// Extracted so a test can assert on the SERIALIZED key names rather than on
/// the Rust struct: these keys have to match ACT's `AutonomyPolicy` field for
/// field, and the casing is genuinely mixed there (`l2_sample_rate` and
/// `human_sample_rate` are snake_case, `allowAllClasses` and `directMerge` are
/// camelCase). A key that drifts is silently dropped by the engine's spread,
/// which looks exactly like a control that does nothing.
pub(crate) fn build_autonomy_body(autonomy: &ActAutonomyInput) -> Value {
    json!({
        "autonomy": {
            "default": autonomy.default,
            "classes": autonomy.classes,
            "l2_sample_rate": autonomy.l2_sample_rate,
            "human_sample_rate": autonomy.human_sample_rate,
            "allowAllClasses": autonomy.allow_all_classes,
            "directMerge": autonomy.direct_merge,
        }
    })
}

#[tauri::command]
pub async fn act_set_autonomy(autonomy: ActAutonomyInput) -> Result<u16, String> {
    let url = endpoint(&["api", "policy"])?;
    let response = with_act_token(client()?.put(url))
        .json(&build_autonomy_body(&autonomy))
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(failure_with_body(response).await);
    }
    Ok(response.status().as_u16())
}

#[tauri::command]
pub async fn act_list_intervention_rules() -> Result<Vec<ActInterventionRule>, String> {
    let payload = dashboard_get(&["api", "intervention", "rules"], &[]).await?;
    Ok(expect_array(&payload, "intervention rules")?
        .iter()
        .filter_map(normalize_intervention_rule)
        .collect())
}

#[tauri::command]
pub async fn act_list_intervention_events(
    limit: Option<u32>,
) -> Result<Vec<ActInterventionEvent>, String> {
    let limit = limit.unwrap_or(50).to_string();
    let payload = dashboard_get(&["api", "intervention", "history"], &[("limit", &limit)]).await?;
    let mut events: Vec<ActInterventionEvent> = expect_array(&payload, "intervention history")?
        .iter()
        .filter_map(normalize_intervention_event)
        .collect();
    // ACT keeps its history oldest-first (`history.slice(-limit)`); a feed
    // reads newest-first.
    events.reverse();
    Ok(events)
}

#[tauri::command]
pub async fn act_get_budget() -> Result<ActBudget, String> {
    Ok(normalize_budget(
        &dashboard_get(&["api", "budget"], &[]).await?,
    ))
}

#[tauri::command]
pub async fn act_list_ledger() -> Result<ActLedger, String> {
    let payload = dashboard_get(&["api", "tasks"], &[]).await?;
    let mut entries: Vec<ActLedgerEntry> = expect_array(&payload, "tasks")?
        .iter()
        .filter_map(normalize_ledger_entry)
        .collect();
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total = entries.len();
    entries.truncate(LEDGER_LIMIT);
    Ok(ActLedger { entries, total })
}

#[tauri::command]
pub async fn act_list_replays() -> Result<Vec<ActReplay>, String> {
    let payload = dashboard_get(&["api", "replays"], &[]).await?;
    Ok(expect_array(&payload, "replays")?
        .iter()
        .filter_map(normalize_replay)
        .collect())
}

#[tauri::command]
pub async fn act_get_replay(agent_id: String) -> Result<ActReplayTimeline, String> {
    let payload = dashboard_get(&["api", "replay", &agent_id], &[]).await?;
    // ACT answers 200 with `{ message: 'No replay found' }` rather than a 404
    // when the agent has no stored replay — an empty timeline, not a failure.
    let Some(events) = payload.get("events").and_then(Value::as_array) else {
        return Ok(ActReplayTimeline { events: Vec::new(), total: 0 });
    };
    Ok(tail_timeline(
        events.iter().filter_map(normalize_replay_event).collect(),
    ))
}

/// Keep the TAIL, not the head: ACT stores events oldest-first, so a long
/// session's ending — the failure or the commit, the part worth reading — is at
/// the end. Taking the first N hid exactly that while the header still claimed
/// the full count.
pub(crate) fn tail_timeline(normalized: Vec<ActReplayEvent>) -> ActReplayTimeline {
    let total = normalized.len();
    let events = if total > REPLAY_EVENT_LIMIT {
        normalized[total - REPLAY_EVENT_LIMIT..].to_vec()
    } else {
        normalized
    };
    ActReplayTimeline { events, total }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_the_engines_own_defaults_for_an_unconfigured_ladder() {
        let policy = normalize_autonomy(Some(&json!({})));
        assert_eq!(policy.default, "L1");
        assert_eq!(policy.l2_sample_rate, 0.1);
        assert_eq!(policy.human_sample_rate, 0.2);
        assert!(!policy.allow_all_classes);
        assert_eq!(policy.classes, json!({}));
    }

    #[test]
    fn reads_a_configured_ladder_verbatim() {
        let policy = normalize_autonomy(Some(&json!({
            "default": "L0",
            "classes": { "docs": "L2", "code": "L1" },
            "l2_sample_rate": 0.5,
            "human_sample_rate": 0.25,
            "allowAllClasses": true,
            "directMerge": true
        })));
        assert_eq!(policy.default, "L0");
        assert_eq!(policy.classes["docs"], json!("L2"));
        assert_eq!(policy.l2_sample_rate, 0.5);
        assert!(policy.allow_all_classes);
        assert!(policy.direct_merge);
    }

    /// A missing `autonomy` key must still describe the engine's behaviour,
    /// not a row of blanks that reads as "no autonomy at all".
    #[test]
    fn treats_a_missing_autonomy_block_as_the_defaults() {
        assert_eq!(normalize_autonomy(None), normalize_autonomy(Some(&json!({}))));
    }

    #[test]
    fn normalizes_the_ledger_from_snake_case_and_defaults_absent_counters() {
        let entry = normalize_ledger_entry(&json!({
            "id": "task-7",
            "title": "Fix the thing",
            "status": "completed",
            "pr_url": "https://example.test/pr/7",
            "branch_name": "fix/thing",
            "created_at": "2026-08-28T08:00:00.000Z",
            "secret": "not copied"
        }))
        .expect("entry");
        assert_eq!(entry.id, "task-7");
        assert_eq!(entry.retry_count, 0);
        assert_eq!(entry.failover_count, 0);
        assert_eq!(entry.pr_url.as_deref(), Some("https://example.test/pr/7"));
        assert_eq!(entry.block_reason, None);
    }

    #[test]
    fn counts_retries_and_failovers_when_present() {
        let entry = normalize_ledger_entry(&json!({
            "id": "task-8",
            "retry_count": 2,
            "failover_count": 1,
            "last_failover_reason": "codex timed out"
        }))
        .expect("entry");
        assert_eq!(entry.retry_count, 2);
        assert_eq!(entry.failover_count, 1);
        assert_eq!(entry.last_failover_reason.as_deref(), Some("codex timed out"));
        // No title on the wire: fall back to the id rather than an empty row.
        assert_eq!(entry.title, "task-8");
    }

    #[test]
    fn drops_ledger_rows_without_an_id() {
        assert!(normalize_ledger_entry(&json!({ "title": "orphan" })).is_none());
    }

    #[test]
    fn normalizes_a_budget_with_an_absent_cache_counter() {
        let budget = normalize_budget(&json!({
            "dailyTokensUsed": 1200,
            "dailyTokensRemaining": 800,
            "isOverBudget": false,
            "weeklyUsagePercent": 40
        }));
        assert_eq!(budget.daily_tokens_used, 1200.0);
        assert_eq!(budget.weekly_usage_percent, 40.0);
        // Absent is not zero: ACT marks the cache counter optional.
        assert_eq!(budget.cache_tokens_used, None);
    }

    #[test]
    fn keeps_intervention_rules_and_drops_typeless_ones() {
        let rules: Vec<ActInterventionRule> = json!([
            { "type": "stale_agent", "threshold": 1200, "action": "restart", "enabled": true },
            { "threshold": 3, "action": "stop", "enabled": true }
        ])
        .as_array()
        .expect("array")
        .iter()
        .filter_map(normalize_intervention_rule)
        .collect();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].r#type, "stale_agent");
        assert_eq!(rules[0].threshold, 1200.0);
    }

    #[test]
    fn summarizes_a_replay_event_from_whichever_key_carries_the_payload() {
        let event = normalize_replay_event(&json!({
            "timestamp": "2026-08-28T09:00:00.000Z",
            "type": "tool_use",
            "agentId": "agent-1",
            "data": { "tool": "Edit", "path": "src/app.ts" }
        }))
        .expect("event");
        assert_eq!(event.r#type, "tool_use");
        assert_eq!(event.summary, "Edit");
    }

    #[test]
    fn falls_back_to_a_key_list_when_no_readable_field_exists() {
        let event = normalize_replay_event(&json!({
            "type": "decision",
            "agentId": "agent-1",
            "data": { "alpha": 1, "beta": 2 }
        }))
        .expect("event");
        assert_eq!(event.summary, "alpha, beta");
    }

    /// Asserts the bytes that actually go on the wire. The previous version of
    /// this test read fields back off the Rust struct, which no caller sees —
    /// renaming a JSON key left it green while the control silently no-opped.
    #[test]
    fn writes_the_exact_key_names_act_reads() {
        let body = build_autonomy_body(&ActAutonomyInput {
            default: "L1".to_string(),
            classes: json!({ "code": "L0" }),
            l2_sample_rate: 0.25,
            human_sample_rate: 0.2,
            allow_all_classes: true,
            direct_merge: false,
        });

        assert_eq!(
            body,
            json!({
                "autonomy": {
                    "default": "L1",
                    "classes": { "code": "L0" },
                    "l2_sample_rate": 0.25,
                    "human_sample_rate": 0.2,
                    "allowAllClasses": true,
                    "directMerge": false
                }
            })
        );
    }

    /// The engine REPLACES the autonomy block rather than merging it, so every
    /// key has to be present on every write or the missing ones are erased
    /// from disk.
    #[test]
    fn always_sends_the_whole_autonomy_block() {
        let body = build_autonomy_body(&ActAutonomyInput {
            default: "L2".to_string(),
            classes: json!({}),
            l2_sample_rate: 0.1,
            human_sample_rate: 0.2,
            allow_all_classes: false,
            direct_merge: true,
        });

        let sent = body["autonomy"].as_object().expect("autonomy object");
        let mut keys: Vec<&str> = sent.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "allowAllClasses",
                "classes",
                "default",
                "directMerge",
                "human_sample_rate",
                "l2_sample_rate"
            ]
        );
    }

    fn replay_event(n: usize) -> ActReplayEvent {
        ActReplayEvent {
            timestamp: None,
            r#type: "output".to_string(),
            agent_id: "agent-1".to_string(),
            summary: n.to_string(),
        }
    }

    /// The end of a long session is the part worth reading, and it is what the
    /// head-first cut threw away.
    #[test]
    fn keeps_the_end_of_an_over_long_replay_and_reports_the_true_total() {
        let events: Vec<ActReplayEvent> = (0..REPLAY_EVENT_LIMIT + 25).map(replay_event).collect();

        let timeline = tail_timeline(events);

        assert_eq!(timeline.total, REPLAY_EVENT_LIMIT + 25);
        assert_eq!(timeline.events.len(), REPLAY_EVENT_LIMIT);
        // Last event of the session survives; the first 25 are the ones cut.
        assert_eq!(
            timeline.events.last().map(|e| e.summary.as_str()),
            Some((REPLAY_EVENT_LIMIT + 24).to_string().as_str())
        );
        assert_eq!(timeline.events.first().map(|e| e.summary.as_str()), Some("25"));
    }

    #[test]
    fn leaves_a_short_replay_whole() {
        let timeline = tail_timeline((0..3).map(replay_event).collect());
        assert_eq!(timeline.total, 3);
        assert_eq!(timeline.events.len(), 3);
    }

    #[test]
    fn names_a_non_array_payload_instead_of_reading_it_as_empty() {
        let payload = json!({ "error": "boom" });
        assert!(expect_array(&payload, "replays").is_err());
    }
}
