import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { samePath } from "@/lib/path";
import { type SamuraiSupervisorState, useSessionStore } from "@/stores/useSessionStore";

/**
 * States that warrant the full-width tile banner. The 9px {@link
 * SamuraiBadge} pill in the header is too subtle for "Maestro is about to
 * take an action on your terminal" — this is the can't-miss version.
 *
 * `HANDOFF_REQUESTED` flips BEFORE the handoff text is typed into the PTY
 * (see `useSessionStore`'s `samurai-supervisor-event` handler), so the
 * banner appears at the earliest possible moment, not after the fact.
 */
const BANNER_STATES: ReadonlySet<SamuraiSupervisorState> = new Set([
  "HANDOFF_REQUESTED",
  "HANDOFF_WRITTEN",
  "PARK_REQUESTED",
]);

/** Banner copy per triggering state. Plain language, not state-machine names (PRD §9). */
function bannerText(state: SamuraiSupervisorState, generation: number): string {
  if (state === "PARK_REQUESTED") {
    return `Maestro is about to park this agent (gen-${generation})`;
  }
  return `Maestro is handing off gen-${generation} — next generation will take over shortly`;
}

/**
 * Slim full-width attention strip for a Samurai-supervised terminal tile,
 * shown whenever the supervisor is about to hand off or park the agent
 * (issue #109 follow-up: the header badge alone was too subtle). Renders
 * nothing otherwise, so every existing tile stays visually unchanged.
 *
 * Mounted between `TerminalHeader` and the terminal content in
 * `TerminalView` — it must not steal focus (no interactive elements) and
 * only ever adds/removes a fixed-height row, so xterm's ResizeObserver-driven
 * refit handles it the same way it already handles the header.
 */
export const SamuraiHandoffBanner = memo(function SamuraiHandoffBanner({
  sessionId,
}: {
  sessionId: number;
}) {
  const info = useSessionStore(
    useShallow((s) => {
      const entry = s.samuraiBySessionId[sessionId];
      if (!entry || !BANNER_STATES.has(entry.state)) return null;
      const session = s.sessions.find((x) => x.id === sessionId);
      // Same id+project defence as SamuraiBadge/the DEAD handler: session ids
      // alone are not trusted to be unique across projects.
      if (!session || !samePath(session.project_path, entry.project)) return null;
      return { generation: entry.generation, state: entry.state };
    }),
  );
  if (!info) return null;

  return (
    <output className="flex h-6 shrink-0 animate-pulse items-center justify-center gap-1.5 border-b border-maestro-orange/40 bg-maestro-orange/20 px-2 text-maestro-orange motion-reduce:animate-none">
      <span className="truncate text-[11px] font-semibold tracking-wide">
        {bannerText(info.state, info.generation)}
      </span>
    </output>
  );
});
