//! HTTP relay commands for the local Agent Control Tower (ACT) service.
//!
//! The webview cannot call ACT directly because of its CSP, so these commands
//! relay requests through Tauri. "ACT unreachable" is a normal state: the
//! frontend renders its last snapshot as stale and the application never crashes.

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const DEFAULT_ACT_URL: &str = "http://127.0.0.1:3847";
const PORTAL_USER: &str = "maestro";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActStage {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActRun {
    pub id: String,
    pub title: String,
    pub status: String,
    pub stage: Option<String>,
    pub stages: Vec<ActStage>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub repo_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActTask {
    pub id: String,
    pub status: String,
    pub block_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActRunDetail {
    pub id: String,
    pub title: String,
    pub status: String,
    pub stage: Option<String>,
    pub stages: Vec<ActStage>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub repo_url: Option<String>,
    pub error: Option<String>,
    pub task: Option<ActTask>,
    pub agents: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActSpecInput {
    pub title: String,
    pub problem: String,
    pub audience: String,
    pub must_haves: Vec<String>,
    pub non_goals: Vec<String>,
    pub success_criteria: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActSubmitOutcome {
    pub accepted: bool,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub stages: Option<Vec<String>>,
    pub complexity: Option<String>,
    pub http_status: u16,
    pub error: Option<String>,
    /// 429 body: how full the in-flight window is.
    pub current_in_flight: Option<u64>,
    pub limit: Option<u64>,
    /// 402 body: the token-budget numbers that make the rejection actionable.
    pub used_tokens: Option<u64>,
    pub cap_tokens: Option<u64>,
    pub remaining_tokens: Option<u64>,
}

#[derive(Serialize)]
struct ResolveGateBody<'a> {
    decision: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<&'a str>,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to build ACT client: {error}"))
}

fn base_url() -> String {
    std::env::var("MAESTRO_ACT_URL")
        .unwrap_or_else(|_| DEFAULT_ACT_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// ACT gates every state-changing request behind a shared secret once
/// `ACT_DASHBOARD_TOKEN` is set (its dashboard-auth middleware; GETs stay
/// open). Attach it to every mutating relay call so those calls keep working
/// the day the token is configured, instead of failing with an invisible 401.
///
/// Reads the Tauri process env: a token exported only in .zshrc is invisible
/// to a packaged app launched from Finder. Launch from a shell or set it via
/// launchd if the token is ever required.
fn with_act_token(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match std::env::var("ACT_DASHBOARD_TOKEN") {
        Ok(token) if !token.is_empty() => request.header("x-act-token", token),
        _ => request,
    }
}

/// Read the body of a failed mutating call so the error names what ACT said
/// ("gate not found", "unauthorized…") instead of a bare status code.
async fn failure_with_body(response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|payload| truthy_string(payload.get("error")))
        .unwrap_or_else(|| truncate_response(&body));
    if detail.is_empty() {
        response_error(status)
    } else {
        format!("{}: {detail}", response_error(status))
    }
}

fn endpoint(segments: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse(&base_url()).map_err(|error| format!("Invalid ACT URL: {error}"))?;
    let mut path = url
        .path_segments_mut()
        .map_err(|_| "Invalid ACT URL: base URL cannot accept path segments".to_string())?;
    path.pop_if_empty();
    path.extend(segments.iter().copied());
    drop(path);
    Ok(url)
}

fn is_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn truthy_string(value: Option<&Value>) -> Option<String> {
    value.filter(|value| is_js_truthy(value)).map(js_string)
}

fn normalize_stages(raw: &Value) -> Vec<ActStage> {
    raw.get("stages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|stage| {
            let stage = stage.as_object()?;
            let name = truthy_string(stage.get("name"))?;
            let status = truthy_string(stage.get("status")).unwrap_or_default();
            Some(ActStage { name, status })
        })
        .collect()
}

fn normalize_run(raw: &Value) -> Option<ActRun> {
    let raw = raw.as_object()?;
    let id = truthy_string(raw.get("id"))?;
    let spec = raw.get("spec").and_then(Value::as_object);
    let output = raw.get("output").and_then(Value::as_object);
    let stages = normalize_stages(&Value::Object(raw.clone()));
    let stage = stages
        .iter()
        .find(|stage| stage.status == "running")
        .map(|stage| stage.name.clone());

    Some(ActRun {
        title: truthy_string(spec.and_then(|spec| spec.get("title"))).unwrap_or_else(|| id.clone()),
        status: truthy_string(raw.get("status")).unwrap_or_else(|| "unknown".to_string()),
        created_at: truthy_string(raw.get("createdAt")),
        updated_at: truthy_string(raw.get("updatedAt")),
        repo_url: truthy_string(output.and_then(|output| output.get("repoUrl"))),
        error: truthy_string(raw.get("error")),
        id,
        stage,
        stages,
    })
}

fn normalize_run_detail(raw: &Value) -> Option<ActRunDetail> {
    let run = normalize_run(raw)?;
    let task = raw.get("task").and_then(Value::as_object).and_then(|task| {
        Some(ActTask {
            id: truthy_string(task.get("id"))?,
            status: truthy_string(task.get("status")).unwrap_or_default(),
            block_reason: truthy_string(task.get("block_reason")),
        })
    });

    Some(ActRunDetail {
        id: run.id,
        title: run.title,
        status: run.status,
        stage: run.stage,
        stages: run.stages,
        created_at: run.created_at,
        updated_at: run.updated_at,
        repo_url: run.repo_url,
        error: run.error,
        task,
        agents: raw.get("agents").cloned().unwrap_or(Value::Null),
    })
}

fn response_error(status: u16) -> String {
    format!("ACT returned HTTP {status}")
}

fn truncate_response(text: &str) -> String {
    text.chars().take(300).collect()
}

#[tauri::command]
pub async fn act_list_runs() -> Result<Vec<ActRun>, String> {
    let mut url = endpoint(&["api", "portal", "runs"])?;
    url.query_pairs_mut()
        .append_pair("limit", "25")
        .append_pair("offset", "0");
    let response = client()?
        .get(url)
        .header("x-portal-user", PORTAL_USER)
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(response_error(status));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("ACT returned malformed JSON: {error}"))?;
    let runs = payload
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| "ACT returned no runs list".to_string())?;
    Ok(runs.iter().filter_map(normalize_run).collect())
}

#[tauri::command]
pub async fn act_get_run(run_id: String) -> Result<ActRunDetail, String> {
    let url = endpoint(&["api", "portal", "runs", &run_id])?;
    let response = client()?
        .get(url)
        .header("x-portal-user", PORTAL_USER)
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(response_error(status));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("ACT returned malformed JSON: {error}"))?;
    normalize_run_detail(&payload).ok_or_else(|| "ACT returned a run without an id".to_string())
}

#[tauri::command]
pub async fn act_submit_spec(spec: ActSpecInput) -> Result<ActSubmitOutcome, String> {
    let url = endpoint(&["api", "portal", "specs"])?;
    let response = with_act_token(client()?.post(url).header("x-portal-user", PORTAL_USER))
        .json(&spec)
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    let http_status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("ACT response failed: {error}"))?;
    let payload = serde_json::from_str::<Value>(&text).ok();

    Ok(ActSubmitOutcome {
        accepted: http_status == 200,
        run_id: payload
            .as_ref()
            .and_then(|payload| truthy_string(payload.get("runId"))),
        task_id: payload
            .as_ref()
            .and_then(|payload| truthy_string(payload.get("taskId"))),
        stages: payload.as_ref().and_then(|payload| {
            payload
                .get("stages")
                .and_then(Value::as_array)
                .map(|stages| {
                    stages
                        .iter()
                        .filter_map(|stage| truthy_string(Some(stage)))
                        .collect()
                })
        }),
        complexity: payload
            .as_ref()
            .and_then(|payload| truthy_string(payload.get("complexity"))),
        error: payload
            .as_ref()
            .and_then(|payload| truthy_string(payload.get("error")))
            .or_else(|| payload.is_none().then(|| truncate_response(&text))),
        current_in_flight: payload
            .as_ref()
            .and_then(|payload| payload.get("currentInFlight"))
            .and_then(Value::as_u64),
        limit: payload
            .as_ref()
            .and_then(|payload| payload.get("limit"))
            .and_then(Value::as_u64),
        used_tokens: payload
            .as_ref()
            .and_then(|payload| payload.get("usedTokens"))
            .and_then(Value::as_u64),
        cap_tokens: payload
            .as_ref()
            .and_then(|payload| payload.get("capTokens"))
            .and_then(Value::as_u64),
        remaining_tokens: payload
            .as_ref()
            .and_then(|payload| payload.get("remainingTokens"))
            .and_then(Value::as_u64),
        http_status,
    })
}

#[tauri::command]
pub async fn act_cancel_run(run_id: String) -> Result<u16, String> {
    let url = endpoint(&["api", "portal", "runs", &run_id, "cancel"])?;
    let response = with_act_token(client()?.post(url).header("x-portal-user", PORTAL_USER))
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(failure_with_body(response).await);
    }
    Ok(response.status().as_u16())
}

/// Clear (or archive) a task blocked at ACT's confidence gate. Low-confidence
/// blocks are written by the verification loop straight onto the TASK — no
/// GateManager gate exists for them — so the only route that resolves one is
/// the tasks route: `status: "pending"` releases the block and the run
/// continues; `status: "archived"` drops the work.
#[tauri::command]
pub async fn act_set_task_status(task_id: String, status: String) -> Result<u16, String> {
    const ALLOWED: [&str; 2] = ["pending", "archived"];
    if !ALLOWED.contains(&status.as_str()) {
        return Err(format!("Unsupported task status: {status}"));
    }
    let url = endpoint(&["api", "tasks", &task_id])?;
    let response = with_act_token(client()?.put(url))
        .json(&serde_json::json!({ "status": status }))
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(failure_with_body(response).await);
    }
    Ok(response.status().as_u16())
}

#[tauri::command]
pub async fn act_list_gates(task_id: String) -> Result<Value, String> {
    let mut url = endpoint(&["api", "gates"])?;
    url.query_pairs_mut().append_pair("runId", &task_id);
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(response_error(status));
    }
    response
        .json()
        .await
        .map_err(|error| format!("ACT returned malformed JSON: {error}"))
}

/// Resolve a GateManager gate (pipeline HITL pauses — a different subsystem
/// from the low-confidence task blocks above). `gate_id` is the gate's OWN id
/// from `act_list_gates`, never a task or run id.
#[tauri::command]
pub async fn act_resolve_gate(
    gate_id: String,
    decision: String,
    input: Option<String>,
) -> Result<u16, String> {
    const VALID: [&str; 3] = ["approve", "revise", "skip"];
    if !VALID.contains(&decision.as_str()) {
        return Err(format!("Unsupported gate decision: {decision}"));
    }
    let url = endpoint(&["api", "gates", &gate_id, "resolve"])?;
    let body = ResolveGateBody {
        decision: &decision,
        input: input.as_deref(),
    };
    let response = with_act_token(client()?.post(url))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("ACT request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(failure_with_body(response).await);
    }
    Ok(response.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_named_fields_and_drops_runs_without_an_id() {
        let payload = json!({
            "runs": [
                {
                    "id": "portal-123",
                    "spec": { "title": "Build a portal", "secret": "do not copy" },
                    "status": "running",
                    "stages": [
                        { "name": "plan", "status": "completed", "agentId": "private" },
                        { "name": "build", "status": "running" },
                        { "status": "pending" }
                    ],
                    "createdAt": "2026-08-19T09:00:00.000Z",
                    "updatedAt": "2026-08-19T09:05:00.000Z",
                    "output": { "repoUrl": "https://example.test/repo", "secret": "hidden" },
                    "error": null,
                    "secret": "hidden"
                },
                { "spec": { "title": "Missing id" }, "status": "running" }
            ]
        });

        let normalized: Vec<ActRun> = payload["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(normalize_run)
            .collect();

        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized.first().map(|run| run.id.as_str()),
            Some("portal-123")
        );
        assert_eq!(
            normalized.first().map(|run| run.title.as_str()),
            Some("Build a portal")
        );
        assert_eq!(
            normalized.first().and_then(|run| run.repo_url.as_deref()),
            Some("https://example.test/repo")
        );
        assert_eq!(normalized.first().map(|run| run.stages.len()), Some(2));
    }

    #[test]
    fn selects_the_first_running_stage() {
        let raw = json!({
            "id": "portal-456",
            "stages": [
                { "name": "plan", "status": "completed" },
                { "name": "build", "status": "running" },
                { "name": "review", "status": "running" }
            ]
        });

        assert_eq!(
            normalize_run(&raw).and_then(|run| run.stage),
            Some("build".to_string())
        );
    }

    #[test]
    fn serializes_spec_input_with_camel_case_fields() {
        let spec = ActSpecInput {
            title: "Title".to_string(),
            problem: "Problem".to_string(),
            audience: "Audience".to_string(),
            must_haves: vec!["Must".to_string()],
            non_goals: vec!["Won't".to_string()],
            success_criteria: vec!["Works".to_string()],
        };

        assert_eq!(
            serde_json::to_value(spec).ok(),
            Some(json!({
                "title": "Title",
                "problem": "Problem",
                "audience": "Audience",
                "mustHaves": ["Must"],
                "nonGoals": ["Won't"],
                "successCriteria": ["Works"]
            }))
        );
    }
}
