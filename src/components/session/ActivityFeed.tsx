import { memo, useEffect, useRef } from "react";
import { useActivityStore } from "@/stores/useActivityStore";
import type { ClaudeEvent } from "@/types/claude-events";

interface ActivityFeedProps {
  sessionId: number;
  maxHeight?: string;
}

// React keys must not be array indices here: the store caps the buffer by
// splicing the oldest events off the front, so past MAX_EVENTS_PER_SESSION
// every new event shifts every surviving event down one index and React
// remounts the whole list. Event objects are never mutated or recreated (the
// store copies the array, not the elements), so a WeakMap gives each one a
// permanent identity; evicted events are garbage-collected with their key.
const rowKeys = new WeakMap<ClaudeEvent, number>();
let nextRowKey = 0;

function keyFor(event: ClaudeEvent): number {
  let key = rowKeys.get(event);
  if (key === undefined) {
    key = nextRowKey++;
    rowKeys.set(event, key);
  }
  return key;
}

export function ActivityFeed({
  sessionId,
  maxHeight = "300px",
}: ActivityFeedProps) {
  const session = useActivityStore((state) => state.getSession(sessionId));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest event by scrolling ONLY this container.
  // Do not use scrollIntoView here: it scrolls every scrollable ancestor
  // (including overflow-hidden terminal cells), shifting the whole layout up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.events.length]);

  return (
    <div
      ref={scrollRef}
      style={{ maxHeight, overflow: "auto" }}
      className="font-mono text-xs space-y-0.5 p-2 bg-neutral-900/50 rounded border border-neutral-800"
    >
      {session.events.length === 0 && (
        <div className="text-neutral-500 italic text-center py-2">
          Waiting for session activity...
        </div>
      )}
      {session.events.map((event) => (
        <EventRow key={keyFor(event)} event={event} />
      ))}
    </div>
  );
}

// Memoized: with stable keys the event objects are referentially stable too,
// so an appended event re-renders one row instead of every row in the buffer.
const EventRow = memo(function EventRow({ event }: { event: ClaudeEvent }) {
  const time = formatTime(event.timestamp);

  switch (event.event_type) {
    case "ToolUseStarted":
      return (
        <div className="flex gap-2 text-blue-400">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span className="font-semibold shrink-0">{event.tool_name}</span>
          <span className="text-neutral-400 truncate">
            {event.input_summary}
          </span>
        </div>
      );
    case "FileEdited":
      return (
        <div className="flex gap-2 text-yellow-400">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span className="shrink-0">EDIT</span>
          <span className="truncate">{event.file_path}</span>
        </div>
      );
    case "FileCreated":
      return (
        <div className="flex gap-2 text-green-400">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span className="shrink-0">CREATE</span>
          <span className="truncate">{event.file_path}</span>
        </div>
      );
    case "SubagentSpawned":
      return (
        <div className="flex gap-2 text-purple-400">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span className="shrink-0">AGENT</span>
          <span className="font-semibold">{event.agent_type}</span>
          <span className="text-neutral-400 truncate">
            {event.description}
          </span>
        </div>
      );
    case "TokenUsageUpdate":
      return (
        <div className="flex gap-2 text-neutral-500">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span>
            {event.input_tokens.toLocaleString()}in /{" "}
            {event.output_tokens.toLocaleString()}out
          </span>
        </div>
      );
    case "SessionStarted":
      return (
        <div className="flex gap-2 text-green-300">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span className="font-semibold">SESSION STARTED</span>
        </div>
      );
    case "SessionEnded":
      return (
        <div className="flex gap-2 text-red-300">
          <span className="text-neutral-600 shrink-0">{time}</span>
          <span className="font-semibold">SESSION ENDED</span>
          <span className="text-neutral-400">{event.reason}</span>
        </div>
      );
    default:
      return null;
  }
});

// One formatter for the whole list. toLocaleTimeString([], opts) built a fresh
// options object and looked up an Intl formatter per row per render; the locale
// ([] = runtime default) and options here are the same, so the output string is
// identical.
const timeFormatter = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    // Intl.DateTimeFormat throws on an invalid date where toLocaleTimeString
    // returned the literal "Invalid Date"; keep emitting that same string.
    if (Number.isNaN(date.getTime())) return date.toLocaleTimeString();
    return timeFormatter.format(date);
  } catch {
    return timestamp;
  }
}
