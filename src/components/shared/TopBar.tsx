import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, PanelLeft, Plus, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MAX_SESSIONS } from "@/components/terminal/splitTree";
import { handoffsOnDiskCount, liveSessionCount } from "@/lib/board";
import { isMac } from "@/lib/platform";
import { modLabel, titleWithShortcut } from "@/lib/shortcuts";
import { useBandStore } from "@/stores/useBandStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { GitHubWatchdogBadge } from "./GitHubWatchdogBadge";

/** One entry of the eagle-view "add terminal" project dropdown. */
export interface EagleProjectOption {
  tabId: string;
  name: string;
  color: string;
  /** Project already has the maximum number of session slots. */
  atMax: boolean;
}

interface TopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** When true, hides window controls (minimize/maximize/close) - use when ProjectTabs provides them */
  hideWindowControls?: boolean;
  /** Whether sessions have been launched for the active project (grid view) */
  /** Number of session slots in the active project */
  slotCount?: number;
  /** Maximum number of sessions allowed */
  maxSessions?: number;
  onAddSession?: () => void;
  /** Whether any project is open. With none, "add a terminal" has nothing to
      add to, so the button is absent rather than present and inert. */
  hasProject?: boolean;
  /** Whether eagle view (all projects' terminals at once) is active */
  eagleView?: boolean;
  /** Eagle view: projects offered in the add-terminal dropdown. */
  eagleProjects?: EagleProjectOption[];
  /** Eagle view: add a terminal to the given project (opens its pre-launch card). */
  onAddSessionToProject?: (tabId: string) => void;
  /** Landscape view: every project, terminal and subagent on one canvas */
  landscapeView?: boolean;
  /** Board layer: every piece of live work, in the stage it is in */
  boardViewOpen?: boolean;
  /** Home decision queue: blocked on you / landed / running */
  homeViewOpen?: boolean;
  /** Factory: the ACT lane (spec in, run stages, PR out) */
  factoryViewOpen?: boolean;
  /** Orchestrator: goal box, session scope, safe-mode proposal queue */
  orchestratorViewOpen?: boolean;
  /** Pulse: today's timeline, flow score and metrics */
  pulseViewOpen?: boolean;
  /** GitHub watchdog badge: navigate to the git panel with the matching
   *  tab + search filter. Badge hides itself when totals are zero. */
  onWatchdogNavigate?: (kind: "prs" | "issues") => void;
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  hideWindowControls = false,
  slotCount = 0,
  maxSessions = MAX_SESSIONS,
  onAddSession,
  hasProject = false,
  eagleView = false,
  eagleProjects = [],
  onAddSessionToProject,
  landscapeView = false,
  boardViewOpen = false,
  homeViewOpen = false,
  factoryViewOpen = false,
  orchestratorViewOpen = false,
  pulseViewOpen = false,
  onWatchdogNavigate,
}: TopBarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);

  /* The crumb's two counts. Both are read straight from the stores that own
     them so the chrome cannot drift from the Board: whatever the Board is
     showing, this line is counting the same rows.

     "Live" is a session Maestro launched that has not finished. Work running
     in someone else's iTerm is deliberately NOT counted here, because Maestro
     cannot see it, and a number that quietly includes guesses is the thing
     the data-honesty rule exists to stop. */
  const sessions = useSessionStore(useShallow((s) => s.sessions));
  const liveCount = liveSessionCount(sessions);
  /* Files on disk, named as files on disk. This used to read "sessions
     parked", which was wrong in both nouns, and then it read the raw store,
     which was the right noun with the wrong number. */
  const handoffs = useBandStore(useShallow((s) => s.handoffs));
  const externallyActiveDirs = useBandStore(useShallow((s) => s.externallyActiveDirs));
  const handoffCount = handoffsOnDiskCount(handoffs, sessions, externallyActiveDirs);

  const surfaceName = eagleView
    ? "Eagle"
    : landscapeView
      ? "Landscape"
      : homeViewOpen
        ? "Home"
        : factoryViewOpen
          ? "Factory"
          : orchestratorViewOpen
            ? "Orchestrator"
            : pulseViewOpen
              ? "Pulse"
              : boardViewOpen
                ? "Board"
                : "Grid";

  /* Zero is not worth a word. An empty count says nothing rather than
     drawing "0 live" across the only line of chrome the app keeps. */
  const crumbCounts = [
    liveCount > 0 ? `${liveCount} live` : null,
    handoffCount > 0 ? `${handoffCount} handoffs on disk` : null,
  ].filter(Boolean) as string[];

  // Eagle view add-terminal dropdown (pick which project gets the new terminal)
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on any outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [addMenuOpen]);

  // Leaving eagle view (or losing all projects) drops the menu.
  useEffect(() => {
    if (!eagleView) setAddMenuOpen(false);
  }, [eagleView]);

  /** At the per-project terminal cap. The button greys out, so say why. */
  const atMaxSessions = slotCount >= maxSessions;

  return (
    <div data-tauri-drag-region className="no-select flex h-9 flex-1 items-center bg-maestro-bg">
      {/* Left: collapse toggle + branch area (inset from CSS var for macOS traffic lights) */}
      <div
        className="flex items-center gap-2 pr-2"
        style={{ paddingLeft: "max(var(--mac-title-bar-inset, 0px), 8px)" }}
      >
        {/* Sidebar toggle - only shown when ProjectTabs isn't providing it */}
        {!hideWindowControls && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className={`rounded-md border px-1.5 py-1 shadow-sm transition-all active:translate-y-px active:shadow-none ${
              sidebarOpen
                ? "border-maestro-accent/30 bg-maestro-accent/10 text-maestro-accent hover:bg-maestro-accent/15"
                : "border-maestro-border bg-maestro-card text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text hover:shadow"
            }`}
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={15} />
          </button>
        )}
      </div>

      {/* Centre: the crumb, then drag region. Quiet Deck keeps exactly one
          line of chrome, so this is where the app says what you are looking
          at and how much is in flight. */}
      <div
        data-tauri-drag-region
        data-testid="topbar-crumb"
        className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-[12px]"
      >
        <span className="shrink-0 font-medium text-maestro-text-2">{surfaceName}</span>
        {crumbCounts.length > 0 && (
          <span className="min-w-0 truncate text-maestro-faint">
            {crumbCounts.map((count) => `· ${count}`).join(" ")}
          </span>
        )}
      </div>

      {/* Right: action icons */}
      <div className="flex items-center gap-0.5 mr-1">
        {/* Shell mode. The Board is a layer over the permanently mounted
            grid, so "Grid" closes the layer rather than unmounting anything. */}
        {/* GitHub watchdog totals (review requests / assigned issues) */}
        {onWatchdogNavigate && <GitHubWatchdogBadge onNavigate={onWatchdogNavigate} />}
        {/* Active project: adds a pre-launch slot to its grid. Always present
            outside eagle view, including before the first session exists: it
            used to appear only once something was already running, which is
            precisely when a new user does not need it. Adding from the Board
            surfaces the grid rather than filing the card out of sight. */}
        {!eagleView && hasProject && (
          <button
            type="button"
            onClick={onAddSession}
            disabled={atMaxSessions}
            className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Add session"
            title={
              atMaxSessions
                ? `Maximum of ${maxSessions} terminals in this project`
                : titleWithShortcut("New terminal", modLabel(), "T")
            }
          >
            <Plus size={14} />
          </button>
        )}
        {/* Eagle view: the plus becomes a project dropdown; picking a project
            leaves eagle view and opens a normal pre-launch card there. */}
        {eagleView && onAddSessionToProject && eagleProjects.length > 0 && (
          <div className="relative" ref={addMenuRef}>
            <button
              type="button"
              onClick={() => setAddMenuOpen((v) => !v)}
              className={`rounded p-1.5 transition-colors ${
                addMenuOpen
                  ? "bg-maestro-card text-maestro-text"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              }`}
              aria-label="Add terminal to project"
              title={titleWithShortcut("New terminal — pick a project", modLabel(), "T")}
            >
              <Plus size={14} />
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-maestro-border bg-maestro-surface py-1 shadow-lg">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
                  Add terminal to…
                </div>
                {eagleProjects.map((project) => (
                  <button
                    key={project.tabId}
                    type="button"
                    disabled={project.atMax}
                    onClick={() => {
                      setAddMenuOpen(false);
                      onAddSessionToProject(project.tabId);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      project.atMax
                        ? `${project.name} already has the maximum number of terminals`
                        : `Add a terminal in ${project.name}`
                    }
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="truncate">{project.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Window controls - hidden on macOS (custom traffic lights in row) or when hideWindowControls */}
      {!hideWindowControls && !isMac() && (
        <div className="flex items-center border-l border-maestro-border">
          <button
            type="button"
            onClick={() => appWindow.minimize()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Minimize"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.toggleMaximize()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Maximize"
          >
            <Square size={10} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.close()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-red/80 hover:text-white"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
