import { useCallback } from "react";
import type { HandoffInfo } from "@/lib/bands";
import { useFDAStore } from "@/stores/useFDAStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * The handover nudge typed into the fresh session. Deliberately short: the
 * SessionStart hook injects the full handoff body on its own (rohcna's
 * `handoverPrompt` convention, ported).
 */
function handoverPrompt(h: HandoffInfo): string {
  const where = h.branch ? `${h.repo} on ${h.branch}` : h.repo;
  return `Resume from the injected handoff for ${where}. Confirm branch and working-tree state, then continue the next step.`;
}

/**
 * Resume a handoff snapshot as a live Claude session: open the project if it
 * is not already a tab, queue the launch, and hand the caller the tab to
 * navigate to.
 *
 * Shared because two surfaces offer the same action on the same data (Home's
 * blocked band and the Board's Suggested column), and a second copy of this
 * flow would be a second place for the launch contract to drift.
 *
 * `onNavigate` is where the two differ: each surface closes itself before
 * showing the grid.
 */
export function useLaunchHandoff(onNavigate: (tabId: string) => void) {
  const requireAccess = useFDAStore((s) => s.requireAccess);

  return useCallback(
    (h: HandoffInfo) => {
      void requireAccess(h.path, async () => {
        const ws = useWorkspaceStore.getState();
        if (!ws.getTabByPath(h.path)) await ws.openProject(h.path);
        const tab = useWorkspaceStore.getState().getTabByPath(h.path);
        if (!tab) {
          console.error("Handoff launch: no tab after openProject", h.path);
          return;
        }
        usePendingLaunchStore.getState().request({
          tabId: tab.id,
          mode: "Claude",
          resumeSessionId: null,
          workingDirOverride: h.path,
          branch: h.branch,
          customName: h.slug,
          initialPrompt: handoverPrompt(h),
        });
        // Grid must be mounted to consume the request (JournalSection convention).
        useWorkspaceStore.getState().setSessionsLaunched(tab.id, true);
        onNavigate(tab.id);
      });
    },
    [requireAccess, onNavigate],
  );
}
