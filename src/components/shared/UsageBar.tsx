import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useUsageStore } from "@/stores/useUsageStore";
import { formatResetTime, getUsageBars } from "@/lib/usageParser";

function barColor(percent: number): string {
  if (percent < 50) return "bg-maestro-green";
  if (percent <= 70) return "bg-maestro-yellow";
  return "bg-maestro-red";
}

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

  const tooltip = [
    ...bars.map(
      (b) => `${b.label}: ${Math.round(b.percent)}% (resets ${formatResetTime(b.resetsAt) || "—"})`,
    ),
    ...(usage.weeklyOpusPercent !== null
      ? [`Weekly Opus: ${Math.round(usage.weeklyOpusPercent)}%`]
      : []),
  ].join("\n");

  return (
    <div className="flex items-center gap-2" title={tooltip}>
      <RefreshButton onClick={() => fetchUsage(true)} spinning={isLoading} />
      <div className="flex items-center gap-3">
        {bars.map((b) => (
          <Bar key={b.label} label={b.label} percent={b.percent} reset={formatResetTime(b.resetsAt)} />
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

function Bar({ label, percent, reset }: { label: string; percent: number; reset: string }) {
  // Guard NaN/Infinity (Math.min/max alone propagate NaN) → default to 0, then clamp to [0,100].
  const pct = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return (
    <div className="flex flex-col gap-1 w-28">
      <div className="flex items-baseline justify-between gap-1 text-[11px] leading-none">
        <span className="text-maestro-muted/70">{label}</span>
        <span className="text-maestro-muted/60">{Math.round(pct)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-maestro-border/50">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] leading-none text-maestro-muted/50 truncate">
        {reset ? `↻ ${reset}` : " "}
      </div>
    </div>
  );
}
