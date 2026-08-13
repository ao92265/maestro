//! Samurai run completion: DECLARE + VERIFY (issue #96; PRD §5.9/§5.10).
//!
//! Maestro previously had no run-finished state: the only thing that flipped
//! a run config out of ACTIVE was the human's 🗑 cleanup, so after a
//! completed run the next cold start saw ACTIVE + a SPAWN audit row and
//! respawned a recovery successor into the finished worktree (observed after
//! the #76–#84 run). This module closes the loop:
//!
//! 1. **Declare** — every orchestrator brief instructs the model to reply
//!    with `<samurai-run-complete>issues #a #b pr #n</samurai-run-complete>`
//!    once every issue the run works is closed and the run's PR is open
//!    (`samurai_prompts::RUN_COMPLETE_TAG` — the injector's marker idiom).
//!    The declaration carries the CLAIMED issue numbers and PR number, so
//!    verification checks exactly those claims instead of re-deriving the
//!    issue set from the epic ref (which can be an epic issue OR a
//!    comma-separated list).
//! 2. **Verify** — [`SamuraiCompletionWatcher`] scans assistant replies on
//!    the same EventBus tee as the injector, and on a declaration from a
//!    supervised session probes `gh` (injected closures, the
//!    `samurai_auth_watch::AuthProbe` pattern): every claimed issue must be
//!    CLOSED and the claimed PR must be OPEN.
//! 3. **Flip** — only a verified declaration flips the run config
//!    ACTIVE → COMPLETED ([`super::samurai_run_config::RunConfigStore::complete`])
//!    and lands the PRD §5.10 `COMPLETE` audit row. Verification failure
//!    leaves the config ACTIVE and lands an `ALERT` instead. Neither an
//!    unverified declaration nor GitHub state alone ever flips the config.
//!
//! COMPLETED configs vanish from `load_active()`, so cold-start
//! reconciliation (`samurai_reconciler`) skips them entirely; the manual 🗑
//! cleanup (PRD §5.9) stays the separate step that archives them.
//!
//! Replay note: `claude --resume` copies history into a new transcript that
//! is read from byte 0, so an old declaration can re-surface. That is safe
//! by construction — a replayed claim is re-verified against GitHub before
//! anything flips — but each (session, claim) pair is processed once so a
//! replay within one session cannot spam verifications or ALERTs.
//!
//! Issue #93 adds a tiny sibling arm on the same tee: the execution-order
//! deviation alert. When an orchestrator disagrees with the user's issue
//! order it replies with `<samurai-order-alert>original: …; proposed: …;
//! reasoning: …</samurai-order-alert>` and WAITS in its terminal; the
//! watcher turns the tag into an `order_deviation` ALERT audit row — the
//! same surfacing every samurai ALERT gets (audit append →
//! `samurai-audit-event` → the audit stream) — and nothing more: no
//! verification, no config flip, and the user's answer travels back through
//! the terminal, never through Maestro.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;

use super::claude_event::ClaudeEvent;
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_prompts::{ORDER_ALERT_TAG, RUN_COMPLETE_TAG};
use super::samurai_run_config::{RunConfigStatus, RunConfigStore};
use super::supervisor::{SessionSnapshot, Supervisor};

/// `details.kind` of the ALERT row a failed verification lands.
pub const VERIFICATION_FAILED_KIND: &str = "completion_verification_failed";
/// `details.kind` of the ALERT row an unparseable declaration lands.
pub const DECLARATION_INVALID_KIND: &str = "completion_declaration_invalid";
/// `details.kind` of the ALERT row an execution-order deviation lands
/// (issue #93).
pub const ORDER_DEVIATION_KIND: &str = "order_deviation";

/// State of one GitHub issue, e.g. `"CLOSED"` — `gh issue view --json state`
/// via `github::GitHub::get_issue`. Injected so tests never shell out (the
/// `samurai_auth_watch::AuthProbe` pattern); `Err` is a probe failure (gh
/// missing, network), which verification treats as "not confirmed".
pub type IssueStateProbe = Arc<
    dyn Fn(String, u64) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// State of one pull request, e.g. `"OPEN"` — same seam as
/// [`IssueStateProbe`], wired to `github::GitHub::get_pull_request`.
pub type PrStateProbe = Arc<
    dyn Fn(String, u64) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// What the orchestrator claims in its completion declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionClaim {
    /// The issue numbers the run worked — all must be CLOSED.
    pub issues: Vec<u64>,
    /// The run's pull request — must be OPEN.
    pub pr: u64,
}

/// First `<tag>…</tag>` value in `text`, trimmed. Same deliberate plain
/// string scan as the injector's marker extraction — the values are
/// machine-dictated, never free prose.
fn marker_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

/// Pulls a completion declaration out of one assistant reply. `None` = no
/// marker at all (the overwhelmingly common case); `Some(Err)` = a marker is
/// present but its claim cannot be parsed — worth an ALERT, because the
/// orchestrator believes it declared completion and silence would strand the
/// run as ACTIVE forever.
pub fn parse_completion_claim(text: &str) -> Option<Result<CompletionClaim, String>> {
    let value = marker_value(text, RUN_COMPLETE_TAG)?;
    Some(parse_claim_value(&value))
}

/// Tolerant claim parser, `handoff_head_sha` discipline: the instructed
/// shape is `issues #a #b pr #n`, but prose tokens ("issues", "closed",
/// "open"), commas, and missing `#` prefixes are accepted. Every number
/// before the `pr` token is an issue; exactly one number must follow it.
fn parse_claim_value(value: &str) -> Result<CompletionClaim, String> {
    let mut issues: Vec<u64> = Vec::new();
    let mut pr: Option<u64> = None;
    let mut in_pr = false;
    for token in value.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == ':') {
        if token.is_empty() {
            continue;
        }
        if token.eq_ignore_ascii_case("pr") {
            in_pr = true;
            continue;
        }
        let digits = token.trim_start_matches('#');
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue; // prose token — fine either side of the numbers
        }
        let number: u64 = digits
            .parse()
            .map_err(|_| format!("number out of range in declaration: {token:?}"))?;
        if in_pr {
            if pr.is_some() {
                return Err(format!("more than one PR number in declaration {value:?}"));
            }
            pr = Some(number);
        } else if !issues.contains(&number) {
            issues.push(number);
        }
    }
    let Some(pr) = pr else {
        return Err(format!(
            "no PR number in declaration {value:?} — expected `issues #a #b pr #n`"
        ));
    };
    if issues.is_empty() {
        return Err(format!(
            "no issue numbers in declaration {value:?} — expected `issues #a #b pr #n`"
        ));
    }
    Ok(CompletionClaim { issues, pr })
}

/// Folds the probed GitHub states into the list of failed checks (empty =
/// verified). Pure, so the verdict is table-testable without `gh`: an issue
/// passes only when its state reads CLOSED, the PR only when it reads OPEN
/// (a MERGED or CLOSED PR is NOT the pinned "batch PR open" condition — the
/// human decides), and a probe error is "not confirmed", never a pass.
fn claim_failures(
    issue_states: &[(u64, Result<String, String>)],
    pr: u64,
    pr_state: &Result<String, String>,
) -> Vec<String> {
    let mut failures = Vec::new();
    for (number, state) in issue_states {
        match state {
            Ok(s) if s.eq_ignore_ascii_case("closed") => {}
            Ok(s) => failures.push(format!("issue #{number} is {s} (expected CLOSED)")),
            Err(e) => failures.push(format!("issue #{number} state could not be read: {e}")),
        }
    }
    match pr_state {
        Ok(s) if s.eq_ignore_ascii_case("open") => {}
        Ok(s) => failures.push(format!("PR #{pr} is {s} (expected OPEN)")),
        Err(e) => failures.push(format!("PR #{pr} state could not be read: {e}")),
    }
    failures
}

/// The completion scanner + verifier. Observes the same EventBus tee as the
/// injector (`lib.rs` wires `observe` next to `SamuraiInjector::observe`);
/// all verification IO runs on spawned tasks, never inline on the tee.
pub struct SamuraiCompletionWatcher {
    supervisor: Arc<Supervisor>,
    run_configs: Arc<RunConfigStore>,
    audit: AuditLog,
    issue_state: IssueStateProbe,
    pr_state: PrStateProbe,
    /// (session, claim) pairs already handled — a transcript replay must not
    /// re-run a verification or duplicate an ALERT (module doc).
    seen: Mutex<HashSet<(u32, String)>>,
}

impl SamuraiCompletionWatcher {
    pub fn new(
        supervisor: Arc<Supervisor>,
        run_configs: Arc<RunConfigStore>,
        audit: AuditLog,
        issue_state: IssueStateProbe,
        pr_state: PrStateProbe,
    ) -> Self {
        Self {
            supervisor,
            run_configs,
            audit,
            issue_state,
            pr_state,
            seen: Mutex::new(HashSet::new()),
        }
    }

    /// EventBus tee: scan assistant replies for the completion declaration.
    /// Cheap by construction — a plain string scan per reply, in-memory
    /// guards, and everything that touches a file or `gh` is spawned.
    pub fn observe(&self, event: &ClaudeEvent) {
        let ClaudeEvent::AssistantMessage {
            session_id, text, ..
        } = event
        else {
            return;
        };
        // Issue #93: the order-deviation arm rides the same scan. It never
        // returns early, so a (pathological) reply carrying both markers
        // still reaches the completion path below.
        self.observe_order_alert(*session_id, text);
        let Some(parsed) = parse_completion_claim(text) else {
            return;
        };
        // One verification per (session, claim) — see the replay note.
        let raw = marker_value(text, RUN_COMPLETE_TAG).unwrap_or_default();
        {
            let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
            if !seen.insert((*session_id, raw)) {
                return;
            }
        }
        // Only a SUPERVISED session can finish a run — the snapshot names
        // the (project, epic, generation) the config lookup and the audit
        // rows need.
        let Some(session) = self
            .supervisor
            .list_sessions()
            .into_iter()
            .find(|s| s.session_id == *session_id && !s.state.is_terminal())
        else {
            log::warn!(
                "samurai completion: declaration from session {session_id} with no live supervised session — ignored"
            );
            return;
        };
        match parsed {
            Err(reason) => {
                log::warn!(
                    "samurai completion: session {session_id} (epic {}) declared completion but the claim is unparseable: {reason}",
                    session.epic
                );
                self.audit.append(
                    &session.project,
                    AuditEvent::now(
                        session.epic.clone(),
                        AuditEventKind::Alert,
                        session.generation,
                        session.session_id,
                        json!({
                            "kind": DECLARATION_INVALID_KIND,
                            "epic": session.epic,
                            "error": reason,
                        }),
                    ),
                );
            }
            Ok(claim) => self.spawn_verification(session, claim),
        }
    }

    /// Issue #93: `<samurai-order-alert>…</samurai-order-alert>` from a
    /// supervised session lands an ALERT audit row carrying the alert text
    /// (both orders + reasoning — free prose, nothing to parse or verify),
    /// which surfaces through the existing samurai alert path
    /// (`samurai-audit-event` → the audit stream). The run config never
    /// moves: the orchestrator is WAITING in its terminal and the user's
    /// answer travels back through that terminal, never through Maestro. A
    /// tag without its closing half is no marker at all, and a replayed
    /// alert within one session is deduped exactly like a replayed claim
    /// (module doc replay note; the `order-alert:` prefix keeps the two
    /// marker kinds from ever colliding in the seen set).
    fn observe_order_alert(&self, session_id: u32, text: &str) {
        let Some(alert) = marker_value(text, ORDER_ALERT_TAG) else {
            return;
        };
        {
            let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
            if !seen.insert((session_id, format!("order-alert:{alert}"))) {
                return;
            }
        }
        // Same gate as the completion path: only a SUPERVISED session can
        // raise the alert — any terminal could type the marker otherwise.
        let Some(session) = self
            .supervisor
            .list_sessions()
            .into_iter()
            .find(|s| s.session_id == session_id && !s.state.is_terminal())
        else {
            log::warn!(
                "samurai order alert: marker from session {session_id} with no live supervised session — ignored"
            );
            return;
        };
        log::warn!(
            "samurai order alert: session {session_id} (epic {}) proposes an execution-order deviation and is WAITING for the user: {alert}",
            session.epic
        );
        self.audit.append(
            &session.project,
            AuditEvent::now(
                session.epic.clone(),
                AuditEventKind::Alert,
                session.generation,
                session.session_id,
                json!({
                    "kind": ORDER_DEVIATION_KIND,
                    "epic": session.epic,
                    "alert": alert,
                }),
            ),
        );
    }

    /// Runs the `gh` checks off the tee and applies the verdict. The run
    /// config's status is re-read inside the task (file IO), so a duplicate
    /// declaration for an already COMPLETED run is a logged no-op and a
    /// cleanup racing the verification loses nothing —
    /// [`RunConfigStore::complete`] only ever flips ACTIVE.
    fn spawn_verification(&self, session: SessionSnapshot, claim: CompletionClaim) {
        let run_configs = self.run_configs.clone();
        let audit = self.audit.clone();
        let issue_state = self.issue_state.clone();
        let pr_state = self.pr_state.clone();
        tauri::async_runtime::spawn(async move {
            match run_configs
                .get(&session.project, &session.epic)
                .map(|c| c.status)
            {
                Some(RunConfigStatus::Active) => {}
                Some(RunConfigStatus::Completed) => {
                    log::info!(
                        "samurai completion: epic {} in {} is already COMPLETED — duplicate declaration ignored",
                        session.epic,
                        session.project
                    );
                    return;
                }
                other => {
                    log::warn!(
                        "samurai completion: declaration for epic {} in {} but its run config is {:?} — ignored",
                        session.epic,
                        session.project,
                        other
                    );
                    return;
                }
            }
            log::info!(
                "samurai completion: verifying epic {} in {} — issues {:?} closed, PR #{} open",
                session.epic,
                session.project,
                claim.issues,
                claim.pr
            );
            let mut issue_states = Vec::with_capacity(claim.issues.len());
            for number in &claim.issues {
                issue_states.push((*number, issue_state(session.project.clone(), *number).await));
            }
            let pr_result = pr_state(session.project.clone(), claim.pr).await;
            let failures = claim_failures(&issue_states, claim.pr, &pr_result);
            apply_verdict(&run_configs, &audit, &session, &claim, failures);
        });
    }
}

/// Applies one verification verdict: verified → flip the config and land the
/// PRD §5.10 `COMPLETE` row (in that order — the row must never claim a flip
/// that did not happen); failed → the config stays ACTIVE and an `ALERT`
/// names every failed check for the human.
fn apply_verdict(
    run_configs: &Arc<RunConfigStore>,
    audit: &AuditLog,
    session: &SessionSnapshot,
    claim: &CompletionClaim,
    failures: Vec<String>,
) {
    if failures.is_empty() {
        // A cleanup racing the verification can archive the config first —
        // then there is nothing to complete and no COMPLETE row to write.
        if let Err(e) = run_configs.complete(&session.project, &session.epic) {
            log::error!(
                "samurai completion: verification for epic {} in {} passed but the config flip failed: {e}",
                session.epic,
                session.project
            );
            return;
        }
        log::info!(
            "samurai completion: epic {} in {} verified complete — run config flipped ACTIVE → COMPLETED",
            session.epic,
            session.project
        );
        audit.append(
            &session.project,
            AuditEvent::now(
                session.epic.clone(),
                AuditEventKind::Complete,
                session.generation,
                session.session_id,
                json!({
                    "trigger": "declared_verified",
                    "issues": claim.issues,
                    "pr": claim.pr,
                }),
            ),
        );
    } else {
        log::warn!(
            "samurai completion: epic {} in {} declared complete but verification FAILED — config stays ACTIVE: {}",
            session.epic,
            session.project,
            failures.join("; ")
        );
        audit.append(
            &session.project,
            AuditEvent::now(
                session.epic.clone(),
                AuditEventKind::Alert,
                session.generation,
                session.session_id,
                json!({
                    "kind": VERIFICATION_FAILED_KIND,
                    "epic": session.epic,
                    "issues": claim.issues,
                    "pr": claim.pr,
                    "failures": failures,
                }),
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_run_config::SamuraiRunConfig;
    use std::collections::HashMap;
    use std::time::Duration;
    use tempfile::tempdir;

    // --- parsing (pure) ---

    fn declared(value: &str) -> String {
        format!("all done. <{RUN_COMPLETE_TAG}>{value}</{RUN_COMPLETE_TAG}> standing by")
    }

    #[test]
    fn test_parse_completion_claim_accepts_the_instructed_shape() {
        let claim = |value: &str| parse_completion_claim(&declared(value)).unwrap().unwrap();
        // The exact instructed shape.
        assert_eq!(
            claim("issues #77 #78 pr #85"),
            CompletionClaim {
                issues: vec![77, 78],
                pr: 85
            }
        );
        // Tolerant spellings: prose, commas, missing '#', mixed case, one issue.
        assert_eq!(
            claim("issues #77, #78 closed, pr #85 open"),
            CompletionClaim {
                issues: vec![77, 78],
                pr: 85
            }
        );
        assert_eq!(
            claim("Issues 77 78 PR 85"),
            CompletionClaim {
                issues: vec![77, 78],
                pr: 85
            }
        );
        assert_eq!(
            claim("issues #9 pr #10"),
            CompletionClaim {
                issues: vec![9],
                pr: 10
            }
        );
        // Duplicates collapse; order is kept.
        assert_eq!(claim("issues #3 #2 #3 pr #4").issues, vec![3, 2]);
    }

    #[test]
    fn test_parse_completion_claim_rejects_incomplete_claims() {
        let error = |value: &str| {
            parse_completion_claim(&declared(value))
                .unwrap()
                .unwrap_err()
        };
        assert!(error("issues #77 #78").contains("no PR number"));
        assert!(error("pr #85").contains("no issue numbers"));
        assert!(error("issues closed pr open").contains("no PR number"));
        assert!(error("issues #1 pr #2 #3").contains("more than one PR number"));
        assert!(error("").contains("no PR number"));
        // A template echoed with placeholders parses as invalid, not a claim.
        assert!(parse_completion_claim(&declared("issues #<a> #<b> pr #<n>"))
            .unwrap()
            .is_err());
        // Overflow is an error, not a panic.
        assert!(error("issues #99999999999999999999 pr #1").contains("out of range"));
    }

    #[test]
    fn test_parse_completion_claim_ignores_non_declarations() {
        assert_eq!(parse_completion_claim("no marker here"), None);
        assert_eq!(
            parse_completion_claim(&format!("<{RUN_COMPLETE_TAG}>unclosed")),
            None
        );
        assert_eq!(
            parse_completion_claim(&format!("</{RUN_COMPLETE_TAG}>only a close tag")),
            None
        );
        // Another marker kind is not a declaration.
        assert_eq!(
            parse_completion_claim("<samurai-ack>handoff gen-3</samurai-ack>"),
            None
        );
    }

    // --- verdict fold (pure) ---

    #[test]
    fn test_claim_failures_table() {
        let ok = |s: &str| Ok::<String, String>(s.to_string());
        let err = |s: &str| Err::<String, String>(s.to_string());
        // Everything confirmed (case-insensitive states).
        assert!(claim_failures(
            &[(1, ok("CLOSED")), (2, ok("closed"))],
            9,
            &ok("OPEN")
        )
        .is_empty());
        // An open issue fails.
        let failures = claim_failures(&[(1, ok("OPEN"))], 9, &ok("OPEN"));
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("issue #1 is OPEN"));
        // A merged or closed PR is NOT "batch PR open".
        let failures = claim_failures(&[(1, ok("CLOSED"))], 9, &ok("MERGED"));
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("PR #9 is MERGED"));
        // Probe errors are "not confirmed", never a pass — and they stack.
        let failures = claim_failures(
            &[(1, err("gh not found")), (2, ok("OPEN"))],
            9,
            &err("timeout"),
        );
        assert_eq!(failures.len(), 3);
        assert!(failures[0].contains("issue #1 state could not be read"));
        assert!(failures[2].contains("PR #9 state could not be read"));
    }

    // --- watcher (harness: real supervisor/store/audit, scripted probes) ---

    struct Harness {
        watcher: SamuraiCompletionWatcher,
        supervisor: Arc<Supervisor>,
        run_configs: Arc<RunConfigStore>,
        audit: AuditLog,
        /// Every (kind, number) probe call, for count assertions.
        calls: Arc<Mutex<Vec<(&'static str, u64)>>>,
        _dir: tempfile::TempDir,
    }

    /// Probes answer from the given state maps; anything unscripted errors.
    fn harness(
        issue_states: HashMap<u64, Result<String, String>>,
        pr_states: HashMap<u64, Result<String, String>>,
    ) -> Harness {
        let dir = tempdir().unwrap();
        let (audit, task) = AuditLog::new(dir.path().join("audit"), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let run_configs = Arc::new(RunConfigStore::new(dir.path().join("runs")));
        let calls: Arc<Mutex<Vec<(&'static str, u64)>>> = Arc::new(Mutex::new(Vec::new()));
        let issue_calls = calls.clone();
        let issue_state: IssueStateProbe = Arc::new(move |_project, number| {
            issue_calls.lock().unwrap().push(("issue", number));
            let result = issue_states
                .get(&number)
                .cloned()
                .unwrap_or_else(|| Err(format!("unscripted issue #{number}")));
            Box::pin(async move { result })
        });
        let pr_calls = calls.clone();
        let pr_state: PrStateProbe = Arc::new(move |_project, number| {
            pr_calls.lock().unwrap().push(("pr", number));
            let result = pr_states
                .get(&number)
                .cloned()
                .unwrap_or_else(|| Err(format!("unscripted PR #{number}")));
            Box::pin(async move { result })
        });
        let watcher = SamuraiCompletionWatcher::new(
            supervisor.clone(),
            run_configs.clone(),
            audit.clone(),
            issue_state,
            pr_state,
        );
        Harness {
            watcher,
            supervisor,
            run_configs,
            audit,
            calls,
            _dir: dir,
        }
    }

    const PROJECT: &str = "C:/git/proj-complete";

    /// An ACTIVE run config plus a WORKING supervised session for the epic.
    fn launch_epic(h: &Harness, session_id: u32, epic: &str, generation: u32) {
        h.run_configs
            .save(&SamuraiRunConfig::new(
                PROJECT,
                epic,
                format!("{PROJECT}-wt"),
            ))
            .unwrap();
        h.supervisor
            .register_session(session_id, PROJECT.into(), epic.into(), generation)
            .unwrap();
    }

    fn reply(session_id: u32, text: &str) -> ClaudeEvent {
        ClaudeEvent::AssistantMessage {
            session_id,
            uuid: "u".into(),
            text: text.into(),
            model: "opus".into(),
            token_usage: None,
            timestamp: "t".into(),
        }
    }

    /// Polls until `cond` holds or ~2s pass (verification finishes on the
    /// tauri runtime, not this test's — the reconciler suite's pattern).
    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached within 2s");
    }

    async fn rows(audit: &AuditLog, kind: AuditEventKind) -> Vec<AuditEvent> {
        audit
            .read(PROJECT, None, None)
            .await
            .unwrap()
            .events
            .into_iter()
            .filter(|e| e.event == kind)
            .collect()
    }

    /// Polls until at least one ALERT row lands (the async twin of
    /// `wait_until` — the audit read is itself an await).
    async fn wait_for_alerts(audit: &AuditLog) -> Vec<AuditEvent> {
        for _ in 0..200 {
            let alerts = rows(audit, AuditEventKind::Alert).await;
            if !alerts.is_empty() {
                return alerts;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("ALERT did not land within 2s");
    }

    fn status(h: &Harness, epic: &str) -> RunConfigStatus {
        h.run_configs.get(PROJECT, epic).unwrap().status
    }

    #[tokio::test]
    async fn test_verified_declaration_flips_config_and_lands_complete_row() {
        let h = harness(
            HashMap::from([
                (77, Ok("CLOSED".to_string())),
                (78, Ok("CLOSED".to_string())),
            ]),
            HashMap::from([(85, Ok("OPEN".to_string()))]),
        );
        launch_epic(&h, 4, "#38", 3);

        h.watcher
            .observe(&reply(4, &declared("issues #77 #78 pr #85")));

        wait_until(|| status(&h, "#38") == RunConfigStatus::Completed).await;
        let complete = rows(&h.audit, AuditEventKind::Complete).await;
        assert_eq!(complete.len(), 1);
        assert_eq!(complete[0].epic, "#38");
        assert_eq!(complete[0].generation, 3);
        assert_eq!(complete[0].session_id, 4);
        assert_eq!(complete[0].details["trigger"], "declared_verified");
        assert_eq!(complete[0].details["issues"], json!([77, 78]));
        assert_eq!(complete[0].details["pr"], 85);
        assert!(rows(&h.audit, AuditEventKind::Alert).await.is_empty());
    }

    #[tokio::test]
    async fn test_open_issue_fails_verification_and_stays_active() {
        let h = harness(
            HashMap::from([
                (77, Ok("CLOSED".to_string())),
                (78, Ok("OPEN".to_string())),
            ]),
            HashMap::from([(85, Ok("OPEN".to_string()))]),
        );
        launch_epic(&h, 4, "#38", 2);

        h.watcher
            .observe(&reply(4, &declared("issues #77 #78 pr #85")));

        let alerts = wait_for_alerts(&h.audit).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["kind"], VERIFICATION_FAILED_KIND);
        assert_eq!(alerts[0].details["issues"], json!([77, 78]));
        assert_eq!(alerts[0].details["pr"], 85);
        let failures = alerts[0].details["failures"].as_array().unwrap();
        assert_eq!(failures.len(), 1);
        assert!(failures[0].as_str().unwrap().contains("issue #78 is OPEN"));
        // The config NEVER flips on a failed verification.
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);
        assert!(rows(&h.audit, AuditEventKind::Complete).await.is_empty());
    }

    #[tokio::test]
    async fn test_missing_pr_fails_verification_and_stays_active() {
        // The PR probe errors (e.g. the PR does not exist) — "not
        // confirmed" is a failure, never a pass.
        let h = harness(
            HashMap::from([(77, Ok("CLOSED".to_string()))]),
            HashMap::new(),
        );
        launch_epic(&h, 4, "#38", 1);

        h.watcher.observe(&reply(4, &declared("issues #77 pr #85")));

        let alerts = wait_for_alerts(&h.audit).await;
        assert_eq!(alerts[0].details["kind"], VERIFICATION_FAILED_KIND);
        let failures = alerts[0].details["failures"].as_array().unwrap();
        assert!(failures[0]
            .as_str()
            .unwrap()
            .contains("PR #85 state could not be read"));
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);
    }

    #[tokio::test]
    async fn test_unsupervised_session_and_plain_replies_are_ignored() {
        let h = harness(HashMap::new(), HashMap::new());
        launch_epic(&h, 4, "#38", 1);

        // A declaration from a session nobody supervises must not verify,
        // flip, or alert — any terminal could type the marker otherwise.
        h.watcher
            .observe(&reply(99, &declared("issues #77 pr #85")));
        // And an ordinary reply is not a declaration at all.
        h.watcher.observe(&reply(4, "just working along"));

        // Deterministic settle: a later valid observe would queue behind
        // these on the audit channel; give the spawned paths a moment.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(h.calls.lock().unwrap().is_empty(), "no gh probe may run");
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);
        assert!(rows(&h.audit, AuditEventKind::Alert).await.is_empty());
        assert!(rows(&h.audit, AuditEventKind::Complete).await.is_empty());
    }

    #[tokio::test]
    async fn test_malformed_declaration_from_supervised_session_alerts() {
        let h = harness(HashMap::new(), HashMap::new());
        launch_epic(&h, 4, "#38", 2);

        h.watcher.observe(&reply(4, &declared("issues #77 #78")));

        let alerts = wait_for_alerts(&h.audit).await;
        assert_eq!(alerts[0].details["kind"], DECLARATION_INVALID_KIND);
        assert!(alerts[0].details["error"]
            .as_str()
            .unwrap()
            .contains("no PR number"));
        assert_eq!(alerts[0].generation, 2);
        assert!(h.calls.lock().unwrap().is_empty(), "nothing to verify");
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);
    }

    #[tokio::test]
    async fn test_replayed_claim_verifies_once_per_session() {
        // `claude --resume` replays the transcript from byte 0, so the same
        // declaration message can be observed again — one verification.
        let h = harness(
            HashMap::from([(77, Ok("CLOSED".to_string()))]),
            HashMap::from([(85, Ok("OPEN".to_string()))]),
        );
        launch_epic(&h, 4, "#38", 1);

        let text = declared("issues #77 pr #85");
        h.watcher.observe(&reply(4, &text));
        h.watcher.observe(&reply(4, &text));

        wait_until(|| status(&h, "#38") == RunConfigStatus::Completed).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            h.calls.lock().unwrap().len(),
            2,
            "one issue probe + one PR probe — the replay is deduped"
        );
        assert_eq!(rows(&h.audit, AuditEventKind::Complete).await.len(), 1);
    }

    // --- issue #93: execution-order deviation alerts ---

    fn order_alert(value: &str) -> String {
        format!("stopping here. <{ORDER_ALERT_TAG}>{value}</{ORDER_ALERT_TAG}> waiting")
    }

    #[tokio::test]
    async fn test_order_alert_lands_alert_row_and_config_stays_active() {
        let h = harness(HashMap::new(), HashMap::new());
        launch_epic(&h, 4, "#38", 1);

        let value = "original: #76 #77; proposed: #77 #76; reasoning: #77 blocks #76";
        h.watcher.observe(&reply(4, &order_alert(value)));

        let alerts = wait_for_alerts(&h.audit).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["kind"], ORDER_DEVIATION_KIND);
        assert_eq!(alerts[0].details["alert"], value);
        assert_eq!(alerts[0].epic, "#38");
        assert_eq!(alerts[0].generation, 1);
        assert_eq!(alerts[0].session_id, 4);
        // Surfacing only: no gh probe, no config flip, no COMPLETE row.
        assert!(h.calls.lock().unwrap().is_empty(), "no gh probe may run");
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);
        assert!(rows(&h.audit, AuditEventKind::Complete).await.is_empty());
    }

    #[tokio::test]
    async fn test_order_alert_malformed_unsupervised_and_replayed_are_contained() {
        let h = harness(HashMap::new(), HashMap::new());
        launch_epic(&h, 4, "#38", 1);

        // A tag without its closing half is no marker at all — no ALERT,
        // no flip, no panic.
        h.watcher
            .observe(&reply(4, &format!("<{ORDER_ALERT_TAG}>unclosed")));
        // A session nobody supervises cannot raise the alert.
        h.watcher
            .observe(&reply(99, &order_alert("original: 1; proposed: 2; reasoning: x")));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(rows(&h.audit, AuditEventKind::Alert).await.is_empty());
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);

        // A replayed alert (`claude --resume` re-reads the transcript from
        // byte 0) lands exactly ONE row.
        let text = order_alert("original: #1 #2; proposed: #2 #1; reasoning: deps");
        h.watcher.observe(&reply(4, &text));
        h.watcher.observe(&reply(4, &text));
        let alerts = wait_for_alerts(&h.audit).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(status(&h, "#38"), RunConfigStatus::Active);
    }

    #[tokio::test]
    async fn test_declaration_for_a_completed_config_is_a_noop() {
        // A successor replaying its predecessor's declaration arrives under
        // a NEW session id (the dedupe cannot catch it) — the config status
        // gate must make it a logged no-op, not a second COMPLETE row.
        let h = harness(
            HashMap::from([(77, Ok("CLOSED".to_string()))]),
            HashMap::from([(85, Ok("OPEN".to_string()))]),
        );
        launch_epic(&h, 4, "#38", 1);
        h.run_configs.complete(PROJECT, "#38").unwrap();

        h.watcher.observe(&reply(4, &declared("issues #77 pr #85")));

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(rows(&h.audit, AuditEventKind::Complete).await.is_empty());
        assert!(rows(&h.audit, AuditEventKind::Alert).await.is_empty());
        assert_eq!(status(&h, "#38"), RunConfigStatus::Completed);
    }
}
