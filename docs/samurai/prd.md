# Maestro "Samurai" — Autonomous Supervisor PRD

| | |
|---|---|
| **Version** | 1.0 — full context of the agreed design |
| **Date** | 2026-08-06 |
| **Branch** | `samurai` (staging branch on `nachogl1/maestro`, parallel to `main`; human merges to `main` after testing) |
| **Docs home** | `docs/samurai/` on the `samurai` branch — every document for this version (PRD, specs, design notes, test notes) lives there |
| **Status** | Design agreed, adversarially critiqued (fresh Fable agent), scope cut, ready to spec as issues |

---

## 1. TL;DR

Maestro becomes the **supervisor brain** of development work. You hand it a GitHub epic (e.g. 15 issues) and it runs unattended for days: per-project **orchestrator** agents spawn subagents to do the work, and Maestro keeps the whole thing alive —

- **Self-healing:** when an orchestrator's context fills to ~40%, Maestro triggers a *handoff* — the agent writes its state to a file and a fresh agent ("next generation") continues with a clean context. We call this **agent replication**; it prevents context pollution and quality decay.
- **Park & resume:** when the token allowance (5-hour window ≥ 90% or 7-day window ≥ 95%) is nearly spent, Maestro *parks* all work and auto-resumes at the exact reset time. No human involved.
- **Audit:** every spawn, handoff, park, resume, completion and alert is recorded and visible in the app, so you oversee everything without digging through internal files.
- **Second Brain:** a frontend panel that shows and manages every file the system creates, plus (Phase 5) an ops journal and periodic "harvest" reports for continuous process improvement.

**Core principle:** Maestro pushes instructions to agents; agents never poll files for signals. Agents only act when a prompt arrives — so the *decision* to heal or park lives in Maestro's Rust backend, which watches the data and injects instructions at the right moment.

---

## 2. Glossary

- **Orchestrator** — the main Claude Code CLI session for an epic. The "brain" that plans and spawns subagents. The thing Maestro supervises.
- **Subagent** — a worker agent the orchestrator spawns for a task (e.g. one issue).
- **Generation (gen-N)** — one orchestrator lifetime. A handoff ends gen-N and starts gen-N+1.
- **Handoff** — the structured state file gen-N writes so gen-N+1 can continue. Also called **agent replication**.
- **Context pollution / rot** — quality degradation as an agent's context window fills. Observed to degrade hard past ~50%.
- **Park** — pausing all work (state written, WIP committed) because token allowance is nearly spent.
- **Allowance windows** — the subscription rate limits: a rolling 5-hour window and a rolling 7-day window, each with a % used and a reset timestamp.
- **Cold-start reconciliation** — on Maestro launch, rebuilding the world from disk: find live epics, respawn what should be running.
- **Statusline / hooks / transcripts** — Claude Code mechanisms Maestro already integrates with (see §4).
- **Worktree** — a separate git checkout of the same repo, so parallel work never collides on branches.
- **Circuit breaker** — a hard rule that stops an agent that is burning tokens without producing progress.
- **Harvest** — the interactive triage of unconsumed ops-journal entries (issue #98): a terminal session Maestro opens with the entries injected, which runs `/insights`, saves the report to Downloads, and discusses keep/file/discard — to improve our processes, skills, and Maestro itself.

---

## 3. Goals

1. **Days-long autonomy:** an epic runs to completion without human touches; the human reviews PRs at the end (a human always makes the merge decision).
2. **No quality decay:** no orchestrator ever works deep into a polluted context.
3. **No wasted allowance:** work resumes the minute tokens refresh; parking happens *before* the window is fully burned.
4. **Full oversight without file spelunking:** everything observable from the app (audit + Second Brain panel).
5. **Self-improvement loop (Phase 5):** bottlenecks, errors and improvement ideas recorded and harvested into actionable reports.

**Non-goals for v1:** model budgeting/routing (Fable/Opus/Sonnet optimization), non-GitHub tracker integrations in Maestro itself, enterprise spend-budget parking, resuming old sessions in place (see Decisions log).

---

## 4. Foundation — what Maestro already has (verified in code)

The design deliberately builds on sensors and mechanisms that already exist in this fork:

- **Usage poll** (`src-tauri/src/commands/usage.rs` + `src/stores/useUsageStore.ts`): polls Anthropic's usage API every 60s — 5h/7d percentages **and reset timestamps**. Works even while sessions are idle.
- **Transcript watcher** (`src-tauri/src/core/transcript_watcher.rs`, `transcript_parser.rs`): tails Claude Code session transcripts, emits per-session token usage (→ context % is derivable) and subagent spawn/complete events.
- **Hooks → status server** (`core/hook_config_writer.rs`, `core/status_server.rs`): SessionStart/SessionEnd/Stop hooks POST to a local HTTP server — Maestro knows when an agent finishes a turn (idle signal).
- **Terminal injection** (`write_stdin` in `core/process_manager.rs`): Maestro can type into a session's terminal. (Blind — hence the idle-gate + ACK protocol, §5.3.)
- **Headless runner** (`commands/ai_runner.rs`): spawns `claude -p` — already used for standup reports and the daily plan. (Harvest no longer uses it: issue #98 moved harvest into an interactive terminal session, §5.12.)
- **Worktree manager** (`core/worktree_manager.rs`), **process kill/scan** (`commands/processes.rs`), **UtilityPanel UI pattern**, **attention mechanism** (`src/lib/healthRules.ts`), **gh runner** (`src-tauri/src/github/runner.rs`).

**Consequence:** the originally-proposed sensor layer (statusline script + telemetry JSONL file + Python pollers) is **deleted from the design** — fully redundant, and it added the worst file-race risks.

---

## 5. Architecture & components

### 5.1 Supervisor model (push, not pull)

Maestro's backend runs the **watchdog**: it watches context % (from transcripts), allowance % (from the usage poll), and transcript staleness (silence detector). When a threshold crosses, Maestro **injects** an instruction into the orchestrator's terminal. Agents never poll signal files — that design fails exactly when the agent is busy.

### 5.2 Per-session supervisor state machine

Every orchestrator session has an explicit state:

```
WORKING → HANDOFF_REQUESTED → HANDOFF_WRITTEN → KILLED → (successor SPAWNED)
WORKING → PARK_REQUESTED   → PARKED (timer armed) → (successor SPAWNED at reset)
any     → DEAD (watchdog)  → (successor SPAWNED in recovery mode)
```

Rules: **one in-flight instruction max**; HANDOFF and PARK are mutually exclusive (if the allowance crosses while a handoff is mid-flight, the handoff completes and the timer is armed — the file doubles as park state). This state machine is the core of the feature; every transition is an audit event.

### 5.3 Injection protocol (idle-gate + ACK)

Maestro types into terminals blindly, so:

1. **Gate on idle:** inject only when the Stop hook says the agent finished its turn (never into a streaming answer, a permission dialog, or a crashed-to-shell terminal).
2. **Require ACK:** the instruction tells the orchestrator to emit a recognizable acknowledgement; the transcript watcher confirms it. No ACK within N minutes → retry once → ALERT.

### 5.4 Self-healing (agent replication)

- **Trigger:** context ≥ **40%** (configurable; see Decisions log — tuned later with audit data, not beliefs).
- Orchestrator lets in-flight subagents finish their current step, writes the handoff file (§6), **commits WIP to the epic branch**.
- Maestro checks only: *file exists + WIP committed* (no template-section validation — a model can emit empty sections; the successor's verify step is the real check).
- Maestro kills gen-N (tree-kill — subagent processes die with it, which is why subagent tasks must be small and idempotent with per-step commits: a kill loses at most one step).
- Maestro spawns **gen-N+1**, whose mandatory first task is to **run the verify commands** from the handoff (never trust claims). Verify is skipped when repo HEAD equals the SHA recorded in the handoff — this kills the per-generation test-suite cost.

### 5.5 Park & resume

- **Soft threshold (~75–80% of 5h window):** stop spawning *new* subagents; prepare to wind down. Parking itself costs several model turns × all orchestrators — waiting until 90% is too late.
- **Hard threshold (5h ≥ 90% or 7d ≥ 95%):** park sequentially (highest-context first): finish atomic step, write/update the handoff file, commit WIP.
- Maestro persists a timer to `schedule.json` for `resets_at + 5 min` (+ per-epic jitter so multiple epics don't resume in a thundering herd). Timers survive app restarts; a fire time that passed during downtime fires immediately on launch.
- **Every wake-up is a fresh spawn from the handoff file.** The `claude --resume` same-session path was dropped (see Decisions log): one recovery path for every death mode.

### 5.6 One recovery path (the pollution answer)

**The handoff file + GitHub are the only two sources of truth. Everything else is disposable.**

Every successor — after handoff, park, crash, machine reboot, or app auto-update — starts with the same ritual:

1. Read run config → 2. Read latest handoff (missing? **recovery mode:** reconstruct from `git log` + GitHub issue comments + a pre-digested transcript summary Maestro extracts — never the raw multi-MB transcript) → 3. Run verify commands (HEAD-gated) → 4. Continue.

**Cold-start reconciliation is a first-class flow, not a fallback:** on every Maestro launch, scan active run configs; for each live epic with no living orchestrator, spawn the next generation via the ritual. This is what makes auto-updates and reboots survivable — they are the *normal* multi-day events. (Auto-update is **not** suppressed — work laptop, security policy. The ledger/audit/handoffs are hardened instead so recovery is always possible.)

### 5.7 Silent-death watchdog & circuit breaker

- **Dead orchestrator detector:** a crashed `claude.exe` fires no hook and the terminal doesn't close — so the watchdog combines transcript-mtime staleness + process-descendant liveness → DEAD → ALERT + recovery spawn.
- **Runaway-burn circuit breaker:** N audit events with zero commits/issue-updates → park + ALERT instead of burning the window at 3am. Also: progress-per-generation is tracked to detect **handoff churn** (a generation that ships almost nothing before handing off again → ALERT).

### 5.8 GitHub-first goals

- Epics and issues live in GitHub (99% case). **Maestro has zero ticket integrations** — the *orchestrator* talks to GitHub via `gh` CLI (reads issues, comments progress, opens PRs). The tracker is one line in the orchestrator prompt (Jira via MCP for the 1% case).
- Maestro stores only a **run config** in app-data: repo, epic ref, model prefs, thresholds, worktree path, `--repo` pin.
- **Preflight at launch:** `gh auth status` OK; allowance windows actually reported by the API (a "no governing window" account is a launch-blocking error); issues declared triaged/agent-ready (they will be — planned with Claude).
- **Periodic `gh auth status` re-check during the run:** corporate SSO tokens expire — on failure: park + ALERT, not a crash loop.
- Issue quality bounds autonomy quality: ambiguous issues make orchestrators guess for days. Issues are planned with Claude and contain enough info — a declared precondition, not something Maestro fixes.

### 5.9 Isolation: one stable worktree per epic

Each epic gets its own git worktree (existing `WorktreeManager`) with a **stable path across generations**. This kills the known shared-checkout hazard (agents switching branches under each other / staging foreign files into WIP commits). Epic completion offers one-click cleanup (worktree + branch) — surfaced in the UI, never silent, because deleting git state is destructive.

**Within-epic issue work is sequential by design** (issue #91): the orchestrator works strictly one issue at a time through the run's workflow — implement via small subagent steps → fresh-eyes review of that issue's diff → QA report committed to the branch → push — before taking up the next issue, then a batch phase (whole-branch review for cross-issue defects → batch QA using the committed per-issue reports → the PR readied for the HUMAN merge decision). The workflow is compiled into every orchestrator brief from the graph the run config snapshots at launch (editable in the launcher; default = the canonical chain above). It is instruction, not machinery — Maestro enforces no steps in v1.

**Completion is DECLARE + VERIFY** (issue #96): the orchestrator declares completion (`<samurai-run-complete>issues #a #b pr #n</samurai-run-complete>`, instructed in every brief), then Maestro verifies the claim via `gh` (every probe pinned with the run's `--repo` pin when one is stored) before flipping the run config ACTIVE → COMPLETED. The run's own process closes issues via `Closes #N` links fired by the HUMAN merge, so "everything closed while the PR is still open" is unreachable by design; the verified matrix is instead: the claimed PR is **OPEN** and every claimed issue is **CLOSED or linked for close by that PR** (`closingIssuesReferences`), OR the PR is already **MERGED** and every claimed issue is **CLOSED** (a merged PR has fired its links — anything still open was not closed by it). Neither an unverified declaration nor GitHub state alone ever flips it. A COMPLETED run shows as finished-awaiting-cleanup, cold-start reconciliation skips it, and the manual cleanup above stays the separate step that archives it.

### 5.10 Audit log

Per-project JSONL in app-data. Events: `SPAWN / HANDOFF / PARK / RESUME / COMPLETE / ALERT` with timestamp, epic, generation, session id, details. **The user deletes audit records manually** (explicit requirement — it is the human oversight surface and the primary testing instrument); a size warning fires when it grows. Orchestrators also comment progress on GitHub issues — a second, human-readable, teammate-visible record.

`COMPLETE` lands at exactly the moment §5.9's verified completion flips the run config ACTIVE → COMPLETED (issue #96). A declaration that fails verification lands an `ALERT` (`completion_verification_failed`) instead, the config stays ACTIVE, and the failed claim is released for retry — an identical re-declaration (e.g. after a transient `gh` failure) verifies again instead of being swallowed by the replay dedupe.

### 5.11 Second Brain panel (frontend)

A new right-side UtilityPanel (same pattern as Memory/Processes/Notes/Standup), two sections:

- **Audit:** the live event stream with generation numbers; clear button.
- **Files:** every managed resource with size + age — handoffs (per repo/epic/generation), pending timers (rendered as "resumes at 14:32"), run configs, journal + harvest reports. Delete-with-confirm; size-threshold warnings via the existing attention mechanism; in-use files (active run) get a harder confirm; one-click "clean this epic".

v1 is deliberately minimal: list, delete, warn. No file-manager ambitions.

### 5.12 Journal & harvest (Phase 5 — in scope)

- **Ops journal** (app-data JSONL): bottlenecks, errors, improvements, skills gaps, concerns — recorded by agents (instructed in orchestrator prompts) and by the user, tagged by category and project.
- **Harvest (interactive, issue #98):** "Harvest now" opens a real terminal session in the active project's main checkout and injects one prompt carrying the unconsumed journal entries, oldest first up to a prompt-size cap — entries beyond the cap stay unconsumed for the next harvest and the prompt states how many were withheld — framed as "investigate whether each is worth acting on and what it is about". The prompt instructs the session to run `/insights` (terminal-only — exactly why the interactive design works where headless could not), save the `/insights` report to the user's Downloads folder named with the run date (`maestro-harvest-insights-<YYYY-MM-DD>.md`), read it back in the same session, and then discuss journal entries and insights together so the user decides keep/file/discard in the terminal. The prior headless `claude -p` report path is retired; previously generated reports stay listed and readable in the Files section.
- Journal entries flip to consumed **at injection** — the moment the prompt lands in the terminal session. A session abandoned mid-triage does NOT restore the undiscussed entries (accepted trade-off). Consumed entries auto-archive after the next harvest, as before.

---

## 6. Handoff file — template

Location: `.maestro/handoffs/<epic>-gen<N>.md` in the epic's worktree (gitignored).

```markdown
# Handoff — epic <ref> — gen <N>
## Goal            <link to GitHub epic + one-line restatement>
## Done            <issues closed, PRs opened — issue numbers, not prose>
## In progress     <per subagent: task, last completed step, next step>
## Decisions + why <choices made and their reasoning>
## Failed attempts <dead ends tried — REQUIRED; prevents successors repeating them>
## Repo state      <branch, HEAD SHA, dirty files if any>
## Verify          <commands to run before trusting any claim above>
## Next steps      <ordered list>
```

Kept lean: pointers (issue numbers, SHAs, paths), never content dumps. GitHub holds what GitHub can hold; the file only carries what GitHub can't (decisions, failed attempts, local state, verify commands).

---

## 7. Thresholds & configuration (all configurable)

| Setting | Default | Note |
|---|---|---|
| Handoff trigger (context %) | **40%** | User-observed decay past 50%; critique argued ~70%. Started at 45%, lowered to 40% after live runs still showed decay; tune with audit data (progress-per-generation). |
| Park soft threshold (5h) | **~75–80%** | Stop new subagent spawns; wind down. |
| Park hard threshold | **5h ≥ 90%**, **7d ≥ 95%** | Sequential parking, highest-context first. |
| Resume time | `resets_at` + 5 min + per-epic jitter | Anti-thundering-herd. |
| ACK timeout | few minutes | Retry once → ALERT. |
| Circuit breaker | N events, zero progress | Park + ALERT. |
| Handoff retention | 14 days after epic completes | Auto-clean. |
| Concurrent epics | start small (1–2) | Allowance is account-wide; epics compete. |

Low thresholds double as the **test mode**: set context to 5% and park to 2% and a full handoff→park→resume cycle runs in minutes, watched live from the audit panel. No simulation machinery.

---

## 8. File inventory & cleanup

| # | File | Where | Cleaner |
|---|---|---|---|
| 1 | Handoff files | epic worktree `.maestro/handoffs/` (gitignored) | **Auto:** 14 days after epic completes; history kept while live |
| 2 | Run configs | app-data | **Auto:** archived at epic completion |
| 3 | `schedule.json` (timers) | app-data | **Auto:** self-cleans when timers fire |
| 4 | Audit log | app-data, per project | **Manual (user)** — by explicit requirement; size warning |
| 5 | Journal + harvest reports | app-data | **Hybrid:** journal auto-archives post-harvest; reports user-deleted |

Machine state → Maestro cleans. Your content / your oversight → only you delete. Not in the design anymore: telemetry file (deleted with the sensor layer), local goal/epic files (GitHub is the source of truth).

Not ours: Claude Code's transcripts (`~/.claude/projects/`) — Claude Code auto-cleans per its retention (~30 days default). The crash-recovery fallback depends on them existing; Maestro pre-digests summaries to reduce that dependency.

---

## 9. Frontend visibility map

**Rule: you see states, events, and files — never the machinery.**

Visible: run launcher (repo, epic ref, model, thresholds, preflight results) · Second Brain panel (audit stream + files) · generation badge, supervisor state and park countdown on terminal tiles / agent graph · attention alerts (breaker, dead agent, gh auth, file size) · allowance display with the 90/95 park lines · harvest reports.

Invisible (backend, surfacing only as events/badges/alerts): watchdog loops, state machine, injection+ACK, scheduler + reconciliation, circuit breaker, gh re-checks, worktree creation.

On disk but not re-rendered in-app (existing tools own them): Claude Code transcripts, hook configs, worktrees/branches (git's domain; one-click cleanup offered), GitHub issues/PRs (Maestro links out). Nothing is hidden from the user — every file lives in a known folder.

---

## 10. Failure modes & mitigations (from the adversarial critique)

| Failure | Mitigation |
|---|---|
| Injection lands in a dialog / crashed shell / mid-answer | Idle-gate + ACK (§5.3) |
| Parking at 90% too late (parking itself costs tokens) | Soft threshold 75–80%, sequential parking |
| Handoff and park collide | State machine, one in-flight instruction, handoff file doubles as park state |
| Killing gen-N kills its subagents (tree-kill) | Small idempotent subagent tasks, per-step commits |
| Subagent internals invisible | Accepted; handoff records launch brief + last committed step only |
| Orchestrator dies silently (no hook fires) | Staleness + process-liveness watchdog |
| Maestro/app/machine dies (auto-update, reboot) | Cold-start reconciliation as primary flow; hardened ledger; **no update suppression** |
| Shared-checkout branch collisions | One stable worktree per epic |
| gh auth expires mid-run | Periodic re-check → park + ALERT |
| Unattended agent with broad permissions | `--dangerously-skip-permissions` accepted **with `--repo` pinned to the fork in every orchestrator prompt** (hard fork-only rule) |
| Thundering-herd resume + repeated test suites | Jittered resumes; HEAD-gated verify skip |
| Runaway token burn / handoff churn | Circuit breaker; progress-per-generation alerts |
| Vague handoffs | Required "failed attempts" section; successor verifies by running commands, not by trusting |
| Successor reads raw multi-MB transcript in recovery | Maestro hands a pre-digested summary |
| Second Brain delete kills live run state | In-use marking + harder confirm |
| Stale usage data (API throttling, up to ~60 min) | 90/95 + soft-threshold margins absorb it |

---

## 11. Decisions log (all user calls, 2026-08-06)

1. Park thresholds: **5h → 90%, 7d → 95%** (from 92/96).
2. **No auto-update suppression** (work laptop, security policy) → recovery-first: hardened audit/ledger + cold-start reconciliation.
3. **Not on enterprise** — 5h/7d parking stands; spend-budget parking deferred until relevant ("when that happens we will talk").
4. Handoff threshold **40% configurable**, tuned later with audit data (vs critique's ~70%).
5. **Template validation gate dropped** — keep only "file exists + WIP committed".
6. **`--resume` same-session path dropped** — every wake-up is a fresh spawn; one recovery path.
7. **Dedicated test-mode machinery dropped** — configurable thresholds are the test mode; user tests live via audit.
8. **Journal/harvest kept in scope** (Phase 5). Model budgeting stays out of v1.
9. Runs use **`--dangerously-skip-permissions`**; blast radius contained by fork-only `--repo` pinning.
10. **Laptop will not sleep** during runs (user-managed).
11. Issues are **agent-ready by construction** (planned with Claude).
12. Sensor layer (statusline script + telemetry file + pollers) **deleted** — build on existing usage poll, transcript watcher, hooks/status server.
13. Work lands on the **`samurai`** staging branch; the user merges to `main` after testing. A human always makes merge decisions.
14. Epics/issues tracked **in GitHub** (99%) — no local goal files; Maestro holds only run configs.
15. Audit records deleted **manually by the user only**.

---

## 12. Worked example

Epic: 15 issues. You write the run config in the launcher, hit start, walk away.

- **T+0** — Preflight passes (gh auth, windows reported). Maestro creates the epic worktree, spawns **gen-1**, audit: `SPAWN`. Gen-1 reads the GitHub epic, validates the issue order, plans — then works the issues strictly ONE at a time through the run's workflow: `dev-issue-101` is implemented (small subagent steps, per-step commits), fresh-eyes reviewed, QA-reported (report committed to the branch) and pushed before `dev-issue-102` begins (within-epic issue work is sequential by design, §5.9).
- **T+3h** — context crosses 40%. Watchdog waits for idle, injects "prepare handoff", gets ACK. Gen-1 lets `dev-issue-103` finish its step, writes `epic12-gen1.md`, commits WIP. Audit: `HANDOFF`. Maestro tree-kills gen-1, spawns **gen-2** at 0% context; gen-2 runs verify (HEAD matches → skipped), continues.
- **T+4.5h** — 5h window hits 78%: soft threshold — no new subagents. At 90%: park. Gen-2 finishes its atomic step, updates the handoff, commits. Audit: `PARK`. Timer armed for reset+5min (persisted to disk).
- **T+5h** — Windows applies an update and reboots. On next Maestro launch, cold-start reconciliation finds the live epic and the pending timer.
- **T+6.5h** — Timer fires. Maestro spawns **gen-3** from the handoff. Audit: `RESUME`. Work continues through the night.
- **T+2 days** — All 15 issues closed, PRs open on the fork. Audit: `COMPLETE`. Panel offers "clean this epic". You review and merge the PRs.

Audit trail you slept through: `SPAWN → HANDOFF → PARK → RESUME → … → COMPLETE`.

---

## 13. Phases

| Phase | Delivers | Acceptance |
|---|---|---|
| **1 — Watchdog + state machine + audit** | Context %/allowance/staleness monitoring wired to a per-session state machine; audit JSONL + events; generation/state badges | States and events visible and correct for a live session; dead-session detection fires |
| **2 — Self-healing** | Injection+ACK, handoff protocol, kill + successor spawn, verify ritual, circuit breaker | With threshold at 5%, a full handoff completes hands-off; successor continues real work; churn alert fires when starved |
| **3 — Park & resume** | Soft/hard thresholds, sequential parking, persisted timers, cold-start reconciliation, worktree-per-epic, run config + launcher + preflight | With park at 2%, park→timer→fresh-spawn cycle survives an app restart in between |
| **4 — Second Brain panel** | Audit + Files sections, delete/confirm, size warnings, clean-this-epic | All §8 files manageable in-app; warnings fire at thresholds |
| **5 — Journal & harvest** | Ops journal, interactive harvest triage session (issue #98; originally headless `claude -p`), prior reports in panel | A harvest injects real journal entries into a live triage session |

Each phase ships and is testable alone. Verification per project rules: run in `npm run tauri dev`, small commits, conventional commits, CI green before merge consideration.

---

## 14. Constraints & ground rules

- **Fork-only:** all pushes/PRs to `nachogl1/maestro`; `--repo` pinned in every orchestrator prompt. Never upstream.
- **Branch:** all Samurai work lands on `samurai` via feature branches/PRs into it; the **human** merges `samurai → main` after testing. No force-push, no `--no-verify`, no merging on red/pending CI.
- **Documentation:** all docs for this version live in `docs/samurai/` on the `samurai` branch — the single place to look for Samurai context.
- **Windows-first:** known `\\?\` canonicalize path handling; tree-kill semantics; file-locking patterns already established in the fork.
- **Smallest change that works;** follow existing fork patterns (UtilityPanel, attention, watchers, runners).
- **Accepted risks:** days-long `--dangerously-skip-permissions` (contained by repo pinning + audit + kill switch); autonomy bounded by the laptop being awake (user keeps it awake); usage data up to ~60 min stale under API throttling (absorbed by margins).
