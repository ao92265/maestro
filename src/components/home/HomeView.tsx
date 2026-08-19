import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  CircleDot,
  GitMerge,
  GitPullRequest,
  HelpCircle,
  Inbox,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { badgeBaseClass, SESSION_STATUS_BADGES } from "@/components/session/agentPresentation";
import { assembleBands, type BandItem, type BandTab, type HandoffInfo } from "@/lib/bands";
import { useActStore } from "@/stores/useActStore";
import { useBandStore } from "@/stores/useBandStore";
import { useFactoryViewStore } from "@/stores/useFactoryViewStore";
import { useFDAStore } from "@/stores/useFDAStore";
import { useHomeViewStore } from "@/stores/useHomeViewStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import type { BackendSessionStatus } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useTourStore } from "@/stores/useTourStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

interface HomeViewProps {
  /** Leave Home and focus a terminal (or just its project) — LandscapeView's contract. */
  onNavigate: (tabId: string, sessionId?: number) => void;
  onClose: () => void;
}

/** Fleet strip display order: what needs you first, calmest last. */
const STRIP_ORDER: BackendSessionStatus[] = [
  "NeedsInput",
  "Working",
  "Starting",
  "Done",
  "Error",
  "Timeout",
  "Idle",
];

function relAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The handover nudge typed into the fresh session. Deliberately short: the
 * SessionStart hook injects the full handoff body on its own (rohcna's
 * `handoverPrompt` convention, ported).
 */
function handoverPrompt(h: HandoffInfo): string {
  const where = h.branch ? `${h.repo} on ${h.branch}` : h.repo;
  return `Resume from the injected handoff for ${where}. Confirm branch and working-tree state, then continue the next step.`;
}

const rowClass =
  "flex w-full items-center gap-2 rounded border border-maestro-border bg-maestro-card px-3 py-2 text-left transition-colors hover:border-maestro-muted/50";

function StatusBadge({ status }: { status: BackendSessionStatus }) {
  const badge = SESSION_STATUS_BADGES[status];
  return <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>;
}

function SessionRow({
  item,
  onNavigate,
}: {
  item: BandItem;
  onNavigate: HomeViewProps["onNavigate"];
}) {
  if (item.kind !== "session") return null;
  const { session, tabId, projectName } = item;
  const detail =
    session.status === "NeedsInput"
      ? (session.needsInputPrompt ?? "Waiting for your input")
      : (session.statusMessage ?? "");
  return (
    <button
      type="button"
      className={`${rowClass} ${tabId ? "" : "cursor-default"}`}
      onClick={() => tabId && onNavigate(tabId, session.id)}
      title={tabId ? "Jump to this terminal" : "Project not open in a tab"}
    >
      <StatusBadge status={session.status} />
      <span className="shrink-0 text-[12px] font-medium text-maestro-text">{projectName}</span>
      {session.name && (
        <span className="shrink-0 text-[11px] text-maestro-muted">{session.name}</span>
      )}
      {session.branch && (
        <span className="shrink-0 rounded bg-maestro-muted/10 px-1 text-[10px] text-maestro-muted">
          {session.branch}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-muted">{detail}</span>
    </button>
  );
}

function PrRow({ item }: { item: BandItem }) {
  if (item.kind !== "pr") return null;
  const { pr, projectName } = item;
  const merged = pr.mergedAt !== null;
  return (
    <button
      type="button"
      className={rowClass}
      onClick={() => void openUrl(pr.url).catch((err) => console.error("Failed to open PR:", err))}
      title="Open on GitHub"
    >
      {merged ? (
        <GitMerge size={13} className="shrink-0 text-maestro-purple" />
      ) : (
        <GitPullRequest size={13} className="shrink-0 text-maestro-accent" />
      )}
      <span
        className={`${badgeBaseClass} ${
          merged
            ? "bg-maestro-purple/15 text-maestro-purple"
            : "bg-maestro-accent/15 text-maestro-accent"
        }`}
      >
        {merged ? "MERGED" : "CHANGES REQUESTED"}
      </span>
      <span className="shrink-0 text-[12px] font-medium text-maestro-text">{projectName}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-muted">
        #{pr.number} {pr.title}
      </span>
      {merged && pr.mergedAt && (
        <span className="shrink-0 text-[10px] text-maestro-muted">{relAgo(pr.mergedAt)}</span>
      )}
    </button>
  );
}

/** An ACT run stopped at a confidence gate; clicking opens it in the Factory. */
function RunRow({ item }: { item: BandItem }) {
  if (item.kind !== "run") return null;
  const { run } = item;
  return (
    <button
      type="button"
      className={rowClass}
      onClick={() => {
        void useActStore.getState().openDetail(run.id);
        useHomeViewStore.getState().close();
        useFactoryViewStore.getState().open();
      }}
      title="Open this run in the Factory to approve or reject the gate"
    >
      <span className={`${badgeBaseClass} bg-maestro-accent/15 text-maestro-accent`}>
        FACTORY GATE
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-maestro-text">
        {run.title}
      </span>
      {run.stage && <span className="shrink-0 text-[10px] text-maestro-muted">{run.stage}</span>}
    </button>
  );
}

function HandoffRow({ item, onLaunch }: { item: BandItem; onLaunch: (h: HandoffInfo) => void }) {
  if (item.kind !== "handoff") return null;
  const h = item.handoff;
  return (
    <div className={rowClass}>
      <span className={`${badgeBaseClass} bg-maestro-yellow/15 text-maestro-yellow`}>PARKED</span>
      <span className="shrink-0 text-[12px] font-medium text-maestro-text">{h.repo}</span>
      {h.branch && (
        <span className="shrink-0 rounded bg-maestro-muted/10 px-1 text-[10px] text-maestro-muted">
          {h.branch}
        </span>
      )}
      {h.waiting && (
        <span className={`${badgeBaseClass} bg-maestro-accent/15 text-maestro-accent`}>
          ASKED YOU
        </span>
      )}
      {h.uncommitted > 0 && (
        <span className="shrink-0 text-[10px] text-maestro-yellow">
          {h.uncommitted} uncommitted
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-muted" title={h.lastAction}>
        {h.lastAction || h.asks[h.asks.length - 1] || ""}
      </span>
      <span className="shrink-0 text-[10px] text-maestro-muted">{relAgo(h.lastActive)}</span>
      <button
        type="button"
        onClick={() => onLaunch(h)}
        className="flex shrink-0 items-center gap-1 rounded border border-maestro-border px-1.5 py-0.5 text-[11px] text-maestro-muted transition-colors hover:border-maestro-green/50 hover:text-maestro-green"
        title="Launch a session here, seeded with the handoff"
      >
        <Play size={11} /> Resume
      </button>
    </div>
  );
}

function Band({
  title,
  icon,
  items,
  emptyText,
  stale,
  action,
  renderItem,
}: {
  title: string;
  icon: React.ReactNode;
  items: BandItem[];
  emptyText: string;
  stale?: string | null;
  action?: React.ReactNode;
  renderItem: (item: BandItem, i: number) => React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon}
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          {title}
        </h2>
        <span className="text-[11px] text-maestro-muted/70">{items.length}</span>
        {stale && (
          <span
            className={`${badgeBaseClass} bg-maestro-yellow/15 text-maestro-yellow`}
            title={stale}
          >
            STALE
          </span>
        )}
        <div className="flex-1" />
        {action}
      </div>
      {items.length === 0 ? (
        <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
          {emptyText}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">{items.map(renderItem)}</div>
      )}
    </section>
  );
}

/**
 * Home — the decision queue. Three bands, in the only order that matters:
 * what is blocked on you, what landed since you looked, what is running.
 * Everything else in the app is reachable from here, not shown here.
 */
export function HomeView({ onNavigate, onClose }: HomeViewProps) {
  const sessions = useSessionStore(useShallow((s) => s.sessions));
  const tabs = useWorkspaceStore(useShallow((s) => s.tabs));
  const {
    handoffs,
    repoPrs,
    handoffsError,
    prsError,
    isRefreshing,
    watermarkMs,
    refresh,
    markSeen,
  } = useBandStore();
  const requireAccess = useFDAStore((s) => s.requireAccess);
  const gatedRuns = useActStore(useShallow((s) => s.gatedRuns));
  const [statusFilter, setStatusFilter] = useState<BackendSessionStatus | null>(null);

  const bandTabs: BandTab[] = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        name: t.name,
        projectPath: t.projectPath,
        selectedRepoPath: t.selectedRepoPath,
      })),
    [tabs],
  );

  /* The 5-minute polling loop lives at App level (useBandPolling) so the
     Vanguard snapshot stays fresh with Home closed; opening Home just tops
     the data up once so the first paint isn't up to 5 minutes old. */
  useEffect(() => {
    void refresh();
    void useActStore.getState().refresh();
  }, [refresh]);

  const bands = useMemo(
    () => assembleBands({ sessions, tabs: bandTabs, handoffs, repoPrs, gatedRuns, watermarkMs }),
    [sessions, bandTabs, handoffs, repoPrs, gatedRuns, watermarkMs],
  );

  /** The strip filter narrows session rows; other rows stay (they have no status). */
  const filtered = useCallback(
    (items: BandItem[]) =>
      statusFilter === null
        ? items
        : items.filter((i) => i.kind !== "session" || i.session.status === statusFilter),
    [statusFilter],
  );

  const launchHandoff = useCallback(
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

  return (
    /* z-50 like the landscape overlay: the zoomed eagle pane sits at z-40. */
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-maestro-border px-3">
        <span className="mr-1 shrink-0 text-[12px] font-semibold text-maestro-text">Home</span>

        {/* Fleet strip: one chip per status with a live count; click filters.
            Idle sessions live in no band, so that chip is a count, not a filter
            (clicking it would blank all three bands — review fc0e6b9, LOW #2). */}
        {STRIP_ORDER.map((status) => {
          const count = bands.counts[status];
          const badge = SESSION_STATUS_BADGES[status];
          const active = statusFilter === status;
          const countOnly = status === "Idle";
          const chipContent = (
            <>
              <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
              <span>{count}</span>
            </>
          );
          const chipTitle = `${badge.label}: ${count} session${count === 1 ? "" : "s"}`;
          if (countOnly) {
            return (
              <span
                key={status}
                className={`flex shrink-0 items-center gap-1 rounded border border-maestro-border px-1.5 py-0.5 text-[10px] text-maestro-muted ${
                  count === 0 ? "opacity-40" : ""
                }`}
                title={chipTitle}
              >
                {chipContent}
              </span>
            );
          }
          return (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(active ? null : status)}
              disabled={count === 0 && !active}
              className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                active
                  ? "border-maestro-accent/60 text-maestro-text"
                  : "border-maestro-border text-maestro-muted hover:text-maestro-text"
              } ${count === 0 && !active ? "opacity-40" : ""}`}
              title={chipTitle}
            >
              {chipContent}
            </button>
          );
        })}

        <div className="flex-1" />
        <button
          type="button"
          onClick={() => useTourStore.getState().open()}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Show tour"
          title="Show the app tour"
        >
          <HelpCircle size={13} />
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isRefreshing}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
          aria-label="Refresh"
          title="Refresh handoffs and pull requests"
        >
          <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label="Close home"
        >
          <X size={14} />
        </button>
      </div>

      {/* Bands */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-4">
          <Band
            title="Blocked on you"
            icon={<CircleDot size={12} className="text-maestro-accent" />}
            items={filtered(bands.blocked)}
            emptyText="Nothing is blocked on you."
            stale={handoffsError}
            action={
              bands.moreHandoffs > 0 ? (
                <span
                  className="text-[10px] text-maestro-muted/70"
                  title="Older parked handoffs, one per directory, hidden to keep the queue short"
                >
                  +{bands.moreHandoffs} more parked
                </span>
              ) : undefined
            }
            renderItem={(item, i) =>
              item.kind === "session" ? (
                <SessionRow key={`s${item.session.id}`} item={item} onNavigate={onNavigate} />
              ) : item.kind === "pr" ? (
                <PrRow key={`p${item.pr.url}`} item={item} />
              ) : item.kind === "run" ? (
                <RunRow key={`r${item.run.id}`} item={item} />
              ) : (
                <HandoffRow
                  key={`h${item.handoff.slug}-${i}`}
                  item={item}
                  onLaunch={launchHandoff}
                />
              )
            }
          />
          <Band
            title="Landed since you looked"
            icon={<CheckCircle2 size={12} className="text-maestro-green" />}
            items={filtered(bands.landed)}
            emptyText="Nothing new has landed."
            /* A partially failed poll must not read as "nothing landed" —
               that is silent under-reporting on a decision queue. */
            stale={
              prsError ??
              (repoPrs.some((r) => r.error)
                ? `Could not poll: ${repoPrs
                    .filter((r) => r.error)
                    .map((r) => r.projectName)
                    .join(", ")}`
                : null)
            }
            action={
              <button
                type="button"
                onClick={markSeen}
                className="rounded border border-maestro-border px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:text-maestro-text"
                title="Merged PRs up to now stop counting as news"
              >
                Mark seen
              </button>
            }
            renderItem={(item, i) =>
              item.kind === "session" ? (
                <SessionRow key={`s${item.session.id}`} item={item} onNavigate={onNavigate} />
              ) : (
                <PrRow key={`p${item.kind === "pr" ? item.pr.url : i}`} item={item} />
              )
            }
          />
          <Band
            title="Running"
            icon={<Inbox size={12} className="text-maestro-blue" />}
            items={filtered(bands.running)}
            emptyText="Nothing is running."
            renderItem={(item) =>
              item.kind === "session" ? (
                <SessionRow key={`s${item.session.id}`} item={item} onNavigate={onNavigate} />
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}
