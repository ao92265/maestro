import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { assembleBands, type BandItem } from "@/lib/bands";
import { useActStore } from "@/stores/useActStore";
import { useBandStore } from "@/stores/useBandStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** Collapse write bursts (a status change fans out through several stores). */
const DEBOUNCE_MS = 2000;

/**
 * Unchanged content still gets a write this often: writtenAt is the digest
 * script's app-alive signal (it stamps messages "app closed" past 15 min),
 * so a stable board must not stop the clock. 5 min keeps 3x headroom under
 * the script's threshold. Review round on caacd0b caught this: skipping ALL
 * unchanged writes falsely aged the snapshot in the feature's most common
 * path, since the needs-you ping itself requires 10 min of unchanged board.
 */
const HEARTBEAT_MS = 5 * 60 * 1000;

/** One band row, flattened to what a shell script can render in a message. */
interface SnapshotRow {
  kind: BandItem["kind"];
  label: string;
  detail: string;
}

function rowOf(item: BandItem): SnapshotRow {
  switch (item.kind) {
    case "session":
      return {
        kind: item.kind,
        label: `${item.projectName} (${item.session.status})`,
        detail: item.session.needsInputPrompt ?? item.session.statusMessage ?? "",
      };
    case "pr":
      return {
        kind: item.kind,
        label: `${item.projectName} PR #${item.pr.number}`,
        detail: item.pr.title,
      };
    case "run":
      return { kind: item.kind, label: `Factory: ${item.run.title}`, detail: item.run.stage ?? "" };
    case "handoff":
      return {
        kind: item.kind,
        label: `Parked: ${item.handoff.repo}`,
        detail: item.handoff.lastAction,
      };
  }
}

/** Exported for its test only; the hook below is the real consumer. */
export function buildSnapshot(): Record<string, unknown> {
  const sessions = useSessionStore.getState().sessions;
  const tabs = useWorkspaceStore.getState().tabs.map((t) => ({
    id: t.id,
    name: t.name,
    projectPath: t.projectPath,
    selectedRepoPath: t.selectedRepoPath,
  }));
  const band = useBandStore.getState();
  const act = useActStore.getState();
  const bands = assembleBands({
    sessions,
    tabs,
    handoffs: band.handoffs,
    repoPrs: band.repoPrs,
    gatedRuns: act.gatedRuns,
    watermarkMs: band.watermarkMs,
    /* Without this the Telegram digest keeps calling work "Parked" while a
       claude is live in its directory in iTerm, the exact false label the
       in-app bands stopped wearing in WP2. */
    activeDirs: band.externallyActiveDirs,
  });
  return {
    writtenAt: Date.now(),
    counts: bands.counts,
    blocked: bands.blocked.map(rowOf),
    landed: bands.landed.map(rowOf),
    runningCount: bands.running.length,
    moreHandoffs: bands.moreHandoffs,
    sources: {
      handoffsFetchedAt: band.handoffsFetchedAt,
      prsFetchedAt: band.prsFetchedAt,
      actFetchedAt: act.fetchedAt,
    },
  };
}

/**
 * Mirrors the assembled bands to a small state file on every change
 * (debounced), via the Rust `write_band_snapshot` command's atomic
 * write-then-rename. The launchd digest script reads that file — so the
 * Telegram feed keeps working from the last snapshot (marked stale by its
 * `writtenAt`) when the app is closed.
 */
export function useVanguardSnapshot(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The session store ticks on every status/output update, so without the
    // comparison the debounce floor becomes the ceiling: a serialize + IPC
    // hop every 2s for the app's whole life. writtenAt and the sources
    // timestamps are excluded from it so only band content triggers an
    // immediate write; the heartbeat above keeps the liveness clock moving
    // when content is stable. buildSnapshot itself still runs on every
    // debounced tick; accepted, it is sub-ms at real handoff counts.
    let lastWritten: string | null = null;
    let lastWrittenAt = 0;
    const write = () => {
      timer = null;
      const snapshot = buildSnapshot();
      const comparable = JSON.stringify(snapshot, (key, value) =>
        key === "writtenAt" || key === "sources" ? undefined : value,
      );
      if (comparable === lastWritten && Date.now() - lastWrittenAt < HEARTBEAT_MS) return;
      invoke("write_band_snapshot", { snapshot })
        .then(() => {
          lastWritten = comparable;
          lastWrittenAt = Date.now();
        })
        .catch((err) => console.error("Vanguard snapshot write failed:", err));
    };
    const schedule = () => {
      if (timer === null) timer = setTimeout(write, DEBOUNCE_MS);
    };
    const unsubs = [
      useSessionStore.subscribe(schedule),
      useBandStore.subscribe(schedule),
      useActStore.subscribe(schedule),
    ];
    schedule();
    // The stores can go silent (no sessions, nothing polling); without a
    // scheduled tick the heartbeat check would never even run.
    const heartbeat = setInterval(schedule, HEARTBEAT_MS);
    return () => {
      for (const unsub of unsubs) unsub();
      clearInterval(heartbeat);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
