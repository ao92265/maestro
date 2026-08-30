import { ArrowLeft, History } from "lucide-react";
import type { ActReplay } from "@/lib/actControl";
import { useActControlStore } from "@/stores/useActControlStore";
import { EmptyLine, PanelSection, relAgo } from "./primitives";

/** Event kinds ACT records, coloured so a failure stands out in a long scan. */
const EVENT_TONES: Record<string, string> = {
  spawn: "text-maestro-blue",
  tool_use: "text-maestro-muted",
  output: "text-maestro-muted",
  decision: "text-maestro-purple",
  commit: "text-maestro-green",
  completion: "text-maestro-green",
  failure: "text-maestro-red",
  notepad: "text-maestro-yellow",
};

function eventTone(type: string): string {
  return EVENT_TONES[type] ?? "text-maestro-muted";
}

function clockOf(iso: string | null): string {
  if (!iso) return "--:--:--";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "--:--:--" : parsed.toLocaleTimeString();
}

/**
 * Session replay: the index of stored agent sessions, and one session's
 * timeline when opened.
 *
 * ACT keys replays by AGENT id, not by portal run id — a run's stages each
 * get their own agent, so one run can appear here as several sessions.
 */
export function ReplayTimeline({ replays }: { replays: ActReplay[] }) {
  const openReplayAgentId = useActControlStore((state) => state.openReplayAgentId);
  const replayEvents = useActControlStore((state) => state.replayEvents);
  const replayTotal = useActControlStore((state) => state.replayTotal);
  const replayError = useActControlStore((state) => state.replayError);
  const openReplay = useActControlStore((state) => state.openReplay);
  const closeReplay = useActControlStore((state) => state.closeReplay);

  if (openReplayAgentId) {
    const replay = replays.find((r) => r.agentId === openReplayAgentId);
    const truncated = replayTotal > replayEvents.length;
    return (
      <PanelSection
        title="Session replay"
        hint={
          replay
            ? `${replay.runtime} · ${replayTotal || replay.eventCount} events`
            : openReplayAgentId
        }
        action={
          <button
            type="button"
            onClick={closeReplay}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-maestro-muted transition-colors hover:text-maestro-text"
          >
            <ArrowLeft size={10} /> All sessions
          </button>
        }
      >
        {replayError && <p className="text-[11px] text-maestro-yellow">{replayError}</p>}
        {!replayError && replayEvents.length === 0 && (
          <EmptyLine>No stored timeline for this session.</EmptyLine>
        )}
        {truncated && (
          /* The tail is what is shown, so say which end was cut rather than
             letting the header's full count imply the whole session. */
          <p className="text-[10px] text-maestro-muted">
            Showing the last {replayEvents.length} of {replayTotal} events; the earlier{" "}
            {replayTotal - replayEvents.length} are not loaded.
          </p>
        )}
        {replayEvents.length > 0 && (
          <ol className="flex max-h-80 flex-col overflow-y-auto">
            {replayEvents.map((event, index) => (
              <li
                // ACT's replay events carry no id and a burst can share a
                // timestamp, so ordinal position completes the key.
                key={`${event.timestamp}-${index}`}
                className="flex items-start gap-2 border-l border-maestro-border py-0.5 pl-2"
              >
                <span className="shrink-0 font-mono text-[10px] text-maestro-muted/70">
                  {clockOf(event.timestamp)}
                </span>
                <span
                  className={`w-20 shrink-0 text-[10px] font-semibold ${eventTone(event.type)}`}
                >
                  {event.type.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 flex-1 break-words text-[11px] text-maestro-text">
                  {event.summary}
                </span>
              </li>
            ))}
          </ol>
        )}
      </PanelSection>
    );
  }

  return (
    <PanelSection
      title="Session replay"
      hint={replays.length > 0 ? `${replays.length} sessions` : undefined}
    >
      {replays.length === 0 ? (
        <EmptyLine>No replays stored. ACT writes one when an agent session ends.</EmptyLine>
      ) : (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
          {replays.map((replay) => (
            <li key={replay.sessionId}>
              <button
                type="button"
                onClick={() => void openReplay(replay.agentId)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-maestro-bg"
              >
                <History size={11} className="shrink-0 text-maestro-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-maestro-text">
                  {replay.agentId}
                </span>
                <span className="shrink-0 text-[10px] text-maestro-muted">{replay.runtime}</span>
                <span className="w-16 shrink-0 text-right font-mono text-[10px] text-maestro-muted">
                  {replay.eventCount} evt
                </span>
                <span className="w-14 shrink-0 text-right text-[10px] text-maestro-muted">
                  {relAgo(replay.startedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
