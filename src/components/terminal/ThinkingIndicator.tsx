import { memo } from "react";
import { type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";

/**
 * Derived "thinking" state for a session.
 *
 * Reuses the existing backend SessionStatus signal (driven by Claude MCP
 * status hooks + StatusUpdate events) rather than introducing a new
 * subscription. The toast-notifications agent listens to the same field
 * via useSessionStore, so we share the source of truth.
 *
 *  - "thinking"   → backend reports the model is actively processing.
 *  - "needs-input"→ model is waiting on the user.
 *  - "idle"       → everything else (Idle/Done/Starting/Error/Timeout).
 *
 * Note: we treat "Starting" as idle (not thinking) — the dots would be
 * misleading before the CLI is even ready.
 */
function deriveActivity(status: BackendSessionStatus | undefined): "thinking" | "needs-input" | "idle" {
  if (status === "Working") return "thinking";
  if (status === "NeedsInput") return "needs-input";
  return "idle";
}

/**
 * Human label for every session state.
 *
 * The dots collapse most states into "idle" (only two of them animate), but the
 * text must not: `Starting`, `Done`, `Error` and `Timeout` used to read
 * identically to a genuinely idle agent, and a session with no status at all
 * read as nothing (issue #77). Anything unrecognised — including a status the
 * backend added and the frontend has not learned yet — falls back to "No status
 * reported" rather than an empty label.
 */
const STATUS_LABELS: Record<BackendSessionStatus, string> = {
  Starting: "Starting up",
  Idle: "Idle",
  Working: "Model is thinking",
  NeedsInput: "Awaiting user input",
  Done: "Finished",
  Error: "Errored",
  Timeout: "Startup timed out",
};

export function statusLabel(status: BackendSessionStatus | undefined): string {
  return (status && STATUS_LABELS[status]) || "No status reported";
}

interface ThinkingIndicatorProps {
  sessionId: number;
  /** Approximate dot diameter in px. Defaults to 3.5px. */
  size?: number;
  /** Optional extra wrapper classes (e.g. spacing tweaks for headers vs tabs). */
  className?: string;
}

/**
 * Tiny three-dot CSS-only "is the model thinking?" pulse.
 *
 * Animation: dots fade in/out with a staggered delay while `Working`.
 * Idle:      dots stay subtle and static (no animation cost).
 * NeedsInput: dots tint red to flag user action required.
 *
 * Performance: pure CSS keyframes — no React render loop. Respects
 * `prefers-reduced-motion` via the global rule in globals.css.
 */
/**
 * Live status dot for a session (tab strips, chips): blue while working, red
 * when the agent waits for the user (pulsing), green when done, muted idle.
 * Replaces the previously hardcoded green dots so "your turn" reads at a
 * glance from any tab strip.
 */
export const SessionStatusDot = memo(function SessionStatusDot({
  sessionId,
  className = "",
}: {
  sessionId: number;
  className?: string;
}) {
  const status = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.status);
  const label = statusLabel(status);
  const color =
    status === "Working"
      ? "bg-maestro-blue"
      : status === "NeedsInput"
        ? "bg-maestro-accent animate-pulse"
        : status === "Done"
          ? "bg-maestro-green"
          : status === "Error" || status === "Timeout"
            ? "bg-maestro-red"
            : status === "Starting"
              ? "bg-maestro-orange"
              : "bg-maestro-muted/40";
  // Labelled: a bare coloured dot says nothing on hover and nothing at all to a
  // screen reader, which is its own flavour of "blank status" (issue #77).
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${color} ${className}`}
    />
  );
});

export const ThinkingIndicator = memo(function ThinkingIndicator({
  sessionId,
  size = 3.5,
  className = "",
}: ThinkingIndicatorProps) {
  // Subscribe to the minimum scalar needed so unrelated session updates
  // don't re-render this component.
  const status = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.status);
  const activity = deriveActivity(status);
  const label = statusLabel(status);

  const dotColor =
    activity === "thinking"
      ? "bg-maestro-blue"
      : activity === "needs-input"
        ? "bg-maestro-accent"
        : "bg-maestro-muted/40";

  // Both live states ripple: these dots are the app's primary "what is this
  // terminal doing?" signal, and a static red dot reads the same as a stale one.
  // Only idle stands still.
  //
  // The class is applied plainly, NOT as `motion-safe:animate-thinking-dot`:
  // `animate-thinking-dot` is hand-written in globals.css rather than a Tailwind
  // theme animation, so Tailwind never generates a `motion-safe:` variant of it
  // and the dots silently never animated. Reduced motion is already honoured by
  // the `prefers-reduced-motion` block in globals.css.
  const animate = activity !== "idle";

  const dotStyle = {
    width: `${size}px`,
    height: `${size}px`,
  } as const;

  const dotClass = `rounded-full ${dotColor} ${
    animate ? "animate-thinking-dot motion-reduce:opacity-70" : "opacity-60"
  }`;

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center gap-0.5 ${className}`}
    >
      <span style={{ ...dotStyle, animationDelay: "0ms" }} className={dotClass} />
      <span style={{ ...dotStyle, animationDelay: "180ms" }} className={dotClass} />
      <span style={{ ...dotStyle, animationDelay: "360ms" }} className={dotClass} />
    </span>
  );
});
