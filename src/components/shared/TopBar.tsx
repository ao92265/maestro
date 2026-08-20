import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Bird,
  Brain,
  Factory,
  GitMerge,
  Home,
  Minus,
  MoreHorizontal,
  Network,
  Package,
  PanelLeft,
  Plus,
  Sparkles,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_SESSIONS } from "@/components/terminal/splitTree";
import { isMac } from "@/lib/platform";
import { modLabel, titleWithShortcut } from "@/lib/shortcuts";
import { countForArea, useHealthStore } from "@/stores/useHealthStore";
import { GitHubWatchdogBadge } from "./GitHubWatchdogBadge";
import { HealthAttentionBadge } from "./HealthAttentionBadge";

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
  onToggleGitPanel?: () => void;
  gitPanelOpen?: boolean;
  /** When true, hides window controls (minimize/maximize/close) - use when ProjectTabs provides them */
  hideWindowControls?: boolean;
  /** Whether sessions have been launched for the active project (grid view) */
  inGridView?: boolean;
  /** Number of session slots in the active project */
  slotCount?: number;
  /** Maximum number of sessions allowed */
  maxSessions?: number;
  onAddSession?: () => void;
  /** Whether eagle view (all projects' terminals at once) is active */
  eagleView?: boolean;
  onToggleEagleView?: () => void;
  /** Eagle view: projects offered in the add-terminal dropdown. */
  eagleProjects?: EagleProjectOption[];
  /** Eagle view: add a terminal to the given project (opens its pre-launch card). */
  onAddSessionToProject?: (tabId: string) => void;
  /** Landscape view: every project, terminal and subagent on one canvas */
  landscapeView?: boolean;
  onToggleLandscapeView?: () => void;
  /** A terminal somewhere is waiting for input — marks the landscape button. */
  landscapeAttention?: boolean;
  /** Home decision queue: blocked on you / landed / running */
  homeViewOpen?: boolean;
  onToggleHomeView?: () => void;
  /** A terminal somewhere is waiting for input — marks the Home button. */
  homeAttention?: boolean;
  /** Factory: the ACT lane (spec in, run stages, PR out) */
  factoryViewOpen?: boolean;
  onToggleFactoryView?: () => void;
  /** Memory panel — buried behind the More menu, so it toggles without an
   *  active-state indicator (a plain menu action, not a persistent button). */
  onToggleMemoryPanel?: () => void;
  /** Right-side Processes panel */
  processesPanelOpen?: boolean;
  onToggleProcessesPanel?: () => void;
  /** Right-side AI panel (Report / Plan / Catalog tabs) */
  aiPanelOpen?: boolean;
  onToggleAiPanel?: () => void;
  /** GitHub watchdog badge: navigate to the git panel with the matching
   *  tab + search filter. Badge hides itself when totals are zero. */
  onWatchdogNavigate?: (kind: "prs" | "issues") => void;
  /** More menu → Extensions: opens the sidebar on its Infra tab (MCP
   *  servers, plugins, skills) — that tab no longer has its own strip
   *  button, but its content still renders when selected. */
  onOpenExtensions?: () => void;
  /** More menu → Workflows: opens the full-screen workflow editor overlay.
   *  Its only trigger used to live inside the (now cut) Launch panel, but
   *  the overlay itself is a standalone store-driven view — reachable here
   *  with no change to the editor. */
  onOpenWorkflows?: () => void;
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onToggleGitPanel,
  gitPanelOpen,
  hideWindowControls = false,
  inGridView = false,
  slotCount = 0,
  maxSessions = MAX_SESSIONS,
  onAddSession,
  eagleView = false,
  onToggleEagleView,
  eagleProjects = [],
  onAddSessionToProject,
  landscapeView = false,
  onToggleLandscapeView,
  landscapeAttention = false,
  homeViewOpen = false,
  onToggleHomeView,
  homeAttention = false,
  factoryViewOpen = false,
  onToggleFactoryView,
  onToggleMemoryPanel,
  processesPanelOpen = false,
  onToggleProcessesPanel,
  aiPanelOpen = false,
  onToggleAiPanel,
  onWatchdogNavigate,
  onOpenExtensions,
  onOpenWorkflows,
}: TopBarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);

  // Memory's health flags lost their button when Memory moved into the More
  // menu; this feeds the aggregated dot on the More button below (the
  // per-item badge inside the menu still uses HealthAttentionBadge directly).
  const memoryHealthCount = useHealthStore((s) => countForArea(s.flags, "memory"));

  // Eagle view add-terminal dropdown (pick which project gets the new terminal)
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  // More menu — Landscape, Memory and Extensions, buried behind the ellipsis
  // instead of their own topbar buttons (declutter). Same outside-click
  // pattern as the add-terminal dropdown above.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

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

  // Close the More menu on any outside click.
  useEffect(() => {
    if (!moreMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [moreMenuOpen]);

  return (
    <div data-tauri-drag-region className="no-select flex h-10 flex-1 items-center bg-maestro-bg">
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

      {/* Center: drag region */}
      <div data-tauri-drag-region className="flex-1" />

      {/* Right: action icons */}
      <div className="flex items-center gap-0.5 mr-1">
        {/* GitHub watchdog totals (review requests / assigned issues) */}
        {onWatchdogNavigate && <GitHubWatchdogBadge onNavigate={onWatchdogNavigate} />}
        {/* Active project: adds a pre-launch slot to its grid. */}
        {inGridView && !eagleView && (
          <button
            type="button"
            onClick={onAddSession}
            disabled={slotCount >= maxSessions}
            className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Add session"
            title={titleWithShortcut("New terminal", modLabel(), "T")}
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
        {onToggleHomeView && (
          <button
            type="button"
            onClick={onToggleHomeView}
            className={`relative rounded p-1.5 transition-colors ${
              homeViewOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Home"
            title={titleWithShortcut(
              "Home — blocked on you, landed since you looked, running",
              modLabel(),
              "1",
            )}
          >
            <Home size={14} />
            {homeAttention && !homeViewOpen && (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-maestro-accent"
              />
            )}
          </button>
        )}
        {onToggleFactoryView && (
          <button
            type="button"
            onClick={onToggleFactoryView}
            className={`relative rounded p-1.5 transition-colors ${
              factoryViewOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Factory"
            title={titleWithShortcut(
              "Factory — hand ACT a spec, watch the run, get the PR",
              modLabel(),
              "7",
            )}
          >
            <Factory size={14} />
          </button>
        )}
        {onToggleEagleView && (
          <button
            type="button"
            onClick={onToggleEagleView}
            className={`rounded p-1.5 transition-colors ${
              eagleView
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Eagle view"
            title={titleWithShortcut("Eagle view", modLabel(), "G")}
          >
            <Bird size={14} />
          </button>
        )}
        {onToggleProcessesPanel && (
          <button
            type="button"
            onClick={onToggleProcessesPanel}
            className={`relative rounded p-1.5 transition-colors ${
              processesPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Processes"
            title={titleWithShortcut("Processes", modLabel(), "4")}
          >
            <Activity size={14} />
            <HealthAttentionBadge area="processes" />
          </button>
        )}
        {onToggleAiPanel && (
          <button
            type="button"
            onClick={onToggleAiPanel}
            className={`rounded p-1.5 transition-colors ${
              aiPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="AI"
            title={titleWithShortcut("AI — daily report and plan", modLabel(), "6")}
          >
            <Sparkles size={14} />
          </button>
        )}
        {/* Git panel — in eagle view it becomes a per-project carousel
            (swipe between one git card per open project). */}
        <button
          type="button"
          onClick={onToggleGitPanel}
          className={`rounded p-1.5 transition-colors ${
            gitPanelOpen
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          }`}
          aria-label="Git"
          title={titleWithShortcut("Git", modLabel(), "2")}
        >
          <GitMerge size={14} />
        </button>
        {/* More menu — Landscape, Memory, Workflows and Extensions moved here
            (issue declutter): each keeps its keyboard shortcut/store wiring,
            just off the always-visible strip. */}
        {(onToggleLandscapeView || onToggleMemoryPanel || onOpenWorkflows || onOpenExtensions) && (
          <div className="relative" ref={moreMenuRef}>
            <button
              type="button"
              onClick={() => setMoreMenuOpen((v) => !v)}
              className={`relative rounded p-1.5 transition-colors ${
                moreMenuOpen
                  ? "bg-maestro-card text-maestro-text"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              }`}
              aria-label="More"
              title="More — Landscape, Memory, Workflows, Extensions"
            >
              <MoreHorizontal size={14} />
              {((landscapeAttention && !landscapeView) || memoryHealthCount > 0) && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-maestro-accent"
                />
              )}
            </button>
            {moreMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[170px] rounded-md border border-maestro-border bg-maestro-surface py-1 shadow-lg">
                {onToggleLandscapeView && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onToggleLandscapeView();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card"
                  >
                    <Network size={13} className="shrink-0 text-maestro-muted" />
                    Landscape
                  </button>
                )}
                {onToggleMemoryPanel && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onToggleMemoryPanel();
                    }}
                    className="relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card"
                  >
                    <Brain size={13} className="shrink-0 text-maestro-muted" />
                    Memory
                    <HealthAttentionBadge area="memory" />
                  </button>
                )}
                {onOpenWorkflows && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onOpenWorkflows();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card"
                  >
                    <Workflow size={13} className="shrink-0 text-maestro-muted" />
                    Workflows
                  </button>
                )}
                {onOpenExtensions && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onOpenExtensions();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card"
                  >
                    <Package size={13} className="shrink-0 text-maestro-muted" />
                    Extensions
                  </button>
                )}
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
