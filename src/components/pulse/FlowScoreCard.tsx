import { Flame } from "lucide-react";
import { EMPTY_CELL_FILL, TIER_FILL, TIER_TEXT } from "@/components/pulse/pulsePresentation";
import type { FlowScore } from "@/lib/pulse";

/**
 * The flow score, and every number it was built from.
 *
 * The factor rows are the point of this card: a score with no legible basis is
 * a number to argue with rather than act on, so each factor shows its own
 * percentage, the counts behind it, and how much of the total it carries.
 */
export function FlowScoreCard({ flow }: { flow: FlowScore }) {
  const deltaClass =
    flow.deltaDirection === "up"
      ? "text-maestro-green"
      : flow.deltaDirection === "down"
        ? "text-maestro-yellow"
        : "text-maestro-muted";

  return (
    <section className="rounded border border-maestro-border bg-maestro-card p-3">
      <div className="flex items-baseline gap-3">
        <span className={`font-mono text-[34px] leading-none ${TIER_TEXT[flow.tier]}`}>
          {flow.score}
        </span>
        <div className="min-w-0">
          <div className={`text-[13px] font-semibold ${TIER_TEXT[flow.tier]}`}>{flow.word}</div>
          <div className={`text-[11px] ${deltaClass}`}>{flow.delta}</div>
        </div>
        <div className="flex-1" />
        {flow.streak > 0 && (
          <span
            className="flex items-center gap-1 text-[11px] text-maestro-muted"
            title="Consecutive days with a score"
          >
            <Flame size={12} />
            {flow.streak}d
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1.5">
        {flow.factors.map((factor) => (
          <li key={factor.label}>
            <div className="flex items-baseline gap-2 text-[11px]">
              <span className={`w-3 ${TIER_TEXT[factor.tier]}`}>{factor.sign}</span>
              <span className="w-24 shrink-0 text-maestro-text">{factor.label}</span>
              <span className="truncate text-maestro-muted">{factor.detail}</span>
              <div className="flex-1" />
              <span className="shrink-0 font-mono text-maestro-muted">
                {factor.pct}% · {Math.round(factor.weight * 100)}% wt
              </span>
            </div>
            <div className="mt-0.5 ml-5 h-1 overflow-hidden rounded bg-maestro-bg">
              <div
                className={`h-full ${TIER_FILL[factor.tier]}`}
                style={{ width: `${factor.pct}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 ml-5 text-[10px] text-maestro-muted">{flow.explain}</p>

      <div className="mt-3 border-t border-maestro-border pt-3">
        <div className="flex items-end gap-1" role="img" aria-label="Flow score, last 7 days">
          {flow.trend.map((bar) => (
            <div
              key={bar.date}
              className="flex h-10 flex-1 items-end"
              title={`${bar.date} · ${bar.score}`}
            >
              <div
                className={`w-full rounded-t ${TIER_FILL[bar.tier]}`}
                style={{ height: `${Math.max(bar.heightPct, 3)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-maestro-muted">
          <span>Last 7 days</span>
          <span>
            {flow.wkActive} active · avg {flow.wkAvg} · best {flow.wkBest}
          </span>
        </div>
      </div>

      <div className="mt-3 flex gap-1" role="img" aria-label="Flow score, last 14 days">
        {flow.heat.map((cell) => (
          <div
            key={cell.date}
            title={cell.title}
            className={`h-3 flex-1 rounded-sm ${cell.tier ? TIER_FILL[cell.tier] : EMPTY_CELL_FILL} ${
              cell.ring ? "ring-1 ring-maestro-accent" : ""
            }`}
          />
        ))}
      </div>

      <p className="mt-3 text-[11px] text-maestro-text">{flow.insight}</p>
    </section>
  );
}
