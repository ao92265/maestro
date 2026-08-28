import { EyeOff } from "lucide-react";
import { useEffect } from "react";
import { unreadableSubsystems } from "@/lib/actControl";
import { useActControlStore } from "@/stores/useActControlStore";
import { AutonomyLadder } from "./AutonomyLadder";
import { GuardrailFeed } from "./GuardrailFeed";
import { IntakeLedger } from "./IntakeLedger";
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
  const policy = useActControlStore((state) => state.policy);
  const rules = useActControlStore((state) => state.rules);
  const events = useActControlStore((state) => state.events);
  const budget = useActControlStore((state) => state.budget);
  const ledger = useActControlStore((state) => state.ledger);
  const replays = useActControlStore((state) => state.replays);
  const reads = useActControlStore((state) => state.reads);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => void refreshAll(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  const unreadable = unreadableSubsystems(reads);

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
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

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <div className="flex flex-col gap-2">
          <AutonomyLadder policy={policy} />
          <SpendPanel budget={budget} />
          <GuardrailFeed rules={rules} events={events} />
        </div>
        <div className="flex flex-col gap-2">
          <IntakeLedger ledger={ledger} />
          <ReplayTimeline replays={replays} />
        </div>
      </div>
    </div>
  );
}
