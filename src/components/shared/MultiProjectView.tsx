import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { IdleLandingView } from "./IdleLandingView";
import { TerminalGrid, type TerminalGridHandle } from "../terminal/TerminalGrid";
import { ThinkingIndicator } from "../terminal/ThinkingIndicator";

/** Stable empty record so the names selector doesn't re-render grids while the bar is hidden. */
const EMPTY_SESSION_NAMES: Record<number, string> = {};

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
  /** Add a pre-launch slot to the given project (mounting its grid if idle). False if the tab doesn't exist. */
  addSessionInProject: (tabId: string) => boolean;
  launchAllInActiveProject: () => Promise<void>;
  refreshBranchesInActiveProject: () => void;
  /** Focus the pane running the given session. False if that grid isn't mounted or doesn't own it. */
  focusSessionInProject: (tabId: string, sessionId: number) => boolean;
  /** Kill the given session (with full pane cleanup). False if that grid isn't mounted or doesn't own it. */
  killSessionInProject: (tabId: string, sessionId: number) => boolean;
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

  // Eagle view: which session (if any) is zoomed to fill the window.
  // Keyed by backend session ID (globally unique across projects) so the
  // global zoom tab bar can be built purely from the stores.
  const [eagleZoom, setEagleZoom] = useState<number | null>(null);

  // Live session count drives the eagle grid's column count. Gated on
  // eagleView so session launches/kills don't re-render every project's grid
  // while the eagle grid isn't even showing.
  const liveSessionCount = useSessionStore((s) => (eagleView ? s.sessions.length : 0));

  // Leaving eagle view always drops the zoom.
  useEffect(() => {
    if (!eagleView) setEagleZoom(null);
  }, [eagleView]);

  // All running sessions across projects in tab/launch order — drives the
  // global zoom tab bar and Alt+Arrow cycling.
  const projectColors = useProjectColors();
  const eagleSessions = useMemo(() => {
    if (!eagleView) return [];
    const list: { sessionId: number; projectName: string; color: string }[] = [];
    for (const tab of tabs) {
      if (!tab.sessionsLaunched) continue;
      for (const sessionId of tab.sessionIds) {
        list.push({
          sessionId,
          projectName: tab.name,
          color: projectColors.get(tab.name) ?? projectColorFor(tab.name),
        });
      }
    }
    return list;
  }, [eagleView, tabs, projectColors]);

  // Session names for the tab labels. Derived record + shallow compare so the
  // raw sessions array (replaced on every status update) doesn't re-render
  // every grid; only visible while the bar is showing.
  const sessionNames = useSessionStore(
    useShallow((s) => {
      if (!eagleView || eagleZoom === null) return EMPTY_SESSION_NAMES;
      const names: Record<number, string> = {};
      for (const sess of s.sessions) {
        if (sess.name) names[sess.id] = sess.name;
      }
      return names;
    })
  );

  // Stale-zoom guard: if the zoomed session disappears (killed), drop the
  // zoom — otherwise every tile stays visibility:hidden and the view blanks.
  useEffect(() => {
    if (eagleZoom === null) return;
    if (!eagleSessions.some((s) => s.sessionId === eagleZoom)) setEagleZoom(null);
  }, [eagleZoom, eagleSessions]);

  // Keyboard while eagle-zoomed. Capture phase: xterm stops propagation on
  // keys it handles, so bubble-phase Alt+Arrow would never fire while a
  // terminal has focus. Esc deliberately does NOT exit zoom — the focused
  // terminal needs it (e.g. interrupting Claude); exit via the tab bar's
  // close button or by clicking the active tab.
  useEffect(() => {
    if (!eagleView || eagleZoom === null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const idx = eagleSessions.findIndex((s) => s.sessionId === eagleZoom);
      if (idx < 0 || eagleSessions.length === 0) return;
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = eagleSessions[(idx + delta + eagleSessions.length) % eagleSessions.length];
      setEagleZoom(next.sessionId);
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [eagleView, eagleZoom, eagleSessions]);

  // Focus follows the zoomed terminal (tab click / Alt+Arrow). Only the grid
  // that owns the session accepts the call, same pattern as killSessionInProject.
  useEffect(() => {
    if (!eagleView || eagleZoom === null) return;
    for (const handle of gridRefs.current.values()) {
      if (handle.focusSession(eagleZoom)) break;
    }
  }, [eagleView, eagleZoom]);

  // Single stable toggle shared by every grid — session IDs are global, so
  // no per-tab closure is needed.
  const handleEagleZoomToggle = useCallback((sessionId: number) => {
    setEagleZoom((prev) => (prev === sessionId ? null : sessionId));
  }, []);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    addSessionToActiveProject: () => {
      const activeTab = tabs.find((t) => t.active);
      if (activeTab) {
        const gridRef = gridRefs.current.get(activeTab.id);
        gridRef?.addSession();
      }
    },
    addSessionInProject: (tabId: string) => {
      const gridRef = gridRefs.current.get(tabId);
      if (gridRef) {
        gridRef.addSession();
        return true;
      }
      // Idle project: no grid mounted yet. Mark it as launched so the grid
      // mounts with its initial pre-launch card.
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      setSessionsLaunched(tabId, true);
      return true;
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
    focusSessionInProject: (tabId: string, sessionId: number) => {
      return gridRefs.current.get(tabId)?.focusSession(sessionId) ?? false;
    },
    killSessionInProject: (tabId: string, sessionId: number) => {
      return gridRefs.current.get(tabId)?.killSessionById(sessionId) ?? false;
    },
  }), [tabs, setSessionsLaunched]);

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
      {/* Global zoom tab bar: all running terminals across all projects,
          color-coded by project. position:absolute (resolving to App's <main>,
          the nearest positioned ancestor — this grid container is static) lifts
          it out of the grid flow and above the zoomed pane (z-40); the pane
          leaves top-8 for it. Staying inside <main> keeps the sidebar and git
          panel usable while zoomed, same as the per-project zoom. */}
      {eagleView && eagleZoom !== null && (() => {
        const zoomedIndex = eagleSessions.findIndex((s) => s.sessionId === eagleZoom);
        return (
          <div className="absolute inset-x-0 top-0 z-50 flex h-8 items-center gap-2 border-b border-maestro-border bg-maestro-surface px-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-maestro-muted">
              Terminal {zoomedIndex + 1}/{eagleSessions.length}
            </span>
            <div className="h-3.5 w-px bg-maestro-border" />
            <div className="flex flex-1 gap-0.5 overflow-x-auto">
              {eagleSessions.map((session, index) => {
                const isActive = session.sessionId === eagleZoom;
                const label =
                  sessionNames[session.sessionId]?.trim() || `Terminal ${index + 1}`;
                return (
                  <button
                    key={session.sessionId}
                    onClick={() => handleEagleZoomToggle(session.sessionId)}
                    className={`flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                      isActive ? "" : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
                    }`}
                    style={
                      isActive
                        ? {
                            backgroundColor: `color-mix(in srgb, ${session.color} 15%, transparent)`,
                            color: session.color,
                          }
                        : undefined
                    }
                    title={
                      isActive
                        ? `${session.projectName} · ${label} (click to exit zoom)`
                        : `Switch to ${session.projectName} · ${label}`
                    }
                  >
                    <span className="font-mono text-[10px] opacity-60">{index + 1}</span>
                    <span className="font-bold" style={{ color: session.color }}>
                      {session.projectName}
                    </span>
                    <span className="max-w-[180px] truncate">{label}</span>
                    <ThinkingIndicator sessionId={session.sessionId} size={3} />
                    <span className="h-1.5 w-1.5 rounded-full bg-maestro-green" />
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setEagleZoom(null)}
              className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
              title="Exit zoom"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })()}

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
              eagleZoomedSessionId={eagleZoom}
              eagleAnyZoomed={eagleView && eagleZoom !== null}
              onEagleZoomToggle={handleEagleZoomToggle}
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
