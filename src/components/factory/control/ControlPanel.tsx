import { EyeOff } from "lucide-react";
import { useEffect } from "react";
import { engineOffline, lastReadAt, unreadableSubsystems } from "@/lib/actControl";
import { useActControlStore } from "@/stores/useActControlStore";
import { ACT_STALE_MS } from "@/stores/useActStore";
import { useNightRunStore } from "@/stores/useNightRunStore";
import { AutonomyLadder } from "./AutonomyLadder";
import { GuardrailFeed } from "./GuardrailFeed";
import { IntakeLedger } from "./IntakeLedger";
import { NightRuns } from "./NightRuns";
import { relAgo } from "./primitives";
import { ReplayTimeline } from "./ReplayTimeline";
import { SpendPanel } from "./SpendPanel";

/** Matches the Factory run list's cadence, so both tabs age together. */
const POLL_INTERVAL_MS = 30 * 1000;

/**
 * The ACT control panel: what the engine is allowed to do (the autonomy
 * ladder), what stops it (guardrails and their intervention feed), what it
 * costs (token spend), what it took in and shipped (the intake ledger), and
 * what it did step by step (session replay).
 *
 * Six independent ACT endpoints back this. Any of them can be down without
 * taking the panel with it — the ones that answered still render, and the ones
 * that did not are named in the unreadable-subsystem strip.
 */
export function ControlPanel() {
  const refreshAll = useActControlStore((state) => state.refreshAll);
  const refreshNightRun = useNightRunStore((state) => state.refresh);
  const policy = useActControlStore((state) => state.policy);
  const rules = useActControlStore((state) => state.rules);
  const events = useActControlStore((state) => state.events);
  const budget = useActControlStore((state) => state.budget);
  const ledger = useActControlStore((state) => state.ledger);
  const ledgerTotal = useActControlStore((state) => state.ledgerTotal);
  const replays = useActControlStore((state) => state.replays);
  const reads = useActControlStore((state) => state.reads);

  useEffect(() => {
    /* One timer for the whole tab. The night-run schedule keeps its own clock
       in Rust, so this poll only refreshes what is on screen. */
    const poll = () => {
      void refreshAll();
      void refreshNightRun();
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll, refreshNightRun]);

  const unreadable = unreadableSubsystems(reads);
  const offline = engineOffline(reads);
  const readAt = lastReadAt(reads);
  /* A read that landed but has since gone quiet: the rows below are last
     known, not current. Same 90s threshold as the run list's badge. */
  const stale = readAt > 0 && (unreadable.length > 0 || Date.now() - readAt > ACT_STALE_MS);

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {offline && (
        /* ACT not running is a NORMAL state — one line, matching the Runs
           tab, rather than a connection error per subsystem. */
        <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
          ACT is not running. The panel fills itself as soon as the engine answers.
        </p>
      )}

      {stale && (
        <p className="flex items-center gap-1.5 text-[10px] text-maestro-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-maestro-yellow" />
          Showing the last good read
          {readAt > 0 && ` from ${relAgo(new Date(readAt).toISOString())}`}.
        </p>
      )}

      {unreadable.length > 0 && (
        /* Named, not hidden: a subsystem the panel cannot read is a fact about
           the engine worth seeing, and ACT records no such flag itself. */
        <div className="flex flex-col gap-1 rounded border border-maestro-yellow/40 bg-maestro-yellow/5 p-2">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-maestro-yellow">
            <EyeOff size={11} />
            {unreadable.length} subsystem{unreadable.length === 1 ? "" : "s"} unreadable
          </span>
          {unreadable.map((flag) => (
            <span key={flag.key} className="text-[10px] text-maestro-muted">
              <span className="text-maestro-text">{flag.label}</span> — {flag.reason}
            </span>
          ))}
        </div>
      )}

      <NightRuns />

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <div className="flex flex-col gap-2">
          <AutonomyLadder policy={policy} />
          <SpendPanel budget={budget} />
          <GuardrailFeed rules={rules} events={events} />
        </div>
        <div className="flex flex-col gap-2">
          <IntakeLedger ledger={ledger} total={ledgerTotal} />
          <ReplayTimeline replays={replays} />
        </div>
      </div>
    </div>
  );
}
