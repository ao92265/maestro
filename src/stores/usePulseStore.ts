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
 */

/** Days of commit history fetched, matching the heatmap's window. */
const BACKFILL_DAYS = 14;

/** Cap per repo's PR list — the counters only need today's. */
const PR_LIMIT = 30;

/** Pause between consecutive `gh` invocations (the watchdog's stagger). */
const PR_STAGGER_MS = 300;

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
 * the same author filter. A repo without a remote (or without `gh`) simply
 * contributes nothing.
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
  /** Newest successful refresh; 0 = never. */
  fetchedAt: number;
  /** Last failure, cleared on the next success. */
  error: string | null;
  isRefreshing: boolean;
  /** Fetch everything once; callers drive the interval. Never rejects. */
  refresh: () => Promise<void>;
}

export const usePulseStore = create<PulseState>()(
  persist(
    (set, get) => ({
      flowHistory: [],
      metrics: null,
      flow: null,
      activity: [],
      fetchedAt: 0,
      error: null,
      isRefreshing: false,

      refresh: async () => {
        if (get().isRefreshing) {
          pendingRefresh = true;
          return;
        }
        set({ isRefreshing: true });

        try {
          const repoPaths = repoPathsFromWorkspace();
          const now = new Date();

          /* Git and the transcripts are the two required sources: without
             them there are no numbers to show, so a failure here keeps the
             previous ones rather than blanking the view. */
          const [repos, transcript] = await Promise.all([
            invoke<PulseRepoActivity[]>("pulse_git_activity", {
              repoPaths,
              days: BACKFILL_DAYS,
            }),
            invoke<PulseTranscriptStats>("pulse_transcript_stats"),
          ]);

          const { prs, failures } = await fetchOwnPrs(repoPaths);

          const inputs: PulseInputs = {
            repos,
            transcript,
            sessions: toPulseSessions(useSessionStore.getState().sessions, now.getTime()),
            prs: countPrsOn(prs, pulseDateString(now)),
            now,
          };

          const { flow, history } = computeFlowScore(inputs, get().flowHistory);
          set({
            metrics: computeMetrics(inputs),
            flow,
            activity: computeActivity(inputs),
            flowHistory: history,
            fetchedAt: Date.now(),
            /* Every repo's PR poll failing is worth saying — `gh` is likely
               unauthenticated, and the shipping factor is quietly wrong. */
            error:
              repoPaths.length > 0 && failures === repoPaths.length
                ? "Pull request counts unavailable (gh)"
                : null,
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
