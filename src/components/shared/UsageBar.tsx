import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useUsageStore } from "@/stores/useUsageStore";
import { formatResetTime, getUsageBars, type UsageWindowBar } from "@/lib/usageParser";

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
 * Footer usage display: every window the API reported, laid out inline — one
 * mini bar per window with its percent and reset time always visible, no
 * drop-up to open.
 */
export function UsageBar() {
  const { usage, needsAuth, error, isLoading, fetchUsage, startPolling } = useUsageStore();

  useEffect(() => startPolling(), [startPolling]);

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

  return (
    <div className="flex min-w-0 items-center gap-2">
      <RefreshButton onClick={() => fetchUsage(true)} spinning={isLoading} />
      <div className="flex min-w-0 items-center gap-3">
        {bars.map((bar) => (
          <Bar key={bar.label} bar={bar} />
        ))}
      </div>
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

/** One window inline: name + percent (+dollars) above its bar, reset below. */
function Bar({ bar }: { bar: UsageWindowBar }) {
  const pct = clampPercent(bar.percent);
  const reset = formatResetTime(bar.resetsAt);
  return (
    <div className="flex w-28 min-w-0 shrink flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-1 text-[11px] leading-none">
        <span className="shrink-0 whitespace-nowrap text-maestro-muted/70">{bar.label}</span>
        {/* Truncates rather than nowraps: the budget window's detail
            ("$857 / $1000") is wider than the bar's own box. */}
        <span className="min-w-0 truncate text-maestro-muted/60">
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
        {reset ? `↻ ${reset}` : " "}
      </div>
    </div>
  );
}
