import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { BandTab, HandoffInfo, RepoPrs } from "@/lib/bands";
import type { PullRequestInfo } from "@/stores/useGitHubStore";

/**
 * Data the Home view needs beyond the live session store: parked handoffs
 * (Rust `get_handoffs`), per-repo PR polls (merged + changes-requested via
 * `github_list_prs`), and the "since you looked" watermark.
 *
 * Failure convention (borrowed from rohcna's ACT client): a fetch that fails
 * keeps the previous data and records the error — the view shows a stale
 * badge, never an error wall. An unavailable source is a normal state.
 */

const WATERMARK_KEY = "maestro-home-watermark";

/** Pause between consecutive `gh` invocations (mirrors the watchdog's stagger). */
const PR_STAGGER_MS = 300;

/** Cap per PR list; the bands only ever show a handful. */
const PR_LIMIT = 20;

function loadWatermark(): number {
  const raw = localStorage.getItem(WATERMARK_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BandDataState {
  handoffs: HandoffInfo[];
  repoPrs: RepoPrs[];
  /** Newest successful fetch per source; 0 = never. */
  handoffsFetchedAt: number;
  prsFetchedAt: number;
  /** Last failure per source, cleared on the next success. */
  handoffsError: string | null;
  prsError: string | null;
  isRefreshing: boolean;
  watermarkMs: number;
  /** Fetch everything once; callers drive the interval. Never rejects. */
  refresh: (tabs: BandTab[]) => Promise<void>;
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
  watermarkMs: loadWatermark(),

  refresh: async (tabs: BandTab[]) => {
    if (get().isRefreshing) return;
    set({ isRefreshing: true });

    try {
      await invoke<HandoffInfo[]>("get_handoffs").then(
        (handoffs) => set({ handoffs, handoffsFetchedAt: Date.now(), handoffsError: null }),
        (err) => set({ handoffsError: String(err) }),
      );

      /* One entry per distinct repo path; a workspace can point two tabs at
         the same checkout. Sequential with a stagger — `gh` calls take 1-3s
         each and a burst of subprocesses helps nobody (watchdog convention). */
      const seen = new Set<string>();
      const results: RepoPrs[] = [];
      let anyError: string | null = null;
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
          results.push({
            repoPath,
            projectName: tab.name,
            merged,
            /* Filter client-side: the CHANGES_REQUESTED decision is already on
               the payload, and one list call per repo beats a second search. */
            changesRequested: open.filter((pr) => pr.reviewDecision === "CHANGES_REQUESTED"),
          });
        } catch (err) {
          /* Repo without a GitHub remote, gh missing, offline — all normal.
             Keep this repo's previous result if we had one. */
          anyError = String(err);
          const prev = get().repoPrs.find((r) => r.repoPath === repoPath);
          if (prev) results.push(prev);
        }
        await sleep(PR_STAGGER_MS);
      }
      set({
        repoPrs: results,
        prsError: anyError,
        ...(anyError === null ? { prsFetchedAt: Date.now() } : {}),
      });
    } finally {
      set({ isRefreshing: false });
    }
  },

  markSeen: () => {
    const now = Date.now();
    localStorage.setItem(WATERMARK_KEY, String(now));
    set({ watermarkMs: now });
  },
}));
