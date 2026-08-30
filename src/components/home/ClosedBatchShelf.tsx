import { RotateCcw, X } from "lucide-react";
import { CLOSED_BATCH_RETENTION_MS } from "@/lib/sessionActions";
import { useClosedSessionsStore } from "@/stores/useClosedSessionsStore";

const RETENTION_MINUTES = Math.round(CLOSED_BATCH_RETENTION_MS / 60000);

/**
 * Undo strip for sessions closed in a batch — a closed project tab, or Stop
 * all.
 *
 * Says plainly what reopening does and does not do. The PTYs died with the
 * tab, so this relaunches fresh CLIs in the same directories; it cannot pick
 * the conversations back up. The record is in-memory, so it also empties on
 * an app restart, and a shelf that quietly lost entries would read as a bug.
 */
export function ClosedBatchShelf({ onRestore }: { onRestore: (batchId: string) => void }) {
  const batches = useClosedSessionsStore((s) => s.batches);
  const forget = useClosedSessionsStore((s) => s.forget);

  if (batches.length === 0) return null;

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5">
        <RotateCcw size={12} className="text-maestro-muted" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          Recently closed
        </h2>
        <span className="text-[11px] text-maestro-muted/70">{batches.length}</span>
        <div className="flex-1" />
        <span className="text-[10px] text-maestro-muted/70">
          Kept {RETENTION_MINUTES} min, and until the app restarts
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {batches.map((batch) => (
          <div
            key={batch.id}
            className="flex w-full items-center gap-2 rounded border border-maestro-border bg-maestro-card px-3 py-2 text-left"
          >
            <span className="shrink-0 text-[12px] font-medium text-maestro-text">
              {batch.projectName}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-muted">
              {batch.sessions.length} session{batch.sessions.length === 1 ? "" : "s"} closed
            </span>
            <button
              type="button"
              onClick={() => onRestore(batch.id)}
              className="flex shrink-0 items-center gap-1 rounded border border-maestro-border px-1.5 py-0.5 text-[11px] text-maestro-muted transition-colors hover:border-maestro-green/50 hover:text-maestro-green"
              title="Reopens the project and starts fresh sessions in the same directories — it does not resume the runs, which ended when they were closed"
            >
              <RotateCcw size={11} /> Reopen
            </button>
            <button
              type="button"
              onClick={() => forget(batch.id)}
              className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:text-maestro-text"
              aria-label={`Dismiss the ${batch.projectName} close`}
              title="Drop this from the shelf without reopening"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
