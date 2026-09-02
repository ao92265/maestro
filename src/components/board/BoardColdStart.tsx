import { BoardCard, boardCardKey } from "@/components/board/BoardCard";
import type { BoardCardItem } from "@/lib/board";

/**
 * What the Board says when nothing is running.
 *
 * Six empty lanes tell you nothing is happening but not why, and not what you
 * could do about it. This says both, in the words the pivot demanded: a
 * handoff is a FILE on disk, not a running session. The old wording counted
 * these same files as "10 sessions parked" while Alex was actively typing in
 * one of those directories in iTerm.
 *
 * It sits ABOVE the lanes rather than replacing them, which the first cut got
 * wrong. A column emptied by a failed poll also has no cards, so a panel that
 * replaced the board would have hidden the STALE badges and made a broken
 * fetch look like a quiet machine.
 */
export function BoardColdStart({
  handoffs,
  moreHandoffs,
  onActivate,
}: {
  /** The Suggested lane's cards: handoff files, newest first. */
  handoffs: BoardCardItem[];
  /** Handoffs the board's display cap left out of `handoffs`. */
  moreHandoffs: number;
  onActivate: (item: BoardCardItem) => void;
}) {
  const total = handoffs.length + moreHandoffs;
  const shown = handoffs.slice(0, 3);
  /* Counts the lane, not the disk. `moreHandoffs` is exactly the set the
     board's display cap kept OUT of the lane, so folding it in here sent you
     down to look for rows that were never rendered. The disk total still
     leads the paragraph above; this number only ever describes what is
     genuinely below. */
  const alsoInLane = handoffs.length - shown.length;

  return (
    <section
      aria-label="Nothing is running"
      className="flex shrink-0 items-start gap-6 border-b border-maestro-border bg-maestro-surface px-4 py-3.5"
      data-testid="cold-start"
    >
      <div className="flex min-w-0 max-w-[46ch] flex-col gap-1.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-maestro-text">
          Nothing is running.
        </h2>

        {total === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-maestro-muted">
            No handoffs on disk either, so there is nothing here to pick up. Start a terminal and
            this fills in on its own.
          </p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-maestro-muted">
            There {total === 1 ? "is" : "are"}{" "}
            <span className="text-maestro-text-2">
              {total} {total === 1 ? "handoff" : "handoffs"} on disk
            </span>{" "}
            from previous sessions. They are files, not running sessions: opening one starts a fresh
            terminal in that directory, seeded with where the last one got to.
          </p>
        )}
      </div>

      {shown.length > 0 && (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="grid min-w-0 gap-2 sm:grid-cols-3">
            {shown.map((item) => (
              <BoardCard
                key={boardCardKey(item)}
                item={item}
                selected={false}
                onActivate={() => onActivate(item)}
              />
            ))}
          </div>
          {alsoInLane > 0 && (
            <p className="text-[11px] text-maestro-faint">
              {alsoInLane} more {alsoInLane === 1 ? "is" : "are"} in the Suggested lane below.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
