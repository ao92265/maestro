//! Brief FILES for long Samurai instructions (issue #137).
//!
//! Every Samurai instruction is typed into a live `claude` session's PTY, and
//! that write is BLIND: `ProcessManager` exposes no read side, so nothing can
//! confirm a frame landed. `samurai_pty` already types the payload in
//! [`CHUNK_BYTES`](super::samurai_pty::CHUNK_BYTES)-sized frames, yet a
//! multi-KB gen-1 launch brief was still observed arriving as two spliced
//! fragments cut mid-word (2026-08-17) — the middle of the payload never
//! landed and the run started on a headless fragment. No chunk/delay tuning
//! can close that: the only payload size that is genuinely safe is one that
//! fits in a SINGLE frame.
//!
//! So a long instruction stops being typed at all. It is written to a file in
//! the run's worktree and the agent is handed a one-line POINTER at it
//! ([`pointer_instruction`]) — short enough for one frame, and strictly
//! easier for the agent to act on than a paste it may only half receive.
//!
//! The brief lives INSIDE the worktree, under [`BRIEF_DIR`], for three
//! reasons: `.maestro/` is already exempt from the handoff WIP check
//! (`samurai_injector::porcelain_line_blocks`), so a brief file can never
//! block handoff validation; a worktree-relative path needs no Windows
//! quoting and no out-of-project read permission; and it sits next to
//! `.maestro/handoffs/`, which the Second Brain already inventories.
//!
//! The brief file carries the instruction VERBATIM, so any ACK or written
//! marker the instruction demands is inside the file exactly as it would have
//! been typed. A brief the agent never reads simply fails to ACK and walks
//! the existing retry ladder — no new recovery machinery.
//!
//! Only instructions over [`INLINE_MAX_BYTES`] take this route: short ones
//! (handoff request, park, wind-down, corrective) keep today's inline
//! delivery, which works and is well tested. And if the file write fails, the
//! full text is typed exactly as it is today — a warning, never a new failure
//! mode.

use std::path::Path;

/// Brief files live beside handoffs, inside the run worktree. Forward slashes
/// on purpose: the path appears verbatim in the pointer instruction, and
/// `Path::join` accepts them on every platform (same rule as
/// `samurai_prompts::handoff_file_relpath`).
pub const BRIEF_DIR: &str = ".maestro/briefs";

/// Instructions at or under this size keep the existing inline delivery — a
/// payload this small is comfortably delivered by the existing chunked
/// transport, and routing it through a file would add an unread-file failure
/// mode to paths that never had one.
pub const INLINE_MAX_BYTES: usize = 500;

/// Writes `body` to `<worktree>/.maestro/briefs/<name>.md`, creating the
/// directory. Returns the WORKTREE-RELATIVE path — that is what the agent is
/// pointed at, and it needs no quoting.
///
/// An existing brief of the same name is overwritten: a re-staged generation
/// (a dropped spawn event re-emitted, a `--repo` pin swapped in) must leave
/// exactly one brief on disk, the current one.
///
/// The worktree itself is never created — only the brief directory inside it.
/// A path that is not a directory is a caller error (an unresolved or
/// mistyped worktree), and materializing a tree there would leave stray
/// `.maestro/briefs` directories on disk pointing at nothing.
pub fn write_brief(worktree: &Path, name: &str, body: &str) -> Result<String, String> {
    if !worktree.is_dir() {
        return Err(format!(
            "the run worktree {} does not exist — no brief written",
            worktree.display()
        ));
    }
    let dir = worktree.join(BRIEF_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "could not create the brief directory {}: {e}",
            dir.display()
        )
    })?;
    let relpath = format!("{BRIEF_DIR}/{name}.md");
    let path = worktree.join(&relpath);
    std::fs::write(&path, body)
        .map_err(|e| format!("could not write the brief at {}: {e}", path.display()))?;
    Ok(relpath)
}

/// The single-line instruction that points an agent at a brief file.
///
/// Single line by construction, like every other instruction text: a newline
/// inside the payload submits the prompt half-typed. `relpath` is
/// whitespace-normalized for that reason.
pub fn pointer_instruction(relpath: &str) -> String {
    let relpath = relpath.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "[Maestro Samurai] Read `{relpath}` in FULL with the Read tool before doing anything \
         else, then follow it verbatim as your operating instructions for this run. Do not \
         skim it and do not summarise it."
    )
}

/// What is actually typed into the PTY for `instruction`: the instruction
/// itself when it fits the inline budget, otherwise a pointer at a brief file
/// written into `worktree` under `name`.
///
/// A failed write falls back to the full text — the pre-#137 behaviour — so
/// the brief file can only ever improve delivery, never break it.
pub fn deliverable_instruction(worktree: &Path, name: &str, instruction: String) -> String {
    if instruction.len() <= INLINE_MAX_BYTES {
        return instruction;
    }
    match write_brief(worktree, name, &instruction) {
        Ok(relpath) => pointer_instruction(&relpath),
        Err(e) => {
            log::warn!("samurai brief: {e} — typing the full instruction inline instead");
            instruction
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_pty::{chunk_frames, CHUNK_BYTES};
    use tempfile::tempdir;

    /// An instruction long enough to take the file route, with recognizable
    /// ends so a spliced or truncated delivery is visible.
    fn long_instruction() -> String {
        format!(
            "[Maestro Samurai] START {} END",
            "you are generation 1, follow the workflow. ".repeat(40)
        )
    }

    #[test]
    fn test_write_brief_creates_the_directory_and_returns_a_relative_path() {
        let dir = tempdir().unwrap();
        let worktree = dir.path();
        assert!(!worktree.join(BRIEF_DIR).exists());

        let relpath = write_brief(worktree, "gen-1-launch", "# Brief\nbody\n").unwrap();

        assert_eq!(relpath, ".maestro/briefs/gen-1-launch.md");
        assert!(!Path::new(&relpath).is_absolute(), "worktree-relative");
        assert_eq!(
            std::fs::read_to_string(worktree.join(&relpath)).unwrap(),
            "# Brief\nbody\n",
            "the body is written byte for byte"
        );
    }

    #[test]
    fn test_write_brief_overwrites_a_same_named_brief() {
        // A re-staged generation must leave exactly one brief on disk — the
        // current one, not an append of both.
        let dir = tempdir().unwrap();
        let worktree = dir.path();
        write_brief(worktree, "gen-2-ritual", "first").unwrap();
        let relpath = write_brief(worktree, "gen-2-ritual", "second").unwrap();
        assert_eq!(
            std::fs::read_to_string(worktree.join(&relpath)).unwrap(),
            "second"
        );
    }

    #[test]
    fn test_write_brief_reports_a_failed_write() {
        // `.maestro` occupied by a FILE: the directory cannot be created, and
        // the error must name the problem instead of panicking.
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".maestro"), "not a directory").unwrap();
        let err = write_brief(dir.path(), "gen-1-launch", "body").unwrap_err();
        assert!(err.contains("brief"), "unexpected: {err}");
    }

    #[test]
    fn test_write_brief_never_creates_the_worktree() {
        // A mistyped or unresolved worktree must fail loudly, not leave a
        // stray `.maestro/briefs` tree behind at a path nothing runs in.
        let dir = tempdir().unwrap();
        let missing = dir.path().join("no-such-worktree");
        let err = write_brief(&missing, "gen-1-launch", "body").unwrap_err();
        assert!(err.contains("does not exist"), "unexpected: {err}");
        assert!(!missing.exists(), "nothing was created");
    }

    #[test]
    fn test_pointer_is_one_frame_of_plain_text() {
        // The whole point of the file: what gets typed must fit in a SINGLE
        // PTY frame, so no chunk boundary can splice it.
        let pointer = pointer_instruction(".maestro/briefs/gen-11-recovery.md");
        assert!(!pointer.contains('\r'), "a \\r submits it half-typed");
        assert!(!pointer.contains('\n'), "still a single pasteable line");
        assert!(
            pointer.len() < CHUNK_BYTES,
            "pointer must fit one frame, got {} bytes: {pointer}",
            pointer.len()
        );
        assert_eq!(chunk_frames(&pointer), [pointer.as_str()]);
        assert!(pointer.contains(".maestro/briefs/gen-11-recovery.md"));
        // It must send the agent to READ the file, in full, first.
        assert!(pointer.contains("Read"), "{pointer}");
        assert!(pointer.contains("FULL"), "{pointer}");
    }

    #[test]
    fn test_short_instructions_stay_inline_and_write_no_file() {
        // The handoff/park/wind-down path is untouched: today's delivery
        // works and must not grow an unread-file failure mode.
        let dir = tempdir().unwrap();
        let short = "[Maestro Samurai] ".to_string() + &"x".repeat(INLINE_MAX_BYTES - 18);
        assert_eq!(short.len(), INLINE_MAX_BYTES);

        let staged = deliverable_instruction(dir.path(), "gen-1-launch", short.clone());

        assert_eq!(staged, short);
        assert!(!dir.path().join(BRIEF_DIR).exists(), "no brief written");
    }

    #[test]
    fn test_long_instructions_become_a_pointer_at_a_verbatim_brief() {
        let dir = tempdir().unwrap();
        let instruction = long_instruction();
        assert!(instruction.len() > INLINE_MAX_BYTES);

        let staged = deliverable_instruction(dir.path(), "gen-1-launch", instruction.clone());

        assert_eq!(
            staged,
            pointer_instruction(".maestro/briefs/gen-1-launch.md")
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".maestro/briefs/gen-1-launch.md")).unwrap(),
            instruction,
            "the brief on disk is the instruction, byte for byte"
        );
    }

    #[test]
    fn test_a_failed_brief_write_falls_back_to_the_full_text() {
        // No new failure mode: if the file cannot be written, the agent gets
        // exactly what it got before this module existed (and the failure is
        // logged by `deliverable_instruction`).
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".maestro"), "not a directory").unwrap();
        let instruction = long_instruction();

        let staged = deliverable_instruction(dir.path(), "gen-1-launch", instruction.clone());

        assert_eq!(staged, instruction);
    }
}
