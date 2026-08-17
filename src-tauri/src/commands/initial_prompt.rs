//! Generic "launch a terminal with an initial prompt" delivery.
//!
//! Any caller can open a terminal through the pending-launch flow and have a
//! prompt of its own typed into the session once claude is actually up. The
//! frontend arms the just-launched session via
//! [`terminal_arm_initial_prompt`] right before the CLI command is typed, and
//! the session's FIRST `SessionStarted` hook signal — claude at its prompt —
//! triggers [`InitialPromptInjector::on_session_started`] (tapped from
//! lib.rs's `hook_emit_fn`, the same gate the replicator uses for successor
//! briefs and the harvest triage uses for its journal prompt).
//!
//! This is [`super::harvest`]'s delivery gate with the journal removed: same
//! arm-then-inject-on-`SessionStarted` shape, the same
//! `core::samurai_pty::submit_instruction_confirmed` delivery (body write
//! confirmed on the calling thread, then the scaled gap and the lone Enter —
//! issue #103), and the same disarm-BEFORE-deliver ordering so a later
//! `SessionStarted` in the same terminal (e.g. `/clear`) can never
//! double-inject. Harvest keeps its own state machine because its prompt is
//! built AT injection time from the live journal and its consumption commit
//! is contingent on the write landing — neither of which a caller-supplied
//! fixed prompt has to model. Both share [`super::harvest::DeliverFn`], so
//! there is exactly one production delivery shape.
//!
//! **PTY safety is enforced here, not at the call site.** A newline inside an
//! injected prompt submits a partial message (the `core::samurai_prompts`
//! rule), so [`normalize_prompt`] collapses every whitespace run — newlines
//! included — to a single space before the text is ever handed to the PTY. A
//! caller cannot get this wrong from TypeScript.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::State;

use super::harvest::DeliverFn;

/// The all-whitespace refusal — pinned by test, surfaced to the caller.
const EMPTY_PROMPT: &str = "Cannot launch with an empty initial prompt.";

/// Flattens a caller-supplied prompt into ONE PTY-safe line: every run of
/// whitespace (`\n`, `\r\n`, tabs, runs of spaces) becomes a single space and
/// leading/trailing whitespace is dropped. `split_whitespace` splits on the
/// Unicode `White_Space` property, so a stray non-breaking space or form feed
/// flattens too — a UI text area produces exactly the sort of multi-line
/// input that would otherwise submit itself half-typed.
pub fn normalize_prompt(prompt: &str) -> String {
    prompt.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The initial-prompt state machine: [`InitialPromptInjector::arm`] stages a
/// just-launched session's prompt, the session's first `SessionStarted` hook
/// signal types it in. Managed as `Arc<InitialPromptInjector>`; the
/// `SessionStarted` tap lives in lib.rs's `hook_emit_fn`.
pub struct InitialPromptInjector {
    deliver: DeliverFn,
    /// Session id → the normalized prompt staged for it, until injected. A
    /// session killed before its `SessionStarted` leaves a stale entry here —
    /// harmless, session ids are never reused within a run.
    armed: Mutex<HashMap<u32, String>>,
}

impl InitialPromptInjector {
    pub fn new(deliver: DeliverFn) -> Self {
        Self {
            deliver,
            armed: Mutex::new(HashMap::new()),
        }
    }

    /// Stages `prompt` for injection on `session_id`'s first
    /// `SessionStarted`. The prompt is normalized here, so what is stored is
    /// already the exact single line that will be typed. Refuses (pinned
    /// message) a prompt that is empty once normalized — arming it would
    /// submit a blank turn. Re-arming the same session before it starts
    /// REPLACES the staged prompt: one session gets one initial prompt.
    pub fn arm(&self, session_id: u32, prompt: &str) -> Result<(), String> {
        let normalized = normalize_prompt(prompt);
        if normalized.is_empty() {
            return Err(EMPTY_PROMPT.to_string());
        }
        self.armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session_id, normalized);
        Ok(())
    }

    /// Injection gate: called with a session's `SessionStarted` signal. An
    /// armed session gets its staged prompt handed to the PTY; anything else
    /// is a no-op. Disarms FIRST, so a later `SessionStarted` in the same
    /// terminal (e.g. `/clear`) can never re-type the prompt. A failed write
    /// is logged and NOT retried — the terminal is open and usable, the user
    /// simply types the prompt themselves.
    ///
    /// Does a blocking PTY write; lib.rs invokes it via `spawn_blocking` so
    /// the hook chain is never parked on it.
    pub fn on_session_started(&self, session_id: u32) {
        let Some(prompt) = self
            .armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session_id)
        else {
            return;
        };
        let chars = prompt.chars().count();
        if let Err(e) = (self.deliver)(session_id, prompt) {
            log::error!(
                "initial prompt: injection into session {session_id} failed: {e} — the terminal is open, the prompt was not typed"
            );
        } else {
            log::info!("initial prompt: injected {chars} chars into session {session_id}");
        }
    }
}

/// Arms a one-shot initial prompt for a just-launched session. TerminalGrid
/// calls this right before it types the CLI command, so the injection gate is
/// set strictly ahead of claude's SessionStart hook — the same ordering the
/// samurai successor registration and the harvest arm rely on. The prompt is
/// whitespace-normalized backend-side; callers may pass multi-line text.
#[tauri::command]
pub fn terminal_arm_initial_prompt(
    injector: State<'_, Arc<InitialPromptInjector>>,
    session_id: u32,
    prompt: String,
) -> Result<(), String> {
    injector.arm(session_id, &prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured `(session_id, prompt)` pairs handed to a stubbed [`DeliverFn`].
    type DeliveredPrompts = Arc<Mutex<Vec<(u32, String)>>>;

    /// An injector whose deliveries are captured, plus the capture handle.
    fn injector() -> (InitialPromptInjector, DeliveredPrompts) {
        let delivered: Arc<Mutex<Vec<(u32, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let deliver: DeliverFn = Arc::new(move |session_id, prompt| {
            sink.lock().unwrap().push((session_id, prompt));
            Ok(())
        });
        (InitialPromptInjector::new(deliver), delivered)
    }

    #[test]
    fn test_normalize_collapses_every_whitespace_run_to_one_space() {
        // THE PTY rule: a newline inside an injected prompt submits a partial
        // message, so nothing but single spaces may survive.
        let normalized = normalize_prompt("  first line\r\nsecond\tline\n\n  third   line \n");
        assert_eq!(normalized, "first line second line third line");
        assert!(!normalized.contains('\n'));
        assert!(!normalized.contains('\r'));
        assert!(!normalized.contains('\t'));
        assert!(!normalized.contains("  "));
        // Already-flat text is untouched.
        assert_eq!(normalize_prompt("review the diff"), "review the diff");
        // Whitespace-only normalizes to nothing (the arm refusal below).
        assert_eq!(normalize_prompt(" \r\n\t "), "");
    }

    #[test]
    fn test_arm_refuses_an_empty_prompt_with_the_pinned_message() {
        let (injector, delivered) = injector();
        assert_eq!(
            injector.arm(7, "   \n\t  ").unwrap_err(),
            "Cannot launch with an empty initial prompt."
        );
        assert_eq!(injector.arm(7, "").unwrap_err(), EMPTY_PROMPT);
        // Nothing armed: a SessionStarted delivers nothing.
        injector.on_session_started(7);
        assert!(delivered.lock().unwrap().is_empty());
    }

    #[test]
    fn test_injection_happens_once_on_the_armed_session_only() {
        let (injector, delivered) = injector();
        injector
            .arm(42, "read CLAUDE.md\nthen summarise it")
            .unwrap();

        // An unrelated session's start delivers nothing.
        injector.on_session_started(99);
        assert!(delivered.lock().unwrap().is_empty());

        // The armed session's start IS the injection — normalized to one line.
        injector.on_session_started(42);
        {
            let d = delivered.lock().unwrap();
            assert_eq!(d.len(), 1);
            assert_eq!(d[0].0, 42);
            assert_eq!(d[0].1, "read CLAUDE.md then summarise it");
        }

        // Disarmed on delivery: a later SessionStarted (e.g. `/clear`) in the
        // same terminal never re-types the prompt.
        injector.on_session_started(42);
        assert_eq!(delivered.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_sessions_keep_their_own_prompts_and_rearm_replaces() {
        let (injector, delivered) = injector();
        injector.arm(1, "prompt one").unwrap();
        injector.arm(2, "prompt two").unwrap();
        // One session gets ONE initial prompt: a re-arm before the session
        // starts replaces, never queues.
        injector.arm(1, "prompt one revised").unwrap();

        injector.on_session_started(2);
        injector.on_session_started(1);
        assert_eq!(
            *delivered.lock().unwrap(),
            vec![
                (2, "prompt two".to_string()),
                (1, "prompt one revised".to_string()),
            ]
        );
    }

    #[test]
    fn test_failed_write_leaves_the_session_disarmed_and_rearmable() {
        // Mirrors the harvest arm: the session is disarmed before delivery,
        // so a failed write injects nothing further, and a fresh arm retries
        // cleanly. Nothing to roll back — no side effect rides on the write.
        let attempts = Arc::new(Mutex::new(0u32));
        let sink = attempts.clone();
        let deliver: DeliverFn = Arc::new(move |_, _| {
            *sink.lock().unwrap() += 1;
            Err("writing instruction to session 7 failed: session not found".to_string())
        });
        let injector = InitialPromptInjector::new(deliver);

        injector.arm(7, "do the thing").unwrap();
        injector.on_session_started(7);
        assert_eq!(*attempts.lock().unwrap(), 1, "one delivery attempt");

        injector.on_session_started(7);
        assert_eq!(*attempts.lock().unwrap(), 1, "disarmed by the attempt");

        injector.arm(7, "do the thing").unwrap();
        injector.on_session_started(7);
        assert_eq!(*attempts.lock().unwrap(), 2, "a fresh arm retries cleanly");
    }
}
