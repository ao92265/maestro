import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";

/** Default time a toast stays on screen before auto-dismissing. */
export const TOAST_DURATION_MS = 8000;

interface ToastProps {
  /** Accent for the left border + dot (e.g. a project color). */
  accentColor?: string;
  /**
   * What happened, in two or three words ("Review requested", "Memory").
   * Rendered small and uppercase above the subject: the reader answers
   * "what is this?" before reading anything else.
   */
  kicker: string;
  /** The subject itself — the PR/issue, the file, the process. One line. */
  title: string;
  /** Optional supporting line: where it is, or why it was raised. */
  detail?: string;
  /** Auto-dismiss delay; the dismiss button always works immediately. */
  durationMs?: number;
  /** Optional action when the toast body is clicked. */
  onClick?: () => void;
  onDismiss: () => void;
}

/**
 * Minimal reusable toast card. Purely presentational: the caller owns the
 * queue (what shows, in which order) and receives dismiss/click callbacks.
 * Render inside a {@link ToastStack}.
 *
 * The card reads top-down as three separate facts — kind, subject, context —
 * rather than one run-on sentence, so it can be understood at a glance without
 * parsing punctuation. Clickable cards say so with an arrow rather than words.
 */
export function Toast({
  accentColor,
  kicker,
  title,
  detail,
  durationMs = TOAST_DURATION_MS,
  onClick,
  onDismiss,
}: ToastProps) {
  // Auto-dismiss after the configured duration. `onDismiss` is read through
  // a ref so callers may pass a fresh closure every render (typical for
  // toasts mapped from a store) without resetting the countdown — otherwise
  // each stack re-render (e.g. a sibling dismissing) would restart every
  // remaining toast's timer.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  useEffect(() => {
    const timer = setTimeout(() => onDismissRef.current(), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs]);

  return (
    <output
      className="pointer-events-auto flex w-80 items-start gap-2 rounded-lg border border-maestro-border bg-maestro-surface p-3 shadow-lg"
      style={accentColor ? { borderLeft: `3px solid ${accentColor}` } : undefined}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        title={onClick ? "Open on GitHub" : undefined}
        className="group flex min-w-0 flex-1 flex-col items-start gap-1 text-left disabled:cursor-default"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {accentColor && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
          )}
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
            {kicker}
          </span>
          {onClick && (
            <ExternalLink
              size={10}
              className="ml-auto shrink-0 text-maestro-muted transition-colors group-hover:text-maestro-text"
            />
          )}
        </span>
        <span className="line-clamp-2 w-full text-xs font-medium leading-snug text-maestro-text">
          {title}
        </span>
        {detail && <span className="truncate w-full text-[11px] text-maestro-muted">{detail}</span>}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-border/40 hover:text-maestro-text"
        aria-label="Dismiss notification"
      >
        <X size={12} />
      </button>
    </output>
  );
}

/** Fixed bottom-right column that hosts toasts without blocking clicks. */
export function ToastStack({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed bottom-10 right-3 z-50 flex flex-col gap-2">
      {children}
    </div>
  );
}
