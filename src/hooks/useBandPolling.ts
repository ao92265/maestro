import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useActStore } from "@/stores/useActStore";
import { useBandStore } from "@/stores/useBandStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** PR polls are `gh` subprocesses; five minutes matches the watchdog cadence. */
export const BAND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * App-level driver for the Home-view data sources (handoffs, PR polls, ACT).
 *
 * Lives in App, not HomeView: the Vanguard snapshot and the TopBar's
 * attention dot need fresh band data whether or not the Home overlay is
 * mounted — a digest built from "whenever Home was last open" would quietly
 * lie about what is blocked.
 *
 * Keyed on the repo set as a joined string, not the tabs array: tab objects
 * are rebuilt on every selection/session change, and each effect restart
 * would fire an immediate refresh AND reset the timer (review fc0e6b9, #3).
 */
export function useBandPolling(): void {
  const repoKey = useWorkspaceStore(
    useShallow((s) => s.tabs.map((t) => t.selectedRepoPath ?? t.projectPath).join("|")),
  );
  const refresh = useBandStore((s) => s.refresh);

  // biome-ignore lint/correctness/useExhaustiveDependencies: repoKey is not read in the body but is the intended trigger — refresh() reads the live tab list from the workspace store, and this effect must re-fire (fetch now, restart the timer) exactly when the set of repos changes.
  useEffect(() => {
    const tick = () => {
      void refresh();
      // ACT piggybacks on the same cadence; its failures are its own state.
      void useActStore.getState().refresh();
    };
    tick();
    const timer = setInterval(tick, BAND_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, repoKey]);
}
