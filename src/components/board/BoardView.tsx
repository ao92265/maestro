import { HelpCircle, LayoutGrid, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BoardAlertBand } from "@/components/board/BoardAlertBand";
import { BoardCard, boardCardKey, cardAction } from "@/components/board/BoardCard";
import { BoardColdStart } from "@/components/board/BoardColdStart";
import { BoardColumn } from "@/components/board/BoardColumn";
import { BoardPeek } from "@/components/board/BoardPeek";
import { badgeBaseClass, SESSION_STATUS_BADGES } from "@/components/session/agentPresentation";
import type { BandTab, HandoffInfo } from "@/lib/bands";
import {
  assembleBoard,
  BOARD_COLUMN_ORDER,
  type BoardCardItem,
  type BoardColumnKey,
  type BoardReviewRequests,
  blockedOldestFirst,
  isColdStart,
} from "@/lib/board";
import { useActStore } from "@/stores/useActStore";
import { useBandStore } from "@/stores/useBandStore";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import type { BackendSessionStatus } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useTourStore } from "@/stores/useTourStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * The Board: every piece of live work, in the stage it is honestly in.
 *
 * A layer over the permanently mounted grid (the HomeView pattern), not a
 * replacement for it. Assembly is `assembleBoard`, so this file only renders
 * and routes clicks; the column rules are unit-tested next door in
 * `src/lib/__tests__/board.test.ts`.
 *
 * Cards are deliberately not draggable. A card's stage is derived from live
 * state, so a drag would either do nothing or move a card to a stage the work
 * is not in, and both are dead controls in the pivot's terms.
 */

interface BoardViewProps {
  /** Leave the Board and focus a terminal (or just its project). */
  onNavigateSession: (tabId: string, sessionId?: number) => void;
  /** Open an ACT run in the Factory (its gate lives there). */
  onOpenRun: (runId: string) => void;
  /** Start a session in the handoff's directory, seeded with it. */
  onLaunchHandoff: (handoff: HandoffInfo) => void;
  /** Open a pull request in the browser. */
  onOpenPr: (url: string) => void;
  /** Close the Board layer to reveal the terminal grid underneath. */
  onShowGrid: () => void;
  /**
   * Open a directory as a Maestro tab without launching a session in it,
   * for adopting the project an outside claude is working in.
   */
  onOpenProject: (dir: string) => void;
  /**
   * A z-50 overlay (Home, Factory, Landscape, Workflows) is stacked over the
   * Board. They open without closing it, so while one is up the Board's keys
   * must go dead: j/k/Enter acting on cards nobody can see activated hidden
   * work (review finding 1 on 4f3f27a).
   */
  overlayOpen: boolean;
}

const COLUMN_META: Record<BoardColumnKey, { title: string; emptyText: string }> = {
  suggested: { title: "Suggested", emptyText: "No handoffs are waiting on disk." },
  planning: { title: "Planning", emptyText: "Nothing is being planned." },
  building: { title: "Building", emptyText: "Nothing is being built." },
  checking: { title: "Checking", emptyText: "Nothing is being checked." },
  review: { title: "Review", emptyText: "Nothing is waiting on review." },
  done: { title: "Done", emptyText: "Nothing has finished since you looked." },
};

/** Fleet strip display order: what needs you first, calmest last (Home's order). */
const STRIP_ORDER: BackendSessionStatus[] = [
  "NeedsInput",
  "Working",
  "Starting",
  "Done",
  "Error",
  "Timeout",
  "Idle",
];

const headerButtonClass =
  "shrink-0 rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text";

export function BoardView({
  onNavigateSession,
  onOpenRun,
  onLaunchHandoff,
  onOpenPr,
  onShowGrid,
  onOpenProject,
  overlayOpen,
}: BoardViewProps) {
  const sessions = useSessionStore(useShallow((s) => s.sessions));
  const tabs = useWorkspaceStore(useShallow((s) => s.tabs));
  const {
    handoffs,
    repoPrs,
    handoffsError,
    prsError,
    processesError,
    isRefreshing,
    watermarkMs,
    externallyActiveDirs,
    refresh,
    markSeen,
  } = useBandStore();
  const runs = useActStore(useShallow((s) => s.runs));
  const gatedRuns = useActStore(useShallow((s) => s.gatedRuns));
  const actError = useActStore((s) => s.error);
  const watchdogProjects = useGitHubWatchdogStore(useShallow((s) => s.projects));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [peekItem, setPeekItem] = useState<Extract<BoardCardItem, { kind: "external" }> | null>(
    null,
  );

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

  const reviewRequests: BoardReviewRequests[] = useMemo(
    () =>
      watchdogProjects.map((p) => ({
        repoPath: p.repoPath,
        projectName: p.name,
        reviewRequests: p.reviewRequests,
      })),
    [watchdogProjects],
  );

  /* The 5-minute polling loop lives at App level (useBandPolling) so the
     Vanguard snapshot stays fresh with the Board closed; opening the Board
     tops the data up once so the first paint is not up to 5 minutes old. */
  useEffect(() => {
    void refresh();
    void useActStore.getState().refresh();
  }, [refresh]);

  const columns = useMemo(
    () =>
      assembleBoard({
        sessions,
        tabs: bandTabs,
        handoffs,
        repoPrs,
        runs,
        gatedRuns,
        reviewRequests,
        watermarkMs,
        activeDirs: externallyActiveDirs,
      }),
    [
      sessions,
      bandTabs,
      handoffs,
      repoPrs,
      runs,
      gatedRuns,
      reviewRequests,
      watermarkMs,
      externallyActiveDirs,
    ],
  );

  /* Reading order for j/k: column by column, left to right, top to bottom.
     Only cards Enter can act on: parking the selection on a card that
     silently no-ops is a dead control by keyboard, and the why-disabled
     explanation is hover-only (review finding 4 on 4f3f27a). */
  const flat = useMemo(
    () =>
      BOARD_COLUMN_ORDER.flatMap((key) => columns[key]).filter((item) => cardAction(item).enabled),
    [columns],
  );

  const activate = useCallback(
    (item: BoardCardItem) => {
      switch (item.kind) {
        case "session":
          if (item.tabId) onNavigateSession(item.tabId, item.session.id);
          return;
        case "handoff":
          onLaunchHandoff(item.handoff);
          return;
        case "run":
          onOpenRun(item.run.id);
          return;
        case "pr":
          onOpenPr(item.pr.url);
          return;
        case "external":
          /* Maestro cannot open or zoom a session it did not spawn; the
             honest action is the read-only peek at its transcript trail. */
          setPeekItem(item);
          return;
      }
    },
    [onNavigateSession, onLaunchHandoff, onOpenRun, onOpenPr],
  );

  /* Selection follows the card, so when the card itself leaves the board
     (tab closed, handoff went live outside) the ring must go with it: a
     ringed card j/k/Enter no longer see is a dead control wearing focus. */
  useEffect(() => {
    if (selectedKey && !flat.some((item) => boardCardKey(item) === selectedKey)) {
      setSelectedKey(null);
    }
  }, [flat, selectedKey]);

  /* Same for the peek: when its directory stops being live outside (the
     poll dropped it, or the session ended), a panel still saying "working
     outside Maestro" would be asserting a present tense nobody verified. */
  useEffect(() => {
    if (
      peekItem &&
      !columns.building.some((c) => c.kind === "external" && c.dir === peekItem.dir)
    ) {
      setPeekItem(null);
    }
  }, [columns, peekItem]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      /* The tour's focus trap only traps Tab, so every other key still
         reaches this listener behind its modal (useAppKeyboard.ts makes the
         same early return for the same reason). Same guard while a z-50
         overlay covers the board: these keys would act on hidden cards. */
      if (overlayOpen) return;
      if (useTourStore.getState().isOpen) return;
      /* The peek is modal over the board: its own focus trap owns Escape
         and Tab; everything here goes dead so j/k/Enter cannot act on the
         cards hidden behind it. */
      if (peekItem) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      if (flat.length === 0) return;

      const at = flat.findIndex((item) => boardCardKey(item) === selectedKey);
      if (event.key === "j") {
        event.preventDefault();
        setSelectedKey(boardCardKey(flat[at < 0 ? 0 : (at + 1) % flat.length]));
      } else if (event.key === "k") {
        event.preventDefault();
        setSelectedKey(
          boardCardKey(flat[at < 0 ? flat.length - 1 : (at - 1 + flat.length) % flat.length]),
        );
      } else if (event.key === "Enter" && at >= 0) {
        event.preventDefault();
        activate(flat[at]);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flat, selectedKey, activate, overlayOpen, peekItem]);

  /* A partially failed PR poll must not read as "nothing in review": naming
     the repos that failed is the difference between stale and wrong. */
  const prsStale =
    prsError ??
    (repoPrs.some((r) => r.error)
      ? `Could not poll: ${repoPrs
          .filter((r) => r.error)
          .map((r) => r.projectName)
          .join(", ")}`
      : null);

  /* Any poll that did not come back. Empty lanes mean "we do not know", not
     "nothing is happening", so the cold start panel holds its tongue. */
  const pollFailing = Boolean(handoffsError || processesError || actError || prsStale);

  function staleFor(key: BoardColumnKey): string | null {
    /* A failed process scan empties the live outside-Maestro cards AND
       drops their handoffs back into Suggested with a live Launch action;
       both columns say so, since launching a second agent onto a directory
       already being driven is the harmful direction. */
    if (key === "suggested") return handoffsError ?? processesError;
    if (key === "building") return processesError ?? actError;
    /* A failed FIRST ACT poll leaves `runs` empty rather than stale, because
       the store only preserves data it already had. Without this the three
       lanes ACT feeds go quiet, the cold start panel reads the quiet as an
       idle machine, and the board states "Nothing is running." on the
       strength of a request that never came back. */
    if (key === "planning" || key === "checking") return actError;
    if (key === "review" || key === "done") return prsStale;
    return null;
  }

  function noteFor(key: BoardColumnKey) {
    if (key !== "suggested") return undefined;
    const activeOutside = externallyActiveDirs.size;
    if (columns.moreHandoffs === 0 && activeOutside === 0) return undefined;
    return (
      <span className="flex shrink-0 items-center gap-2 text-[10px] text-maestro-muted/70">
        {columns.moreHandoffs > 0 && (
          <span title="Older handoffs on disk, one per directory, hidden to keep the column short">
            +{columns.moreHandoffs} more on disk
          </span>
        )}
        {activeOutside > 0 && (
          <span title="Directories with a claude process already running outside Vanguard, so their handoffs are not waiting for anyone">
            {activeOutside} active outside Vanguard
          </span>
        )}
      </span>
    );
  }

  return (
    /* z-45: above the zoomed grid pane (z-40) and below the Home/Factory/
       Landscape/Workflows overlays (z-50), which therefore keep stacking on
       top of the Board with no change to the overlay-exclusivity rules. */
    <div className="absolute inset-0 z-[45] flex flex-col bg-maestro-bg">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-maestro-border px-3">
        {actError && (
          <span
            className={`${badgeBaseClass} bg-maestro-yellow/15 text-maestro-yellow`}
            title={`Factory runs may be out of date: ${actError}`}
          >
            FACTORY STALE
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={markSeen}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-maestro-muted transition-colors hover:bg-maestro-elevated hover:text-maestro-text"
          title="Merged pull requests and finished runs up to now stop counting as news"
        >
          Mark seen
        </button>
        <button
          type="button"
          onClick={() => useTourStore.getState().open()}
          className={headerButtonClass}
          aria-label="Show tour"
          title="Show the app tour"
        >
          <HelpCircle size={13} />
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isRefreshing}
          className={`${headerButtonClass} disabled:opacity-50`}
          aria-label="Refresh"
          title="Refresh handoffs and pull requests"
        >
          <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={onShowGrid}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:bg-maestro-elevated hover:text-maestro-text"
          aria-label="Grid view"
          title="Show the terminal grid"
        >
          <LayoutGrid size={12} /> Grid
        </button>
      </div>

      {/* What is waiting on you, before where everything else is. The board
          under it keeps its shape: this adds a band, it does not take a lane. */}
      <BoardAlertBand blocked={blockedOldestFirst(columns)} onActivate={activate} />

      {/* Six empty lanes say nothing is happening but not why. This says both,
          and offers the handoffs as the thing to pick up. It sits above the
          lanes, never instead of them, so a column emptied by a failed poll
          still gets to show its STALE badge.

          It stays away entirely while any poll is failing. "Nothing is
          running" is a positive claim about the machine, and a lane that is
          empty because the request errored is not evidence for it: that is
          silence being read as an answer. A STALE badge on its own lane is
          the honest thing to show instead. */}
      {isColdStart(columns) && !pollFailing && (
        <BoardColdStart
          handoffs={columns.suggested}
          moreHandoffs={columns.moreHandoffs}
          onActivate={activate}
        />
      )}

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full min-w-[64rem] divide-x divide-maestro-border">
          {BOARD_COLUMN_ORDER.map((key) => {
            const items = columns[key];
            return (
              <div key={key} className="flex min-w-0 flex-1 flex-col overflow-y-auto px-2.5 py-3">
                <BoardColumn
                  title={COLUMN_META[key].title}
                  count={items.length}
                  emptyText={COLUMN_META[key].emptyText}
                  stale={staleFor(key)}
                  note={noteFor(key)}
                >
                  {items.map((item) => {
                    const cardKey = boardCardKey(item);
                    return (
                      <BoardCard
                        key={cardKey}
                        item={item}
                        selected={cardKey === selectedKey}
                        onActivate={() => {
                          setSelectedKey(cardKey);
                          activate(item);
                        }}
                      />
                    );
                  })}
                </BoardColumn>
              </div>
            );
          })}
        </div>
      </div>

      {/* Fleet strip: plain counts, not chips that look clickable. Idle
          sessions get no card anywhere on the board, so this strip is the
          only place they stay visible. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-maestro-border px-3">
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-maestro-muted/70">
          Fleet
        </span>
        {STRIP_ORDER.map((status) => {
          const count = columns.counts[status];
          const badge = SESSION_STATUS_BADGES[status];
          return (
            <span
              key={status}
              className={`flex shrink-0 items-center gap-1 px-0.5 text-[10px] text-maestro-faint ${
                count === 0 ? "opacity-40" : ""
              }`}
              title={`${badge.label}: ${count} session${count === 1 ? "" : "s"}`}
            >
              <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
              <span>{count}</span>
            </span>
          );
        })}
        <div className="flex-1" />
        <span className="shrink-0 text-[10px] text-maestro-muted/70">
          j and k move, Enter opens
        </span>
      </div>

      {peekItem && (
        <BoardPeek
          dir={peekItem.dir}
          cwds={peekItem.cwds}
          projectName={peekItem.projectName}
          onClose={() => setPeekItem(null)}
          onOpenProject={(dir) => {
            setPeekItem(null);
            onOpenProject(dir);
          }}
        />
      )}
    </div>
  );
}
