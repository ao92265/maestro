import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { BandTab, HandoffInfo, RepoPrs } from "@/lib/bands";
import { isClaudeSession, listDevProcesses } from "@/lib/processes";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * Data the Home view needs beyond the live session store: parked handoffs
 * (Rust `get_handoffs`), per-repo PR polls (merged + changes-requested via
 * `github_list_prs`), and the "since you looked" watermark.
 *
 * Failure convention (borrowed from rohcna's ACT client): a fetch that fails
 * keeps the previous data and records the error — the view shows a stale
 * badge, never an error wall. An unavailable source is a normal state.
 *
 * `refresh` reads the tab list itself via `useWorkspaceStore.getState()`:
 * tab objects are rebuilt on every selection/session change, so a version
 * passed in from a component would drag the caller's effect into re-running
 * per tab mutation (review fc0e6b9, MEDIUM #3).
 */

const WATERMARK_KEY = "maestro-home-watermark";

/** Pause between consecutive `gh` invocations (mirrors the watchdog's stagger). */
const PR_STAGGER_MS = 300;

/** Cap per PR list; the bands only ever show a handful. */
const PR_LIMIT = 20;

/**
 * First run has no watermark. Starting it at "now" means band 2 begins empty
 * and fills with merges that happen from here on — not with the last 20
 * merged PRs per repo regardless of age (review fc0e6b9, MEDIUM #5).
 *
 * Deliberately a writer despite running at store init: the first-ever launch
 * IS the first "look", and persisting it immediately keeps the semantics
 * stable across restarts (an unpersisted default would re-zero the band's
 * meaning of "news" on every app start).
 */
function initWatermark(): number {
  const raw = localStorage.getItem(WATERMARK_KEY);
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const now = Date.now();
  localStorage.setItem(WATERMARK_KEY, String(now));
  return now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One queued re-run for a refresh that arrived while another was in flight. */
let pendingRefresh = false;

function bandTabsFromWorkspace(): BandTab[] {
  return useWorkspaceStore.getState().tabs.map((t) => ({
    id: t.id,
    name: t.name,
    projectPath: t.projectPath,
    selectedRepoPath: t.selectedRepoPath,
  }));
}

interface BandDataState {
  handoffs: HandoffInfo[];
  repoPrs: RepoPrs[];
  /** Newest successful fetch per source; 0 = never. */
  handoffsFetchedAt: number;
  prsFetchedAt: number;
  /** Last failure per source, cleared on the next success. */
  handoffsError: string | null;
  /** Set only when EVERY repo's poll failed; single-repo failures ride on RepoPrs.error. */
  prsError: string | null;
  isRefreshing: boolean;
  watermarkMs: number;
  /**
   * Cwds of claude processes seen running outside a live Maestro session
   * (best-effort liveness detection, `list_dev_processes` watchlist
   * "claude", Maestro-spawned processes excluded via `isMaestro`). Feeds
   * `activeDirs` into `assembleBands`/`assembleBoard`. A scan failure clears
   * the set rather than freezing stale liveness; the unconditional handoff
   * relabel stays the honesty floor.
   */
  externallyActiveDirs: Set<string>;
  /**
   * Last process-scan failure, cleared on the next success. While set,
   * Building may be missing live outside-Maestro work and Suggested may hold
   * handoffs that are actually being worked on; the view shows a stale
   * badge, matching this store's failure convention above.
   */
  processesError: string | null;
  /** Fetch everything once; callers drive the interval. Never rejects. */
  refresh: () => Promise<void>;
  /** "I have looked": merged PRs up to now stop counting as news. */
  markSeen: () => void;
}

export const useBandStore = create<BandDataState>((set, get) => ({
  handoffs: [],
  repoPrs: [],
  handoffsFetchedAt: 0,
  prsFetchedAt: 0,
  handoffsError: null,
  prsError: null,
  isRefreshing: false,
  watermarkMs: initWatermark(),
  externallyActiveDirs: new Set(),
  processesError: null,

  refresh: async () => {
    /* A refresh requested mid-poll is queued, not dropped: opening project B
       while A's multi-repo poll is in flight must not leave B's PRs missing
       until the next 5-minute tick (re-review of 5fbaccc, LOW #1). */
    if (get().isRefreshing) {
      pendingRefresh = true;
      return;
    }
    set({ isRefreshing: true });

    try {
      await invoke<HandoffInfo[]>("get_handoffs").then(
        (handoffs) => set({ handoffs, handoffsFetchedAt: Date.now(), handoffsError: null }),
        (err) => set({ handoffsError: String(err) }),
      );

      /* Best-effort liveness detection: a claude process running outside any
         Maestro session still means the handoff's directory is live. Rides
         this refresh cadence only, never a tighter poll loop. Maestro's own
         spawned sessions are excluded: they are already on the board as
         session cards, not "outside" anything (review finding 2 on 4f3f27a).
         The isClaudeSession gate matters: the Rust matcher also hits on a
         command-line substring, so MCP helpers under node and shells
         sourcing ~/.claude snapshots all come back matched; only the CLI
         itself is claude work (see the predicate's doc for why the process
         name alone cannot decide this). A failed scan clears the set
         instead of freezing stale liveness (finding 3) and records the
         error so Building can wear a stale badge rather than silently
         un-living real work. */
      await listDevProcesses(["claude"]).then(
        (procs) => {
          const dirs = new Set<string>();
          for (const p of procs) {
            if (p.cwd && !p.isMaestro && isClaudeSession(p)) dirs.add(p.cwd);
          }
          set({ externallyActiveDirs: dirs, processesError: null });
        },
        (err) => set({ externallyActiveDirs: new Set<string>(), processesError: String(err) }),
      );

      /* One entry per distinct repo path; a workspace can point two tabs at
         the same checkout. Sequential with a stagger — `gh` calls take 1-3s
         each and a burst of subprocesses helps nobody (watchdog convention). */
      const tabs = bandTabsFromWorkspace();
      const seen = new Set<string>();
      const results: RepoPrs[] = [];
      let successes = 0;
      let lastError: string | null = null;
      for (const tab of tabs) {
        const repoPath = tab.selectedRepoPath ?? tab.projectPath;
        if (seen.has(repoPath)) continue;
        seen.add(repoPath);
        try {
          const merged = await invoke<PullRequestInfo[]>("github_list_prs", {
            repoPath,
            state: "merged",
            limit: PR_LIMIT,
            search: null,
          });
          await sleep(PR_STAGGER_MS);
          const open = await invoke<PullRequestInfo[]>("github_list_prs", {
            repoPath,
            state: "open",
            limit: PR_LIMIT,
            search: null,
          });
          successes += 1;
          results.push({
            repoPath,
            projectName: tab.name,
            merged,
            /* Filter client-side: the CHANGES_REQUESTED decision is already on
               the payload, and one list call per repo beats a second search. */
            changesRequested: open.filter((pr) => pr.reviewDecision === "CHANGES_REQUESTED"),
            error: null,
          });
        } catch (err) {
          /* Repo without a GitHub remote, gh missing, offline — all normal.
             Keep this repo's previous data, mark only this repo as stale
             (review fc0e6b9, MEDIUM #4). */
          lastError = String(err);
          const prev = get().repoPrs.find((r) => r.repoPath === repoPath);
          results.push({
            repoPath,
            projectName: tab.name,
            merged: prev?.merged ?? [],
            changesRequested: prev?.changesRequested ?? [],
            error: lastError,
          });
        }
        await sleep(PR_STAGGER_MS);
      }
      set({
        repoPrs: results,
        prsError: successes === 0 && lastError !== null ? lastError : null,
        ...(successes > 0 || tabs.length === 0 ? { prsFetchedAt: Date.now() } : {}),
      });
    } finally {
      set({ isRefreshing: false });
      if (pendingRefresh) {
        pendingRefresh = false;
        void get().refresh();
      }
    }
  },

  markSeen: () => {
    const now = Date.now();
    localStorage.setItem(WATERMARK_KEY, String(now));
    set({ watermarkMs: now });
  },
}));
