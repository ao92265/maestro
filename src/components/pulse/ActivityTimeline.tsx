import { ACTIVITY_MARK } from "@/components/pulse/pulsePresentation";
import type { ActivityEvent } from "@/lib/pulse";

/**
 * Today, newest first: commits that landed, sessions that asked you something,
 * and the hook lines the agents left behind. Capped at 40 rows by the port —
 * a timeline you have to scroll for ten minutes is a log, not a timeline.
 */
export function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded border border-maestro-border bg-maestro-card p-3 text-[11px] text-maestro-muted">
        Nothing has happened yet today.
      </p>
    );
  }

  return (
    <ol className="divide-y divide-maestro-border rounded border border-maestro-border bg-maestro-card">
      {events.map((event, index) => {
        const mark = ACTIVITY_MARK[event.kind];
        return (
          <li
            // Two commits can share a minute and a message; the position in an
            // already-sorted list is the only stable key available.
            key={`${event.time}-${event.text}-${index}`}
            className="flex items-baseline gap-2 px-3 py-1.5 text-[11px]"
          >
            <span className="w-12 shrink-0 font-mono text-maestro-muted">{event.time}</span>
            {/* Decorative: the row's own text already says what happened. */}
            <span className={`w-3 shrink-0 ${mark.cls}`} title={mark.label} aria-hidden="true">
              {mark.glyph}
            </span>
            <span className="truncate text-maestro-text" title={event.text}>
              {event.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
