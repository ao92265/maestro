# Lessons

- **[2026-08-25] React effect keyed on an array prop's identity looped forever**: the
  worktree fetch in `useQuickOpenItems` depended on `tabs`; setting state re-rendered, the
  caller rebuilt the array, and the effect refired — the vitest suite died with
  "JavaScript heap out of memory" while single files passed. → **Fix**: depend on a derived
  content signature (a joined string of the fields that matter) and read the live array
  through a ref. Hidden in the app because Zustand returns a stable reference, so a
  passing app is not evidence here — only a caller that rebuilds the array exposes it.
- **[2026-08-25] Single test files passing hid a suite-wide OOM**: each new test file
  passed alone; only the full run failed. → **Fix**: when a suite OOMs, run the untouched
  baseline (another worktree on main) to prove whether you caused it, then bisect per file
  with a deliberately small `--max-old-space-size` to surface a runaway loop fast.
- **[2026-08-25] `biome-ignore` split across two lines is silently ignored**: biome
  reported both the suppression as unused *and* the original rule as violated. → **Fix**:
  keep the whole `biome-ignore <rule>: <reason>` on one line, however long.
