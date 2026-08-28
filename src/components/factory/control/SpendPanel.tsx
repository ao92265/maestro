import { type ActBudget, budgetHeadroom } from "@/lib/actControl";
import { compactNumber, EmptyLine, PanelSection } from "./primitives";

/** Spend bars go amber then red as the allowance runs out. */
function barTone(percent: number): string {
  if (percent >= 90) return "bg-maestro-red";
  if (percent >= 70) return "bg-maestro-orange";
  return "bg-maestro-accent";
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-maestro-text">{label}</span>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-maestro-muted">{detail}</span>
        <span className="w-9 text-right font-mono text-[11px] text-maestro-text">
          {Math.round(percent)}%
        </span>
      </div>
      {/* Decorative: the label, the raw figures and the percentage are all
          already text above, so the bar adds emphasis rather than meaning. */}
      <div className="h-1.5 overflow-hidden rounded-full bg-maestro-border" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-all ${barTone(percent)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

/** Token and cost spend against ACT's own daily and weekly ceilings. */
export function SpendPanel({ budget }: { budget: ActBudget | null }) {
  if (!budget) {
    return (
      <PanelSection title="Token spend">
        <EmptyLine>No budget read yet.</EmptyLine>
      </PanelSection>
    );
  }

  const daily = budgetHeadroom(budget);
  const dailyCostTotal = budget.dailyCostUsed + budget.dailyCostRemaining;

  return (
    <PanelSection
      title="Token spend"
      hint={budget.lastResetDate ? `since ${budget.lastResetDate}` : undefined}
      action={
        budget.isOverBudget ? (
          <span className="rounded bg-maestro-red/15 px-1.5 py-px text-[10px] font-bold text-maestro-red">
            OVER BUDGET
          </span>
        ) : null
      }
    >
      {daily === null ? (
        /* ACT reports no daily allowance at all — an uncapped engine, which
           is a real configuration and not a read failure. */
        <p className="text-[11px] text-maestro-muted">
          No daily token cap configured. {compactNumber(budget.dailyTokensUsed)} tokens used today.
        </p>
      ) : (
        <Meter
          label="Daily tokens"
          percent={daily}
          detail={`${compactNumber(budget.dailyTokensUsed)} / ${compactNumber(
            budget.dailyTokensUsed + budget.dailyTokensRemaining,
          )}`}
        />
      )}

      {budget.weeklyTokensLimit > 0 && (
        <Meter
          label="Weekly tokens"
          percent={budget.weeklyUsagePercent}
          detail={`${compactNumber(budget.weeklyTokensUsed)} / ${compactNumber(
            budget.weeklyTokensLimit,
          )}`}
        />
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-maestro-border pt-2 text-[11px]">
        <span className="text-maestro-muted">
          Cost today{" "}
          <span className="font-mono text-maestro-text">${budget.dailyCostUsed.toFixed(2)}</span>
          {dailyCostTotal > 0 && (
            <span className="text-maestro-muted/70"> of ${dailyCostTotal.toFixed(2)}</span>
          )}
        </span>
        {budget.cacheTokensUsed !== null && (
          <span
            className="text-maestro-muted"
            title="Tracked separately by ACT and excluded from its token-limit checks"
          >
            Cache{" "}
            <span className="font-mono text-maestro-text">
              {compactNumber(budget.cacheTokensUsed)}
            </span>
          </span>
        )}
      </div>
    </PanelSection>
  );
}
