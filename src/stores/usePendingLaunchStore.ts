import { create } from "zustand";
import type { AiMode } from "@/stores/useSessionStore";

/**
 * A one-shot request, made from outside the terminal grid (e.g. the sidebar
 * History tab), to create a pre-configured slot in a project's grid and
 * launch it immediately. The grid for `tabId` consumes the request on mount
 * or as soon as it arrives — this indirection works whether or not the grid
 * is currently mounted, which the imperative grid handle cannot do.
 */
export interface PendingLaunch {
  tabId: string;
  mode: AiMode;
  /** Claude conversation UUID to resume, or null for a fresh session. */
  resumeSessionId: string | null;
  /** Launch in this exact directory (an existing worktree) instead of deriving one. */
  workingDirOverride: string | null;
  /** Branch shown in the session header when launching into a worktree. */
  branch: string | null;
}

interface PendingLaunchState {
  pending: PendingLaunch | null;
  request: (launch: PendingLaunch) => void;
  /** Atomically claim the pending launch for a tab; null when none is queued for it. */
  consume: (tabId: string) => PendingLaunch | null;
}

export const usePendingLaunchStore = create<PendingLaunchState>((set, get) => ({
  pending: null,
  request: (launch) => set({ pending: launch }),
  consume: (tabId) => {
    const pending = get().pending;
    if (!pending || pending.tabId !== tabId) return null;
    set({ pending: null });
    return pending;
  },
}));
