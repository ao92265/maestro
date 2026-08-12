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

use std::time::Duration;

use super::process_manager::ProcessManager;

/// Gap between the instruction text and the Enter that submits it — long
/// enough for the CLI to finish processing the paste burst and return to
/// reading single keys, short enough to stay imperceptible.
pub const SUBMIT_DELAY: Duration = Duration::from_millis(250);

/// The lone submit frame. Named so the split is greppable from both call
/// sites and the tests that assert on it.
pub const SUBMIT_KEY: &str = "\r";

/// The two frames one instruction is delivered as: the text, then the
/// submit. Pure, so the shape is unit-testable without a PTY — the timing
/// between them is not (no test can prove the CLI's paste heuristic).
pub fn submit_frames(text: &str) -> [String; 2] {
    [text.to_string(), SUBMIT_KEY.to_string()]
}

/// Types `text` into a session's PTY and submits it as a separate write
/// [`SUBMIT_DELAY`] later.
///
/// `write_stdin` is fully blocking (std mutex + pipe write with no bounded
/// completion time), so both frames run on the blocking pool — the policy
/// every Samurai PTY write already followed. `ctx` names the caller in the
/// warning logs ("injector" / "replicator"), because a half-delivered
/// instruction (text in, Enter lost) looks exactly like the bug this module
/// exists to fix and must be attributable.
///
/// Fire-and-forget by design: the caller has already recorded the attempt in
/// its own pending state, and both delivery ladders (the injector's ACK
/// retry, the replicator's `successor_no_start`) alert on a non-response.
pub fn submit_instruction(
    processes: ProcessManager,
    session_id: u32,
    text: String,
    ctx: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        let [body, submit] = submit_frames(&text);
        if !write_frame(&processes, session_id, body, ctx, "instruction").await {
            // The text never landed — sending a bare Enter now would submit
            // whatever the user happened to have typed in that box.
            return;
        }
        tokio::time::sleep(SUBMIT_DELAY).await;
        write_frame(&processes, session_id, submit, ctx, "submit").await;
    });
}

/// One frame onto the blocking pool. `false` = it did not reach the PTY.
async fn write_frame(
    processes: &ProcessManager,
    session_id: u32,
    data: String,
    ctx: &'static str,
    frame: &'static str,
) -> bool {
    let pm = processes.clone();
    match tokio::task::spawn_blocking(move || pm.write_stdin(session_id, &data)).await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            log::warn!("samurai {ctx}: writing {frame} to session {session_id} failed: {e}");
            false
        }
        Err(e) => {
            log::warn!("samurai {ctx}: {frame} write task for session {session_id} failed: {e}");
            false
        }
    }
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
}
