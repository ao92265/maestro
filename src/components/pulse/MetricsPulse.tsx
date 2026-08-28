import type { PulseMetrics, PulseSpark } from "@/lib/pulse";

/**
 * The day in numbers: what shipped, what was touched, what the agents did,
 * and what is still waiting on you — with an hour-by-hour sparkline over it.
 */

/** Tool calls per hour, with the hours something landed marked underneath. */
function Sparkline({ spark }: { spark: PulseSpark }) {
  const peak = Math.max(...spark.activity, 1);
  return (
    <div className="flex items-end gap-1" role="img" aria-label="Tool calls by hour">
      {spark.hours.map((label, index) => (
        <div key={label} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex h-12 w-full items-end">
            <div
              className="w-full rounded-t bg-maestro-blue/60"
              style={{ height: `${Math.max((spark.activity[index] / peak) * 100, 2)}%` }}
              title={`${label} · ${spark.activity[index]} tool calls, ${spark.commits[index]} commits`}
            />
          </div>
          <span
            className="h-1 w-full rounded-full bg-maestro-green"
            style={{ opacity: spark.commits[index] > 0 ? 1 : 0 }}
          />
          <span className="text-[9px] text-maestro-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}

function Headline({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded border border-maestro-border bg-maestro-bg px-2 py-1.5">
      <div className="font-mono text-[18px] leading-none text-maestro-text">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-maestro-muted">{label}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="text-maestro-muted">{label}</span>
      <span className="flex-1 border-b border-dotted border-maestro-border" />
      <span className="font-mono text-maestro-text">{value}</span>
    </div>
  );
}

export function MetricsPulse({ metrics }: { metrics: PulseMetrics }) {
  const { headline, shipped, touched, activity, focus, attention } = metrics;
  const nothingYet = shipped.commits === 0 && activity.toolCalls === 0 && shipped.prsOpened === 0;

  return (
    <section className="rounded border border-maestro-border bg-maestro-card p-3">
      <div className="grid grid-cols-4 gap-2">
        <Headline value={headline.commits} label="commits" />
        <Headline value={headline.prs} label="PRs" />
        <Headline value={headline.repos} label="repos" />
        <Headline value={headline.waiting} label="waiting" />
      </div>

      {nothingYet ? (
        <p className="mt-3 text-[11px] text-maestro-muted">{metrics.empty}</p>
      ) : (
        <div className="mt-3">
          <Sparkline spark={metrics.spark} />
        </div>
      )}

      <div className="mt-3 grid gap-x-6 gap-y-1 border-t border-maestro-border pt-3 sm:grid-cols-2">
        <Row
          label="Shipped"
          value={`${shipped.commits} commits · ${shipped.prsOpened} opened · ${shipped.prsMerged} merged`}
        />
        <Row
          label="Touched"
          value={`${touched.files} files · +${touched.added} / −${touched.removed}`}
        />
        <Row
          label="Agent work"
          value={`${activity.edits} edits · ${activity.toolCalls} tool calls`}
        />
        <Row
          label="Tests"
          value={
            activity.testRuns === 0
              ? "none run"
              : `${activity.testRuns} runs · ${activity.testsPass} passed · ${activity.testsFail} failed`
          }
        />
        <Row
          label="Focus"
          value={`${focus.active} live · ${focus.repos} repos · ${focus.switches} switches`}
        />
        <Row
          label="Attention"
          value={`${attention.waiting} waiting · ${attention.dirtyTrees} dirty trees`}
        />
      </div>
    </section>
  );
}
