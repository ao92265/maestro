import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { assembleBands, type BandItem } from "@/lib/bands";
import { useActStore } from "@/stores/useActStore";
import { useBandStore } from "@/stores/useBandStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** Collapse write bursts (a status change fans out through several stores). */
const DEBOUNCE_MS = 2000;

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

function buildSnapshot(): Record<string, unknown> {
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
    // The session store ticks on every status/output update, so without this
    // the debounce floor becomes the ceiling: a rebuild + serialize + IPC hop
    // every 2s for the app's whole life. Only writtenAt would differ in most
    // of those writes, and the digest script doesn't need a fresher clock
    // than the data it timestamps.
    let lastWritten: string | null = null;
    const write = () => {
      timer = null;
      const snapshot = buildSnapshot();
      const comparable = JSON.stringify(snapshot, (key, value) =>
        key === "writtenAt" ? undefined : value,
      );
      if (comparable === lastWritten) return;
      invoke("write_band_snapshot", { snapshot })
        .then(() => {
          lastWritten = comparable;
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
    return () => {
      for (const unsub of unsubs) unsub();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
