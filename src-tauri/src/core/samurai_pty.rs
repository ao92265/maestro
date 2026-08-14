//! Shared PTY submission for Samurai instructions.
//!
//! Every Samurai instruction — the gen-1 launch brief, the handoff request,
//! the corrective re-instruction, the wind-down, the park — is delivered by
//! typing it into a live `claude` session's PTY. Until this module existed,
//! each caller wrote `format!("{instruction}\r")` as ONE `write_stdin` call,
//! and that does not submit: the CLI's input reads a single large, fast
//! chunk as a **paste**, so the trailing carriage return lands in the input
//! box as a newline instead of ending the prompt. Observed live — the launch
//! brief sat in the box, fully typed and never sent, and with it every
//! downstream instruction in the supervision chain.
//!
//! The fix is to stop making the submit part of the pasted payload: write
//! the instruction, let the CLI settle out of its paste burst, then write a
//! lone `\r` as its own chunk. Two frames, one gap.
//!
//! [`SUBMIT_DELAY`] is deliberately a constant, not config: it is a property
//! of the CLI's input handling, not a user preference, and a value the user
//! could set to 0 would silently resurrect the original bug.
//!
//! Issue #103: a FIXED gap is not enough either. The gen-1 launch brief is a
//! multi-KB paste, and when the CLI is still consuming the burst 250 ms in,
//! the Enter is read as part of the paste (or dropped) and the brief sits in
//! the input box unsubmitted. The gap therefore scales with the payload
//! ([`submit_delay`]), and the replicator arms a post-delivery check that
//! re-sends the lone Enter ([`resend_submit`]) when no turn ever starts.

use std::time::Duration;

use super::process_manager::ProcessManager;

/// FLOOR of the gap between the instruction text and the Enter that submits
/// it — long enough for the CLI to finish processing a short (< ~0.5 KB)
/// paste burst and return to reading single keys, short enough to stay
/// imperceptible.
pub const SUBMIT_DELAY: Duration = Duration::from_millis(250);

/// CAP on the scaled gap. Past ~4 KiB more waiting stops buying certainty —
/// the drain rate of the CLI's input pipeline is not observable from this
/// side of the PTY (the `ProcessManager` exposes no read side) — so beyond
/// the cap the recovery mechanism is the replicator's Enter-resend check
/// (issue #103), not a longer sleep.
pub const SUBMIT_DELAY_CAP: Duration = Duration::from_secs(2);

/// Pre-Enter gap for a payload of `payload_bytes`: 1 ms per 2 bytes (≈ half
/// a second per KiB), clamped to [`SUBMIT_DELAY`] .. [`SUBMIT_DELAY_CAP`].
///
/// Sizing rationale: 250 ms proved sufficient for short instructions but was
/// observed live (2026-08-12) to lose the Enter after the multi-KB launch
/// brief. The CLI consumes a paste in chunks with re-renders in between, so
/// the time it needs grows with payload size; since nobody is typing in a
/// supervised terminal at delivery time and the write task is
/// fire-and-forget, over-waiting is free while under-waiting strands the
/// run — hence a deliberately generous slope with a hard cap.
pub fn submit_delay(payload_bytes: usize) -> Duration {
    Duration::from_millis(payload_bytes as u64 / 2).clamp(SUBMIT_DELAY, SUBMIT_DELAY_CAP)
}

/// The lone submit frame. Named so the split is greppable from both call
/// sites and the tests that assert on it.
pub const SUBMIT_KEY: &str = "\r";

/// The two frames one instruction is delivered as: the text, then the
/// submit. Pure, so the shape is unit-testable without a PTY — the timing
/// between them is not (no test can prove the CLI's paste heuristic).
pub fn submit_frames(text: &str) -> [String; 2] {
    [text.to_string(), SUBMIT_KEY.to_string()]
}

/// Verdict callback for one submitted instruction (issue #109): invoked with
/// `Ok` the moment the instruction BODY write lands in the PTY, `Err` when it
/// never reached it. Runs on the async runtime, so it must only do queue-push
/// work (audit appends are a channel send, watch arming is a mutex push).
pub type DeliveryOutcome = Box<dyn FnOnce(Result<(), String>) + Send + 'static>;

/// Types `text` into a session's PTY and submits it as a separate write
/// [`submit_delay`]`(text.len())` later.
///
/// `write_stdin` is fully blocking (std mutex + pipe write with no bounded
/// completion time), so both frames run on the blocking pool — the policy
/// every Samurai PTY write already followed. `ctx` names the caller in the
/// warning logs ("injector" / "replicator"), because a half-delivered
/// instruction (text in, Enter lost) looks exactly like the bug this module
/// exists to fix and must be attributable.
///
/// The write itself stays fire-and-forget (the caller has already recorded
/// the attempt in its own pending state), but `outcome` reports the body
/// write's reality back (issue #109): the caller writes its `delivered`
/// audit row — and arms its Enter-resend watch — only on `Ok`, so a failed
/// write can never leave a false 'delivered' trail. Only the BODY write is
/// reported: a swallowed Enter is what the delivery watches recover.
pub fn submit_instruction(
    processes: ProcessManager,
    session_id: u32,
    text: String,
    ctx: &'static str,
    outcome: DeliveryOutcome,
) {
    tauri::async_runtime::spawn(async move {
        let delay = submit_delay(text.len());
        let [body, submit] = submit_frames(&text);
        if let Err(e) = write_frame(&processes, session_id, body, ctx, "instruction").await {
            // The text never landed — sending a bare Enter now would submit
            // whatever the user happened to have typed in that box.
            outcome(Err(e));
            return;
        }
        outcome(Ok(()));
        tokio::time::sleep(delay).await;
        // Enter-frame failures are logged only: the delivery watches (and,
        // for harvest, the user) recover a submit that never landed.
        let _ = write_frame(&processes, session_id, submit, ctx, "submit").await;
    });
}

/// [`submit_instruction`] with a verdict on the frame that matters: writes
/// the instruction body to the session's PTY ON THE CALLING THREAD and
/// returns whether that write landed; only the delayed Enter stays
/// fire-and-forget. For the one caller whose side effects must be contingent
/// on the instruction actually reaching the PTY — the harvest triage, which
/// consumes journal entries only after this returns `Ok` (a fire-and-forget
/// submit would consume entries that were never injected). Samurai briefs
/// keep [`submit_instruction`]: their delivery watches handle retries.
///
/// Only the BODY write is confirmed: an Enter lost after an `Ok` leaves the
/// prompt sitting visibly in the input box (recoverable — the user presses
/// Enter), unlike a lost body, which leaves nothing to recover.
///
/// `write_stdin` is fully blocking (std mutex + pipe write), so callers must
/// already be on the blocking pool — the harvest injection gate runs under
/// `spawn_blocking` (lib.rs's `hook_emit_fn` tap).
pub fn submit_instruction_confirmed(
    processes: ProcessManager,
    session_id: u32,
    text: String,
    ctx: &'static str,
) -> Result<(), String> {
    let delay = submit_delay(text.len());
    let [body, submit] = submit_frames(&text);
    processes
        .write_stdin(session_id, &body)
        .map_err(|e| format!("writing instruction to session {session_id} failed: {e}"))?;
    // The body landed — the delayed Enter follows the fire-and-forget policy
    // of `submit_instruction` (over-waiting is free, and a swallowed Enter is
    // user-recoverable).
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let _ = write_frame(&processes, session_id, submit, ctx, "submit").await;
    });
    Ok(())
}

/// Re-sends ONLY the lone submit key (issue #103): the recovery for an Enter
/// that was swallowed by a still-draining paste burst. NEVER re-sends any
/// instruction body — the text already sits in the CLI's input box, and a
/// re-paste would duplicate the prompt. An extra Enter, by contrast, is
/// harmless when the first one did land (an empty input box ignores it).
pub fn resend_submit(processes: ProcessManager, session_id: u32, ctx: &'static str) {
    tauri::async_runtime::spawn(async move {
        let _ = write_frame(
            &processes,
            session_id,
            SUBMIT_KEY.to_string(),
            ctx,
            "submit-resend",
        )
        .await;
    });
}

/// One frame onto the blocking pool. `Err` = it did not reach the PTY (the
/// failure is logged here either way; the message also travels back so the
/// instruction-body caller can audit it — issue #109).
async fn write_frame(
    processes: &ProcessManager,
    session_id: u32,
    data: String,
    ctx: &'static str,
    frame: &'static str,
) -> Result<(), String> {
    let pm = processes.clone();
    let failure = match tokio::task::spawn_blocking(move || pm.write_stdin(session_id, &data)).await
    {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(e)) => format!("writing {frame} to session {session_id} failed: {e}"),
        Err(e) => format!("{frame} write task for session {session_id} failed: {e}"),
    };
    log::warn!("samurai {ctx}: {failure}");
    Err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_submit_is_a_separate_frame_from_the_instruction() {
        // The whole point: the instruction carries NO submit key, and the
        // submit is a frame of its own. A single `format!("{text}\r")` write
        // is what the CLI mistook for a paste.
        let [body, submit] = submit_frames("[Maestro Samurai] do the thing");
        assert_eq!(body, "[Maestro Samurai] do the thing");
        assert!(!body.contains('\r'), "no submit key inside the payload");
        assert!(!body.contains('\n'), "still a single pasteable line");
        assert_eq!(submit, "\r");
    }

    #[test]
    fn test_submit_delay_is_non_zero() {
        // A zero gap re-merges the two writes into one burst and the CLI
        // treats the pair as a paste again — the original bug.
        assert!(SUBMIT_DELAY > Duration::ZERO);
    }

    #[test]
    fn test_submit_delay_keeps_the_floor_for_short_instructions() {
        // Short instructions keep the exact pre-#103 behavior: the floor.
        assert_eq!(submit_delay(0), SUBMIT_DELAY);
        assert_eq!(submit_delay(100), SUBMIT_DELAY);
        // 1 ms per 2 bytes: the scaled value only overtakes the floor past
        // 500 bytes.
        assert_eq!(submit_delay(500), SUBMIT_DELAY);
        assert!(submit_delay(502) > SUBMIT_DELAY);
    }

    #[test]
    fn test_submit_delay_scales_with_payload_and_is_capped() {
        // A ~2 KiB launch brief gets about a second of settle time.
        assert_eq!(submit_delay(2048), Duration::from_millis(1024));
        // The cap: 4000 bytes hits it exactly, anything bigger stays there.
        assert_eq!(submit_delay(4000), SUBMIT_DELAY_CAP);
        assert_eq!(submit_delay(1_000_000), SUBMIT_DELAY_CAP);
        // Monotone: a longer payload never waits less.
        let mut last = Duration::ZERO;
        for bytes in [0usize, 250, 500, 1000, 2000, 4000, 8000, 100_000] {
            let d = submit_delay(bytes);
            assert!(d >= last, "delay must not shrink at {bytes} bytes");
            last = d;
        }
    }
}
