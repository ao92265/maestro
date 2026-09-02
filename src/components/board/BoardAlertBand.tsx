import { boardCardKey, cardAction, relAgo } from "@/components/board/BoardCard";
import type { BoardCardItem } from "@/lib/board";

/**
 * The band across the top of the Board: what is waiting on you, right now.
 *
 * The Board answers "where is everything". It does not answer "what needs
 * me", which was the question Alex was actually asking when he said he did
 * not feel like he knew what was going on. A stage column tells you a card
 * moved; it does not put the question in front of you. This does.
 *
 * The oldest question leads, because a session that has been blocked nine
 * minutes has been blocked nine minutes whatever else has happened since.
 * Everything else queues behind it in the same order.
 *
 * Deliberately absent: the y/n keys the mockup drew. The band cannot type
 * into a terminal, so a key that looked like it answered the question would
 * be exactly the dead control this redesign exists to remove. It offers the
 * action the card really has, and when the card has none it says why.
 */
export function BoardAlertBand({
  blocked,
  onActivate,
}: {
  /** Every card waiting on Alex, oldest first. Empty renders nothing. */
  blocked: BoardCardItem[];
  onActivate: (item: BoardCardItem) => void;
}) {
  if (blocked.length === 0) return null;

  const [lead, ...queue] = blocked;
  const action = cardAction(lead);
  const waited = lead.since ? relAgo(lead.since) : "";

  return (
    <section
      aria-label="Waiting on you"
      className="flex shrink-0 items-stretch gap-4 border-b border-l-[3px] border-maestro-border border-l-maestro-alarm bg-maestro-surface px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1" data-testid="band-lead">
        <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-maestro-alarm">
          <span data-testid="band-count">
            {blocked.length === 1 ? "Waiting on you" : `${blocked.length} waiting on you`}
          </span>
          {waited && <span>· {waited}</span>}
          <span>· {lead.projectName}</span>
        </p>
        <p className="truncate text-[17px] font-semibold tracking-[-0.018em] text-maestro-text">
          {lead.objective}
        </p>
        {!action.enabled && <p className="text-[12px] text-maestro-muted">{action.title}</p>}
      </div>

      {action.enabled && (
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onActivate(lead)}
            className="rounded-md border border-maestro-alarm/50 bg-maestro-alarm/10 px-3 py-1.5 text-[12px] font-medium text-maestro-alarm transition-colors hover:bg-maestro-alarm/20"
            title={action.title}
          >
            Open
          </button>
        </div>
      )}

      {queue.length > 0 && (
        <div
          className="flex w-[290px] shrink-0 flex-col gap-1.5 border-l border-maestro-border pl-4"
          data-testid="band-queue"
        >
          {queue.slice(0, 2).map((item) => (
            <div key={boardCardKey(item)} className="flex flex-col">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-maestro-faint">
                {item.projectName}
                {item.since ? ` · ${relAgo(item.since)}` : ""}
              </span>
              <span className="truncate text-[12px] text-maestro-text-2">{item.objective}</span>
            </div>
          ))}
          {queue.length > 2 && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-maestro-faint">
              +{queue.length - 2} more waiting
            </span>
          )}
        </div>
      )}
    </section>
  );
}
