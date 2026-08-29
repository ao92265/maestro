import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  type ActivityEvent,
  computeActivity,
  computeFlowScore,
  computeMetrics,
  countPrsOn,
  type FlowDay,
  type FlowScore,
  type PulseInputs,
  type PulseMetrics,
  type PulseRepoActivity,
  type PulseTranscriptStats,
  pulseDateString,
  toPulseSessions,
} from "@/lib/pulse";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * The Pulse view's data: today's git position, today's transcripts, today's
 * PRs, and the flow history the score is read against.
 *
 * Failure convention, borrowed from `useBandStore`/the ACT client: a fetch
 * that fails keeps the previous numbers and records the error. The view wears
 * a stale badge; it never shows an error wall, because an unreadable repo or
 * an unauthenticated `gh` is a normal state on this machine.
 *
 * The flow history is persisted (rohcna kept it in a JSON state file under
 * `~/.claude`; the fork's equivalent is the Tauri store). Without it every
 * restart would re-derive past days from commits alone and lose every score
 * that was ever measured properly.
 *
 * Each source is cached on its own clock, the way rohcna cached metrics, flow
 * and activity separately. Refreshing everything on the view's 30-second tick
 * means walking every transcript and spawning five subprocesses per repo per
 * tick, which on a ten-tab workspace is more work per minute than the numbers
 * are worth — and enough `gh` calls to matter. The derivations themselves are
 * pure and cost nothing, so they are recomputed every tick from whatever the
 * caches hold; only the collection is throttled.
 */

/** Days of commit history fetched, matching the heatmap's window. */
const BACKFILL_DAYS = 14;

/** Cap per repo's PR list — the counters only need today's. */
const PR_LIMIT = 30;

/** Pause between consecutive `gh` invocations (mirrors the watchdog's stagger). */
const PR_STAGGER_MS = 300;

/** Git: four commands per repo. Rohcna's metrics cadence. */
export const GIT_TTL_MS = 60 * 1000;

/** Transcripts: a full walk of today's `~/.claude/projects`. */
export const TRANSCRIPT_TTL_MS = 60 * 1000;

/**
 * Pull requests: one `gh` subprocess per repo, the most expensive source and
 * the only one with a rate limit behind it. PRs also move slowly enough that a
 * minute's resolution buys nothing.
 */
export const PR_TTL_MS = 5 * 60 * 1000;

/** Data older than this wears a stale badge. */
export const PULSE_STALE_MS = 5 * 60 * 1000;

const lazyStore = new LazyStore("pulse-flow-history.json");

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await lazyStore.get<string>(name);
      return value ?? null;
    } catch (err) {
      console.error(`tauriStorage.getItem("${name}") failed:`, err);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.setItem("${name}") failed:`, err);
      throw err;
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.removeItem("${name}") failed:`, err);
      throw err;
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One entry per distinct checkout; a workspace can aim two tabs at one repo. */
function repoPathsFromWorkspace(): string[] {
  const seen = new Set<string>();
  for (const tab of useWorkspaceStore.getState().tabs) {
    seen.add(tab.selectedRepoPath ?? tab.projectPath);
  }
  return [...seen];
}

/**
 * Your PRs across the open projects, one `gh` call per repo.
 *
 * Rohcna ran `gh search prs --author @me` once for every repo at once; the
 * fork has no cross-repo search command, so this walks the open projects with
 * the same author filter. Two worktrees of one repo therefore return the same
 * PRs twice — `countPrsOn` deduplicates by URL rather than this doing it, so
 * the counting rule lives with the counting. A repo without a remote (or
 * without `gh`) simply contributes nothing.
 */
async function fetchOwnPrs(
  repoPaths: string[],
): Promise<{ prs: PullRequestInfo[]; failures: number }> {
  const prs: PullRequestInfo[] = [];
  let failures = 0;
  for (const repoPath of repoPaths) {
    try {
      const list = await invoke<PullRequestInfo[]>("github_list_prs", {
        repoPath,
        state: "all",
        limit: PR_LIMIT,
        search: "author:@me",
      });
      prs.push(...list);
    } catch {
      failures++;
    }
    await sleep(PR_STAGGER_MS);
  }
  return { prs, failures };
}

/** One queued re-run for a refresh that arrived while another was in flight. */
let pendingRefresh = false;

interface PulseState {
  /** Persisted: one score per day, most recently touched last. */
  flowHistory: FlowDay[];
  metrics: PulseMetrics | null;
  flow: FlowScore | null;
  activity: ActivityEvent[];

  /* Cached sources. `*At` is 0 until the first success; `*Key` is the repo
     list the cache was built from, so opening a project refetches rather than
     showing the old set until the TTL happens to lapse. */
  repos: PulseRepoActivity[];
  reposAt: number;
  reposKey: string;
  transcript: PulseTranscriptStats | null;
  transcriptAt: number;
  prs: PullRequestInfo[];
  prsAt: number;
  prsKey: string;

  /** Newest successful refresh of anything; 0 = never. */
  fetchedAt: number;
  /** Last failure, cleared on the next clean pass. */
  error: string | null;
  isRefreshing: boolean;
  /**
   * Refresh whatever has gone stale and recompute. Never rejects.
   * `force` ignores every TTL — what the refresh button does.
   */
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

export const usePulseStore = create<PulseState>()(
  persist(
    (set, get) => ({
      flowHistory: [],
      metrics: null,
      flow: null,
      activity: [],
      repos: [],
      reposAt: 0,
      reposKey: "",
      transcript: null,
      transcriptAt: 0,
      prs: [],
      prsAt: 0,
      prsKey: "",
      fetchedAt: 0,
      error: null,
      isRefreshing: false,

      refresh: async (options) => {
        const force = options?.force === true;
        if (get().isRefreshing) {
          pendingRefresh = true;
          return;
        }
        set({ isRefreshing: true });

        try {
          const repoPaths = repoPathsFromWorkspace();
          const key = repoPaths.join("\n");
          const now = new Date();
          const nowMs = now.getTime();
          const state = get();
          const errors: string[] = [];
          let touched = false;

          if (force || state.reposKey !== key || nowMs - state.reposAt > GIT_TTL_MS) {
            try {
              const repos = await invoke<PulseRepoActivity[]>("pulse_git_activity", {
                repoPaths,
                days: BACKFILL_DAYS,
              });
              set({ repos, reposAt: nowMs, reposKey: key });
              touched = true;
            } catch (err) {
              errors.push(String(err));
            }
          }

          if (force || nowMs - state.transcriptAt > TRANSCRIPT_TTL_MS) {
            try {
              const transcript = await invoke<PulseTranscriptStats>("pulse_transcript_stats");
              set({ transcript, transcriptAt: nowMs });
              touched = true;
            } catch (err) {
              errors.push(String(err));
            }
          }

          if (force || state.prsKey !== key || nowMs - state.prsAt > PR_TTL_MS) {
            const { prs, failures } = await fetchOwnPrs(repoPaths);
            if (repoPaths.length > 0 && failures === repoPaths.length) {
              /* Every repo failed — `gh` is likely unauthenticated, and the
                 shipping factor would be quietly wrong. Keep the last known
                 counts and say so rather than silently reporting zero. */
              errors.push("Pull request counts unavailable (gh)");
            } else {
              set({ prs, prsAt: nowMs, prsKey: key });
              touched = true;
            }
          }

          const current = get();
          if (current.transcript === null) {
            // Nothing has ever loaded; there is nothing to compute from.
            set({ error: errors[0] ?? null });
            return;
          }

          const inputs: PulseInputs = {
            repos: current.repos,
            transcript: current.transcript,
            sessions: toPulseSessions(useSessionStore.getState().sessions),
            prs: countPrsOn(current.prs, pulseDateString(now)),
            now,
          };

          const { flow, history } = computeFlowScore(inputs, current.flowHistory);
          set({
            metrics: computeMetrics(inputs),
            flow,
            activity: computeActivity(inputs),
            flowHistory: history,
            ...(touched ? { fetchedAt: nowMs } : {}),
            error: errors[0] ?? null,
          });
        } catch (err) {
          set({ error: String(err) });
        } finally {
          set({ isRefreshing: false });
          if (pendingRefresh) {
            pendingRefresh = false;
            void get().refresh();
          }
        }
      },
    }),
    {
      name: "maestro-pulse-flow-history",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ flowHistory: state.flowHistory }),
      version: 1,
    },
  ),
);
