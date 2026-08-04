import { X } from "lucide-react";
import { useEffect } from "react";

/** Default time a toast stays on screen before auto-dismissing. */
export const TOAST_DURATION_MS = 8000;

interface ToastProps {
  /** Accent for the left border + dot (e.g. a project color). */
  accentColor?: string;
  title: string;
  subtitle?: string;
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
 */
export function Toast({
  accentColor,
  title,
  subtitle,
  durationMs = TOAST_DURATION_MS,
  onClick,
  onDismiss,
}: ToastProps) {
  // Auto-dismiss after the configured duration.
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, onDismiss]);

  return (
    <div
      className="pointer-events-auto flex w-80 items-start gap-2 rounded-lg border border-maestro-border bg-maestro-surface p-3 shadow-lg"
      style={accentColor ? { borderLeft: `3px solid ${accentColor}` } : undefined}
      role="status"
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-default"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {accentColor && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
          )}
          <span className="truncate text-xs font-semibold text-maestro-text">{title}</span>
        </span>
        {subtitle && (
          <span className="line-clamp-2 w-full text-[11px] text-maestro-muted">{subtitle}</span>
        )}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-border/40 hover:text-maestro-text"
        aria-label="Dismiss notification"
      >
        <X size={12} />
      </button>
    </div>
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
