import { Play } from "lucide-react";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import { useActEngineStore } from "@/stores/useActEngineStore";

/**
 * The Factory lane's liveness chip, and the only place in the app that can
 * start ACT.
 *
 * It reports the engine and the runs feed separately on purpose. The old badge
 * derived OFFLINE from "no successful runs fetch yet", which read the same
 * whether ACT was absent, still booting, or up but quiet, and offered nothing
 * to do about any of them.
 */

interface EngineBadgeProps {
  /** When the runs list last came back; 0 means never. */
  runsFetchedAt: number;
  /** The runs feed has gone quiet or errored, while the engine is still up. */
  stale: boolean;
}

export function EngineBadge({ runsFetchedAt, stale }: EngineBadgeProps) {
  const { status, starting, error, start } = useActEngineStore();
  const engine = status?.state ?? (runsFetchedAt > 0 ? "live" : "notRunning");
  const isStarting = starting || engine === "starting";

  const label = isStarting
    ? "ACT STARTING"
    : engine === "notRunning"
      ? "ACT OFFLINE"
      : stale
        ? "ACT STALE"
        : "ACT LIVE";

  const tone = isStarting
    ? "bg-maestro-accent/15 text-maestro-accent"
    : engine === "notRunning"
      ? "bg-maestro-muted/15 text-maestro-muted"
      : stale
        ? "bg-maestro-yellow/15 text-maestro-yellow"
        : "bg-maestro-green/15 text-maestro-green";

  return (
    <>
      <span className={`${badgeBaseClass} ${tone}`} title={status?.detail ?? undefined}>
        {label}
      </span>

      {engine === "notRunning" && !isStarting && (
        <button
          type="button"
          onClick={() => void start()}
          className="flex items-center gap-1 rounded border border-maestro-border px-1.5 py-0.5 text-[10px] text-maestro-text transition-colors hover:border-maestro-green/50"
          title={status?.directory ? `Start ACT from ${status.directory}` : "Start ACT"}
        >
          <Play size={9} /> Start ACT
        </button>
      )}

      {error && (
        <span className="truncate text-[10px] text-red-400" title={error}>
          {error}
        </span>
      )}
    </>
  );
}
