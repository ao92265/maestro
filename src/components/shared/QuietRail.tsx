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
  Network,
  Package,
  RadioTower,
  Sparkles,
  Workflow,
} from "lucide-react";
import { HealthAttentionBadge } from "@/components/shared/HealthAttentionBadge";
import { modLabel, titleWithShortcut } from "@/lib/shortcuts";

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
      {/* The four surfaces that used to hide behind an ellipsis. The rail runs
          down the window, so it has the room the old horizontal strip did not,
          and a menu you have to open first is one more thing to remember about
          an app Alex already said he could not read. Each is drawn only when
          the shell offers it, so none of them is ever a dead control. */}
      <div className="flex-1" />
      {onToggleLandscapeView && (
        <button
          type="button"
          onClick={onToggleLandscapeView}
          className={`relative rounded p-1.5 transition-colors ${
            landscapeView
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          }`}
          aria-label="Landscape"
          title="Landscape — every project, terminal and subagent on one canvas"
        >
          <Network size={14} />
          {landscapeAttention && !landscapeView && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-maestro-alarm"
            />
          )}
        </button>
      )}
      {onToggleMemoryPanel && (
        <button
          type="button"
          onClick={onToggleMemoryPanel}
          className="relative rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Memory"
          title="Memory — what the agents have written down"
        >
          <Brain size={14} />
          <HealthAttentionBadge area="memory" />
        </button>
      )}
      {onOpenWorkflows && (
        <button
          type="button"
          onClick={onOpenWorkflows}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Workflows"
          title="Workflows — the full screen editor"
        >
          <Workflow size={14} />
        </button>
      )}
      {onOpenExtensions && (
        <button
          type="button"
          onClick={onOpenExtensions}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Extensions"
          title="Extensions — MCP servers, plugins and skills"
        >
          <Package size={14} />
        </button>
      )}
    </nav>
  );
}
