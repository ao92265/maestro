import { create } from "zustand";
import {
  type ClosedBatch,
  type ClosedSessionRecord,
  pruneClosedBatches,
  recordClosedBatch,
} from "@/lib/sessionActions";
import type { BackendSessionRow } from "@/stores/useSessionStore";

/**
 * The undo record behind "reopen a closed batch".
 *
 * Closing a project tab kills every session under it in one go
 * (`removeSessionsForProject`), and until now nothing remembered that it
 * happened — a mis-clicked tab close was unrecoverable. This store keeps the
 * last few batches for {@link CLOSED_BATCH_RETENTION_MS} so the shelf can
 * offer them back.
 *
 * In-memory only, deliberately. The PTYs died with the tab, so a "restore"
 * relaunches fresh sessions in the recorded directories — it cannot resurrect
 * the running work, and the ids it records are reassigned on the next app
 * launch anyway (the same constraint that keeps `parkedSessionIds` in memory).
 * Persisting would promise a recovery the mechanism cannot deliver.
 */

/** Disambiguates two tabs closed in the same millisecond. */
let batchSeq = 0;

function toRecord(row: BackendSessionRow, projectPath: string): ClosedSessionRecord {
  return {
    id: row.id,
    name: row.name ?? null,
    mode: row.mode,
    projectPath: row.project_path,
    // Same fallback chain as `bands.ts`'s `sessionDir`.
    workingDirectory: row.working_directory ?? row.worktree_path ?? row.project_path ?? projectPath,
    branch: row.branch,
  };
}

interface RecordInput {
  projectPath: string;
  projectName: string;
  sessions: BackendSessionRow[];
}

interface ClosedSessionsState {
  batches: ClosedBatch[];
  /** Remember a batch of sessions closed together. A close that removed nothing is not news. */
  record: (input: RecordInput) => void;
  /** Dismiss a shelf entry without reopening it. */
  forget: (batchId: string) => void;
  /** Drop batches past the retention window. Callers drive the interval. */
  prune: () => void;
}

export const useClosedSessionsStore = create<ClosedSessionsState>((set, get) => ({
  batches: [],

  record: ({ projectPath, projectName, sessions }) => {
    if (sessions.length === 0) return;
    const now = Date.now();
    batchSeq += 1;
    const batch: ClosedBatch = {
      id: `closed-${now}-${batchSeq}`,
      closedAtMs: now,
      projectPath,
      projectName,
      sessions: sessions.map((s) => toRecord(s, projectPath)),
    };
    set({ batches: recordClosedBatch(get().batches, batch, now) });
  },

  forget: (batchId) => {
    set({ batches: get().batches.filter((b) => b.id !== batchId) });
  },

  prune: () => {
    const batches = pruneClosedBatches(get().batches, Date.now());
    if (batches.length === get().batches.length) return;
    set({ batches });
  },
}));
