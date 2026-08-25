# Quick-open palette (GH-6)

## What was asked

"Add a cmdk quick-open palette across sessions, worktrees and files."

## What shipped

Sessions and worktrees. **Files was not built** — see "Blocked" below.

- `src/lib/quickOpen.ts` — pure data model + fuzzy subsequence matcher (no new dependency).
- `src/hooks/useQuickOpenItems.ts` — assembles rows; fetches worktrees only while the palette is open.
- `src/components/shared/QuickOpenPalette.tsx` — the overlay, modelled on `EagleProjectPickerModal`.
- `Cmd/Ctrl+P` in `useAppKeyboard`, mounted in `App.tsx`. README + in-app `ShortcutsModal` updated.

## Decisions worth remembering

- **Not Cmd/Ctrl+K.** The cmdk convention collides with "clear terminal scrollback"
  (`TerminalView.tsx:746`, documented in the README shortcut table). Used `Cmd/Ctrl+P`,
  the editor quick-open convention. `Alt+P` is already "park terminal" — left alone.
- **No `cmdk` dependency.** `node_modules` here is a symlink into the main checkout shared
  with 3 worktrees, and a dependency add means a lockfile change (a protected path). The
  repo already hand-rolls this exact pattern in `EagleProjectPickerModal`, so the palette
  follows it. Nothing about the feature needed the library.
- **`samePath`, not `===`.** `session.project_path` comes back canonicalized from Rust
  (`\\?\C:\...` on Windows); tabs store the raw path the user opened. `src/lib/path.ts`
  exists precisely for this.
- **Worktrees are 1:1 with sessions** in this app, so a worktree row navigates to the
  session occupying it; one with no session can only select its project tab.

## Failed / dead ends

- **Infinite render loop → OOM.** First version keyed the worktree effect on the `tabs`
  *array identity*. Each fetch set state → re-render → caller rebuilt the array → effect
  refired. The full suite died with "JavaScript heap out of memory"; it survived at 4GB
  only because it never actually terminated. Individual test files passed, which hid it.
  Fixed with a content signature (`tabsKey`) plus a ref for the live value. Regression test
  added. It would *not* have shown up in the app, because Zustand returns a stable
  reference — that's exactly what made it dangerous.
- **`<li role="option">` failed biome a11y.** Switched rows to `<button role="option">`:
  natively focusable and keyboard-activatable, so no suppressions needed.
- Two biome-ignore comments were silently *unused* because I split them across two lines.
  `biome-ignore` must be a single line.

## Next-session start

1. **Files leg is unbuilt and needs a decision** — there is no Tauri command that lists or
   searches project files (196 commands checked; none). `samurai_file_read` is deliberately
   scoped, with a doc comment forbidding widening it into a general-purpose reader. Building
   this means a new filesystem-walk command (gitignore, symlinks, path-escape guards) *and*
   a decision on what "open a file" means — the app has no editor for project files.
2. Confirm the palette visually in the running app; it has never been rendered on screen.
3. Consider whether `Ctrl+P` on Linux/Windows is acceptable — it takes readline's
   "previous command" away from terminals. `Cmd+K`/`Ctrl+K` was already taken the same way,
   so there is precedent, but it is Alex's call.
