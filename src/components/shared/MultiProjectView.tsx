import { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo } from "react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { IdleLandingView } from "./IdleLandingView";
import { TerminalGrid, type TerminalGridHandle } from "../terminal/TerminalGrid";

interface MultiProjectViewProps {
  onSessionCountChange?: (tabId: string, slotCount: number, launchedCount: number) => void;
  /**
   * Eagle view: show every project's terminals at once in one flat grid
   * (tiles color-coded by project) instead of only the active project.
   */
  eagleView?: boolean;
}

export interface MultiProjectViewHandle {
  addSessionToActiveProject: () => void;
  launchAllInActiveProject: () => Promise<void>;
  refreshBranchesInActiveProject: () => void;
}

/**
 * Root content view that renders ALL open projects simultaneously.
 * Uses CSS opacity/pointer-events to show only the active project
 * while keeping terminal state alive in inactive projects (ZStack pattern).
 *
 * This is modeled after the Swift app's MultiProjectContentView which
 * uses a ZStack to preserve terminal NSView state across project switches.
 */
export const MultiProjectView = forwardRef<MultiProjectViewHandle, MultiProjectViewProps>(
  function MultiProjectView({ onSessionCountChange, eagleView = false }, ref) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setSessionsLaunched = useWorkspaceStore((s) => s.setSessionsLaunched);
  const setSelectedRepo = useWorkspaceStore((s) => s.setSelectedRepo);
  const gridRefs = useRef<Map<string, TerminalGridHandle>>(new Map());

  // Eagle view: which pane (if any) is zoomed to fill the window.
  const [eagleZoom, setEagleZoom] = useState<{ tabId: string; slotId: string } | null>(null);

  // Live session count drives the eagle grid's column count.
  const liveSessionCount = useSessionStore((s) => s.sessions.length);

  // Leaving eagle view always drops the zoom.
  useEffect(() => {
    if (!eagleView) setEagleZoom(null);
  }, [eagleView]);

  // Esc exits the eagle zoom back to the grid.
  useEffect(() => {
    if (!eagleView || !eagleZoom) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEagleZoom(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [eagleView, eagleZoom]);

  // Stable per-tab eagle zoom toggles (same pattern as the other callbacks).
  const eagleZoomCallbacks = useMemo(() => {
    const callbacks = new Map<string, (slotId: string) => void>();
    for (const tab of tabs) {
      callbacks.set(tab.id, (slotId: string) => {
        setEagleZoom((prev) =>
          prev && prev.tabId === tab.id && prev.slotId === slotId
            ? null
            : { tabId: tab.id, slotId }
        );
      });
    }
    return callbacks;
  }, [tabs]);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    addSessionToActiveProject: () => {
      const activeTab = tabs.find((t) => t.active);
      if (activeTab) {
        const gridRef = gridRefs.current.get(activeTab.id);
        gridRef?.addSession();
      }
    },
    launchAllInActiveProject: async () => {
      const activeTab = tabs.find((t) => t.active);
      if (activeTab) {
        const gridRef = gridRefs.current.get(activeTab.id);
        await gridRef?.launchAll();
      }
    },
    refreshBranchesInActiveProject: () => {
      const activeTab = tabs.find((t) => t.active);
      if (activeTab) {
        const gridRef = gridRefs.current.get(activeTab.id);
        gridRef?.refreshBranches();
      }
    },
  }), [tabs]);

  // Create stable callbacks per tab to avoid infinite re-render loops
  // The callbacks are memoized by tab.id so they don't change on every render
  const sessionCountChangeCallbacks = useMemo(() => {
    const callbacks = new Map<string, (slotCount: number, launchedCount: number) => void>();
    for (const tab of tabs) {
      callbacks.set(tab.id, (slotCount: number, launchedCount: number) => {
        onSessionCountChange?.(tab.id, slotCount, launchedCount);
      });
    }
    return callbacks;
  }, [tabs, onSessionCountChange]);

  // Stable launch callbacks per tab
  const launchCallbacks = useMemo(() => {
    const callbacks = new Map<string, () => void>();
    for (const tab of tabs) {
      callbacks.set(tab.id, () => {
        setSessionsLaunched(tab.id, true);
      });
    }
    return callbacks;
  }, [tabs, setSessionsLaunched]);

  // Stable all-sessions-closed callbacks per tab
  const allSessionsClosedCallbacks = useMemo(() => {
    const callbacks = new Map<string, () => void>();
    for (const tab of tabs) {
      callbacks.set(tab.id, () => {
        setSessionsLaunched(tab.id, false);
      });
    }
    return callbacks;
  }, [tabs, setSessionsLaunched]);

  // Stable repo change callbacks per tab
  const repoChangeCallbacks = useMemo(() => {
    const callbacks = new Map<string, (path: string) => void>();
    for (const tab of tabs) {
      callbacks.set(tab.id, (path: string) => {
        setSelectedRepo(tab.id, path);
      });
    }
    return callbacks;
  }, [tabs, setSelectedRepo]);

  // Stable ref setters per tab
  const gridRefSetters = useMemo(() => {
    const setters = new Map<string, (handle: TerminalGridHandle | null) => void>();
    for (const tab of tabs) {
      setters.set(tab.id, (handle: TerminalGridHandle | null) => {
        if (handle) {
          gridRefs.current.set(tab.id, handle);
        } else {
          gridRefs.current.delete(tab.id);
        }
      });
    }
    return setters;
  }, [tabs]);

  // No projects open - show simple message
  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-maestro-muted">
          Select a directory to launch Claude Code instances
        </p>
      </div>
    );
  }

  // Eagle view lays every launched pane of every project into one flat grid.
  // The per-project wrappers and split trees flatten out via `display:contents`
  // (className "contents"), so the SAME mounted xterm elements become direct
  // grid items — no remount, scrollback and PTY wiring survive the toggle.
  const eagleColumns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, liveSessionCount))));

  return (
    <div
      className={eagleView ? "h-full w-full bg-maestro-bg p-2" : "relative h-full w-full"}
      style={
        eagleView
          ? {
              display: "grid",
              gridTemplateColumns: `repeat(${eagleColumns}, minmax(0, 1fr))`,
              gridAutoRows: "minmax(0, 1fr)",
              gap: "8px",
            }
          : undefined
      }
    >
      {/* Eagle view with nothing running: every tile is hidden, so give the
          empty grid a hint instead of a blank screen. */}
      {eagleView && liveSessionCount === 0 && (
        <div className="flex h-full items-center justify-center" style={{ gridColumn: "1 / -1" }}>
          <p className="text-sm text-maestro-muted">
            No running terminals — launch sessions to see them here
          </p>
        </div>
      )}

      {/* Render ALL project views in a stacked container (ZStack equivalent).
          In eagle view the stack flattens: launched projects become transparent
          (display:contents) so their panes tile into the grid above; idle
          projects are hidden entirely. */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={
            eagleView
              ? tab.sessionsLaunched
                ? "contents"
                : "hidden"
              : `absolute inset-0 transition-opacity duration-150 ${
                  tab.active
                    ? "opacity-100 pointer-events-auto z-10"
                    : "opacity-0 pointer-events-none z-0"
                }`
          }
          style={
            eagleView
              ? undefined
              : {
                  // Keep in DOM but visually hidden when inactive
                  visibility: tab.active ? "visible" : "hidden",
                }
          }
        >
          {tab.sessionsLaunched ? (
            <TerminalGrid
              ref={gridRefSetters.get(tab.id)}
              tabId={tab.id}
              projectPath={tab.projectPath}
              repoPath={tab.selectedRepoPath ?? undefined}
              repositories={tab.repositories}
              workspaceType={tab.workspaceType}
              onRepoChange={repoChangeCallbacks.get(tab.id)}
              preserveOnHide={true}
              isActive={tab.active}
              onSessionCountChange={sessionCountChangeCallbacks.get(tab.id)}
              onAllSessionsClosed={allSessionsClosedCallbacks.get(tab.id)}
              eagleMode={eagleView}
              projectName={tab.name}
              eagleZoomedSlotId={
                eagleZoom && eagleZoom.tabId === tab.id ? eagleZoom.slotId : null
              }
              onEagleZoomToggle={eagleZoomCallbacks.get(tab.id)}
            />
          ) : (
            <IdleLandingView onAdd={launchCallbacks.get(tab.id)!} />
          )}
        </div>
      ))}
    </div>
  );
});

/**
 * Get a grid handle for a specific tab to call addSession.
 */
export function useMultiProjectGridRef() {
  const gridRefs = useRef<Map<string, TerminalGridHandle>>(new Map());

  return {
    getGridRef: (tabId: string) => gridRefs.current.get(tabId),
    setGridRef: (tabId: string, handle: TerminalGridHandle | null) => {
      if (handle) {
        gridRefs.current.set(tabId, handle);
      } else {
        gridRefs.current.delete(tabId);
      }
    },
  };
}
