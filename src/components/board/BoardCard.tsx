import { Factory, GitMerge, GitPullRequest, Play, TerminalSquare } from "lucide-react";
import { badgeBaseClass, SESSION_STATUS_BADGES } from "@/components/session/agentPresentation";
import type { BoardCardItem } from "@/lib/board";

/**
 * One card on the Board: the project, a one-line objective, the stage the
 * work is actually in, how long it has been there, and the needs-you flag.
 *
 * Dumb by construction. Every action arrives as `onActivate` from
 * [`BoardView`], so the click contracts stay in one place and a card can be
 * rendered from a test with plain fixtures.
 *
 * Accent discipline (spec "Visual direction"): the needs-you flag is the only
 * neon accent and the only glow on the board. Blue means working, green done,
 * yellow waiting, purple merged.
 */

/**
 * Relative age of a card's `since` timestamp.
 *
 * A local copy of HomeView's helper rather than an import: this work package
 * adds files only, and lifting eight lines out of HomeView would edit a
 * shipped surface for no behaviour change.
 */
export function relAgo(iso: string): string {
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
 * Stable identity for a card: its React key, and what j/k selection tracks.
 * Selection follows the card rather than a list index so a background poll
 * that inserts a card cannot move the highlight out from under the user.
 */
export function boardCardKey(item: BoardCardItem): string {
  switch (item.kind) {
    case "session":
      return `session:${item.session.id}`;
    case "handoff":
      return `handoff:${item.handoff.path}:${item.handoff.slug}`;
    case "run":
      return `run:${item.run.id}`;
    case "pr":
      return `pr:${item.repoPath}#${item.pr.number}`;
    case "external":
      return `external:${item.dir}`;
  }
}

/**
 * What activating this card does, and, when it can do nothing, why. A card
 * that looks clickable and is not would be a dead control, so the caller
 * renders the second case as plain text carrying this explanation.
 */
export function cardAction(item: BoardCardItem): { enabled: boolean; title: string } {
  switch (item.kind) {
    case "session":
      return item.tabId
        ? { enabled: true, title: "Jump to this terminal" }
        : {
            enabled: false,
            title: "This project is not open in a tab, so there is no terminal to jump to",
          };
    case "handoff":
      return { enabled: true, title: "Launch a session here, seeded with the handoff" };
    case "run":
      return { enabled: true, title: "Open this run in the Factory" };
    case "pr":
      return { enabled: true, title: "Open on GitHub" };
    case "external":
      return {
        enabled: true,
        title:
          "Peek at what this outside session is doing. Maestro cannot show its live terminal, only the transcript trail.",
      };
  }
}

/** The stage chip: session statuses reuse the shared badges, everything else carries its own truth. */
function stageChip(item: BoardCardItem): { label: string; cls: string; mono: boolean } {
  switch (item.kind) {
    case "session": {
      const badge = SESSION_STATUS_BADGES[item.session.status];
      return { label: badge.label, cls: badge.cls, mono: false };
    }
    case "handoff":
      return { label: "ON DISK", cls: "bg-maestro-yellow/15 text-maestro-yellow", mono: false };
    case "run":
      /* The raw stage string, never a prettified one: an ACT stage the
         keyword table does not recognise lands in Building and must show
         what it actually is (board.ts's fallback contract). */
      return { label: item.stageLabel, cls: "bg-maestro-muted/15 text-maestro-muted", mono: true };
    case "pr":
      return {
        label: item.stageLabel.toUpperCase(),
        cls: item.pr.mergedAt
          ? "bg-maestro-purple/15 text-maestro-purple"
          : item.needsYou
            ? "bg-maestro-accent/15 text-maestro-accent"
            : "bg-maestro-blue/15 text-maestro-blue",
        mono: false,
      };
    case "external":
      /* Blue means working, matching live sessions: this work IS live, it
         just is not Maestro's to open. */
      return { label: "OUTSIDE MAESTRO", cls: "bg-maestro-blue/15 text-maestro-blue", mono: false };
  }
}

/**
 * The stage a card is in, as one word, exposed on the DOM as `data-stage`.
 *
 * Quiet Deck's rule: a column of cards must show the shape of the work before
 * a single word is read, so the stage is carried by a 2px stripe down the left
 * edge rather than by the chip alone. `needsYou` outranks everything: a card
 * waiting on Alex is that, whatever else is also true of it.
 */
export type CardStage =
  | "needs"
  | "working"
  | "waiting"
  | "review"
  | "merged"
  | "done"
  | "starting"
  | "error"
  | "idle";

export function stageOf(item: BoardCardItem): CardStage {
  if (item.needsYou) return "needs";
  switch (item.kind) {
    case "session":
      switch (item.session.status) {
        case "Working":
          return "working";
        case "Starting":
          return "starting";
        case "Done":
          return "done";
        case "Error":
        case "Timeout":
          return "error";
        default:
          return "idle";
      }
    /* A handoff is not work in flight, it is work waiting for you to pick it
       up, so it shares the waiting colour rather than borrowing working. */
    case "handoff":
      return "waiting";
    case "run":
      return "working";
    case "pr":
      return item.pr.mergedAt ? "merged" : "review";
    /* Live work Maestro cannot open is still live work. */
    case "external":
      return "working";
  }
}

/** The stripe colour for a stage. Accent is reserved for needs-you. */
const STAGE_STRIPE: Record<CardStage, string> = {
  needs: "border-l-maestro-alarm",
  working: "border-l-maestro-blue",
  waiting: "border-l-maestro-yellow",
  review: "border-l-maestro-blue/60",
  merged: "border-l-maestro-purple",
  done: "border-l-maestro-green",
  starting: "border-l-maestro-orange",
  error: "border-l-maestro-red",
  idle: "border-l-maestro-border-strong",
};

function cardIcon(item: BoardCardItem) {
  switch (item.kind) {
    case "session":
    case "external":
      return TerminalSquare;
    case "handoff":
      return Play;
    case "run":
      return Factory;
    case "pr":
      return item.pr.mergedAt ? GitMerge : GitPullRequest;
  }
}

export function BoardCard({
  item,
  selected,
  onActivate,
}: {
  item: BoardCardItem;
  selected: boolean;
  onActivate: () => void;
}) {
  const action = cardAction(item);
  const chip = stageChip(item);
  const Icon = cardIcon(item);

  const stage = stageOf(item);

  /* Border contrast before shadow: the card is held by its hairline and its
     stage stripe, and the glow is spent on the one card that needs you.

     The ground is set in the branch, never in the base. Two background
     utilities on one element do not stack, they race, and the winner is
     whichever Tailwind emits last: the needs-you fill lost that race and
     never painted at all. */
  const shell = [
    "flex w-full flex-col rounded-md border border-l-2 px-2.5 py-2 text-left transition-colors",
    STAGE_STRIPE[stage],
    item.needsYou
      ? "border-maestro-alarm/60 bg-maestro-alarm-ground shadow-[0_0_0_1px_rgb(var(--maestro-alarm)/0.16),0_0_24px_-8px_rgb(var(--maestro-alarm)/0.55)]"
      : "border-maestro-border bg-maestro-card",
    selected ? "ring-1 ring-maestro-text/50" : "",
  ].join(" ");

  /* Reading order is the point of the card. The objective is the line you
     are actually scanning for, so it is the headline; the project is the
     label above it, set small and in mono the way a path is. It used to be
     the other way round, which made a column of cards read as a list of
     repos rather than a list of work. */
  const body = (
    <>
      <span className="flex w-full items-center gap-1.5">
        <Icon size={10} className="shrink-0 text-maestro-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-tight text-maestro-muted">
          {item.projectName}
        </span>
      </span>
      <span className="mt-0.5 block w-full truncate text-[12px] font-medium leading-snug text-maestro-text">
        {item.objective}
      </span>
      <span className="mt-1.5 flex w-full items-center gap-1">
        <span className={`${badgeBaseClass} ${chip.cls} ${chip.mono ? "font-mono" : ""}`}>
          {chip.label}
        </span>
        {item.needsYou && (
          <span className={`${badgeBaseClass} bg-maestro-alarm/20 text-maestro-alarm`}>
            NEEDS YOU
          </span>
        )}
        {item.since && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-maestro-faint">
            {relAgo(item.since)}
          </span>
        )}
      </span>
    </>
  );

  if (!action.enabled) {
    return (
      <div
        className={`${shell} cursor-default`}
        title={action.title}
        data-testid="board-card"
        data-stage={stage}
        data-selected={selected || undefined}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`${shell} hover:border-maestro-muted/50`}
      onClick={onActivate}
      title={action.title}
      data-testid="board-card"
      data-stage={stage}
      data-selected={selected || undefined}
    >
      {body}
    </button>
  );
}
