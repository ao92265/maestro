import { useCallback } from "react";
import type { ClosedBatch } from "@/lib/sessionActions";
import { useClosedSessionsStore } from "@/stores/useClosedSessionsStore";
import { useFDAStore } from "@/stores/useFDAStore";
import { type PendingLaunch, usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * Reopen a batch of sessions closed together — the undo for a mis-clicked tab
 * close or a Stop all.
 *
 * This relaunches; it does not resurrect. The PTYs died with the tab, so each
 * recorded session comes back as a fresh CLI in the same directory on the same
 * branch, with its old name. The UI says so — see `ClosedBatchShelf`.
 *
 * Shaped like `useLaunchHandoff` on purpose: same FDA gate, same
 * open-project-then-queue-a-launch contract, same `onNavigate` hand-off, so
 * there is one launch flow to keep correct rather than two.
 */

/**
 * Builds one launch per recorded session.
 *
 * `usePendingLaunchStore` deduplicates identical requests (a guard against
 * double-clicks), and two unnamed sessions in the same directory on the same
 * branch ARE identical — restoring a batch of three would have queued one.
 * Naming them keeps them distinct, and the recorded name is the right one to
 * use where the session had one; the positional fallback is only for sessions
 * that never had a name to lose. Renaming afterwards is already a thing the
 * terminal header does.
 */
export function buildRestoreLaunches(batch: ClosedBatch, tabId: string): PendingLaunch[] {
  return batch.sessions.map((session, index) => ({
    tabId,
    mode: session.mode,
    resumeSessionId: null,
    workingDirOverride: session.workingDirectory,
    branch: session.branch,
    customName: session.name ?? `${batch.projectName} ${index + 1}`,
  }));
}

export function useRestoreClosedBatch(onNavigate: (tabId: string) => void) {
  const requireAccess = useFDAStore((s) => s.requireAccess);

  return useCallback(
    (batch: ClosedBatch) => {
      void requireAccess(batch.projectPath, async () => {
        const ws = useWorkspaceStore.getState();
        if (!ws.getTabByPath(batch.projectPath)) await ws.openProject(batch.projectPath);
        const tab = useWorkspaceStore.getState().getTabByPath(batch.projectPath);
        if (!tab) {
          console.error("Restore closed batch: no tab after openProject", batch.projectPath);
          return;
        }
        for (const launch of buildRestoreLaunches(batch, tab.id)) {
          usePendingLaunchStore.getState().request(launch);
        }
        // Grid must be mounted to consume the requests (JournalSection convention).
        useWorkspaceStore.getState().setSessionsLaunched(tab.id, true);
        /* Drop the shelf entry only once the launches are queued: a restore
           that never got a tab leaves the batch there to try again. */
        useClosedSessionsStore.getState().forget(batch.id);
        onNavigate(tab.id);
      });
    },
    [requireAccess, onNavigate],
  );
}
