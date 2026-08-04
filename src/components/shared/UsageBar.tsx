import { useEffect, useRef, useState } from "react";
import { ChevronUp, RefreshCw } from "lucide-react";
import { useUsageStore } from "@/stores/useUsageStore";
import {
  formatResetTime,
  getUsageBars,
  mostCriticalBar,
  type UsageWindowBar,
} from "@/lib/usageParser";

function barColor(percent: number): string {
  if (percent < 50) return "bg-maestro-green";
  if (percent <= 70) return "bg-maestro-yellow";
  return "bg-maestro-red";
}

/** Guard NaN/Infinity (Math.min/max alone propagate NaN) → 0, clamp to [0,100]. */
function clampPercent(percent: number): number {
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

/**
 * Compact usage trigger for the footer: shows the most critical reported
 * window as a mini bar, and opens a drop-up (same pattern as
 * `TerminalNavigator`) listing every window the API reported — one full bar
 * per window, with reset time and, for the spend budget, the dollar figures.
 */
export function UsageBar() {
  const { usage, needsAuth, error, isLoading, fetchUsage, startPolling } = useUsageStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => startPolling(), [startPolling]);

  // Close on click-away or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (needsAuth) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-maestro-muted/70">
        <span>Run </span>
        <code className="rounded bg-maestro-card px-1 py-0.5">claude</code>
        <span> to see usage</span>
      </div>
    );
  }

  const bars = usage ? getUsageBars(usage) : [];

  if (error || !usage || bars.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-maestro-muted/50" title={error ?? undefined}>
          Usage unavailable
        </span>
        <RefreshButton onClick={() => fetchUsage(true)} spinning={isLoading} />
      </div>
    );
  }

  // bars.length > 0 here, so a most-critical bar always exists.
  const top = mostCriticalBar(bars);
  const topPct = clampPercent(top?.percent ?? 0);

  return (
    <div ref={rootRef} className="relative flex items-center gap-1">
      <RefreshButton onClick={() => fetchUsage(true)} spinning={isLoading} />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Claude usage — click to see all windows"
        aria-label="Claude usage"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-maestro-card hover:text-maestro-text ${
          open ? "bg-maestro-card text-maestro-text" : "text-maestro-muted/70"
        }`}
      >
        <span className="whitespace-nowrap">{top?.label}</span>
        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-maestro-border/50">
          <span
            className={`block h-full rounded-full transition-all duration-500 ${barColor(topPct)}`}
            style={{ width: `${topPct}%` }}
          />
        </span>
        <span>{Math.round(topPct)}%</span>
        <ChevronUp
          size={10}
          className={`shrink-0 transition-transform ${open ? "" : "rotate-180"}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-72 rounded-lg border border-maestro-border bg-maestro-card p-3 shadow-xl shadow-black/40">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-maestro-muted/70">
            Claude usage
          </p>
          <div className="flex flex-col gap-3">
            {bars.map((bar) => (
              <WindowRow key={bar.label} bar={bar} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={spinning}
      title="Refresh usage data"
      aria-label="Refresh usage data"
      className="flex h-6 w-6 items-center justify-center rounded-md text-maestro-muted/60 transition-colors hover:bg-maestro-border/40 hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-40"
    >
      <RefreshCw size={12} className={spinning ? "animate-spin" : ""} />
    </button>
  );
}

/** One reported window inside the drop-up: name, percent (+dollars), bar, reset. */
function WindowRow({ bar }: { bar: UsageWindowBar }) {
  const pct = clampPercent(bar.percent);
  const reset = formatResetTime(bar.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
        <span className="text-maestro-muted/80">{bar.label}</span>
        <span className="text-maestro-muted/60">
          {Math.round(pct)}%{bar.detail ? ` · ${bar.detail}` : ""}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-maestro-border/50">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="truncate text-[10px] leading-none text-maestro-muted/50">
        {reset ? `↻ ${reset}` : " "}
      </div>
    </div>
  );
}
