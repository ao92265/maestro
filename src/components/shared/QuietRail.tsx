import {
  Activity,
  Bird,
  Brain,
  Columns,
  Factory,
  Gauge,
  GitMerge,
  Home,
  LayoutGrid,
  MoreHorizontal,
  Network,
  Package,
  RadioTower,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HealthAttentionBadge } from "@/components/shared/HealthAttentionBadge";
import { modLabel, titleWithShortcut } from "@/lib/shortcuts";
import { countForArea, useHealthStore } from "@/stores/useHealthStore";

/**
 * The Quiet Deck rail: the app's whole navigation, 44px wide, down the left.
 *
 * Every surface Maestro can show is reached from here or from the ellipsis at
 * the bottom, which is why the top bar above it is one line of text. The rail
 * carries glyphs only: the name and the keyboard shortcut live in the tooltip,
 * because a label repeated nine times down a narrow column is noise, not help.
 *
 * The buttons moved here verbatim from the top bar's right-hand cluster. Their
 * aria-labels, tooltips, shortcuts and attention dots are unchanged, so the
 * keyboard routes and the tour steps that name them still land.
 */
export type QuietRailProps = {
  boardViewOpen?: boolean;
  onSetBoardView?: (open: boolean) => void;
  homeViewOpen?: boolean;
  onToggleHomeView?: () => void;
  homeAttention?: boolean;
  factoryViewOpen?: boolean;
  onToggleFactoryView?: () => void;
  orchestratorViewOpen?: boolean;
  onToggleOrchestratorView?: () => void;
  pulseViewOpen?: boolean;
  onTogglePulseView?: () => void;
  eagleView?: boolean;
  onToggleEagleView?: () => void;
  processesPanelOpen?: boolean;
  onToggleProcessesPanel?: () => void;
  aiPanelOpen?: boolean;
  onToggleAiPanel?: () => void;
  gitPanelOpen?: boolean;
  onToggleGitPanel: () => void;
  landscapeView?: boolean;
  onToggleLandscapeView?: () => void;
  landscapeAttention?: boolean;
  onToggleMemoryPanel?: () => void;
  onOpenWorkflows?: () => void;
  onOpenExtensions?: () => void;
};

export function QuietRail({
  boardViewOpen = false,
  onSetBoardView,
  homeViewOpen = false,
  onToggleHomeView,
  homeAttention = false,
  factoryViewOpen = false,
  onToggleFactoryView,
  orchestratorViewOpen = false,
  onToggleOrchestratorView,
  pulseViewOpen = false,
  onTogglePulseView,
  eagleView = false,
  onToggleEagleView,
  processesPanelOpen = false,
  onToggleProcessesPanel,
  aiPanelOpen = false,
  onToggleAiPanel,
  gitPanelOpen = false,
  onToggleGitPanel,
  landscapeView = false,
  onToggleLandscapeView,
  landscapeAttention = false,
  onToggleMemoryPanel,
  onOpenWorkflows,
  onOpenExtensions,
}: QuietRailProps) {
  const memoryHealthCount = useHealthStore((s) => countForArea(s.flags, "memory"));

  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

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
    <nav
      aria-label="Surfaces"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-maestro-border bg-maestro-surface py-2"
    >
      {/* The app's own mark, not a letterform stand-in: the samurai mask the
          icon and the accent colour both come from. */}
      <img
        src="/favicon.png"
        alt=""
        aria-hidden="true"
        className="mb-1 h-[22px] w-[22px] shrink-0 select-none"
        draggable={false}
      />
      {onSetBoardView && (
        <div className="flex flex-col items-center gap-0.5 rounded-md border border-maestro-border bg-maestro-card p-0.5">
          <button
            type="button"
            onClick={() => onSetBoardView(true)}
            aria-pressed={boardViewOpen}
            className={`flex items-center justify-center rounded p-1 transition-colors ${
              boardViewOpen
                ? "bg-maestro-surface text-maestro-text"
                : "text-maestro-muted hover:text-maestro-text"
            }`}
            aria-label="Board view"
            title={titleWithShortcut(
              "Board: every piece of work in the stage it is in",
              modLabel(),
              "E",
            )}
          >
            <Columns size={13} />
          </button>
          <button
            type="button"
            onClick={() => onSetBoardView(false)}
            aria-pressed={!boardViewOpen}
            className={`flex items-center justify-center rounded p-1 transition-colors ${
              boardViewOpen
                ? "text-maestro-muted hover:text-maestro-text"
                : "bg-maestro-surface text-maestro-text"
            }`}
            aria-label="Grid view"
            title={titleWithShortcut("Grid: the terminals themselves", modLabel(), "E")}
          >
            <LayoutGrid size={13} />
          </button>
        </div>
      )}
      {(onSetBoardView || onToggleHomeView) && (
        <hr className="my-1 w-5 border-0 border-t border-maestro-border" />
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
      {onToggleOrchestratorView && (
        <button
          type="button"
          onClick={onToggleOrchestratorView}
          className={`relative rounded p-1.5 transition-colors ${
            orchestratorViewOpen
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          }`}
          aria-label="Orchestrator"
          title={titleWithShortcut(
            "Orchestrator — set a goal, scope the sessions, approve what it proposes",
            modLabel(),
            "8",
          )}
        >
          <RadioTower size={14} />
        </button>
      )}
      {onTogglePulseView && (
        <button
          type="button"
          onClick={onTogglePulseView}
          className={`relative rounded p-1.5 transition-colors ${
            pulseViewOpen
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          }`}
          aria-label="Pulse"
          title={titleWithShortcut(
            "Pulse — today's timeline, flow score and metrics",
            modLabel(),
            "9",
          )}
        >
          <Gauge size={14} />
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
      {/* Everything below the spacer is buried on purpose: reachable, never in
          the way. The rail's job is the surfaces you use, not the ones you own. */}
      <div className="flex-1" />
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
            <div className="absolute bottom-0 left-full z-50 ml-1 min-w-[170px] rounded-md border border-maestro-border bg-maestro-surface py-1 shadow-lg">
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
    </nav>
  );
}
