import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { samePath } from "@/lib/path";
import type { SamuraiTestGateProgress } from "@/lib/samurai";

/**
 * Live launch test-gate state (issue #109): the latest
 * `samurai-test-gate-event` tick per (project, epic), plus when it arrived.
 *
 * This lives in a store — fed by a module-level subscription that outlives
 * any component — because the launch panel used to keep it in component
 * state: switching sidebar panels mid-gate unmounted the panel and silently
 * dropped the progress line, and a gate FAILURE landing while unmounted was
 * visible only in the audit log. With the store, a remount re-reads the
 * current step or the failure verdict.
 */

/** One project+epic's latest gate tick. */
export interface SamuraiGateEntry {
  progress: SamuraiTestGateProgress;
  /** `Date.now()` when the tick arrived — the elapsed display keeps
   *  counting between backend ticks (cargo test is one long step). */
  at: number;
}

type SamuraiGateState = {
  /** Latest tick per {@link gateKey} — one live gate per project+epic. */
  gates: Record<string, SamuraiGateEntry>;
  record: (progress: SamuraiTestGateProgress) => void;
  /** Drops every entry of one project — a fresh launch (or a consumed
   *  verdict) must not resurface a previous run's line. */
  clearProject: (project: string) => void;
};

/** `\u0000` never occurs in a path or an epic label, so the key is unambiguous. */
function gateKey(project: string, epic: string): string {
  return `${project}\u0000${epic}`;
}

export const useSamuraiGateStore = create<SamuraiGateState>((set) => ({
  gates: {},

  record: (progress) =>
    set((state) => ({
      gates: {
        ...state.gates,
        [gateKey(progress.project, progress.epic)]: { progress, at: Date.now() },
      },
    })),

  clearProject: (project) =>
    set((state) => ({
      gates: Object.fromEntries(
        Object.entries(state.gates).filter(
          ([, entry]) => !samePath(entry.progress.project, project),
        ),
      ),
    })),
}));

/**
 * The newest gate entry for one project, or null. Matched via `samePath`,
 * never `===` — the backend emits canonical spellings while the tab holds
 * the user's (the same rule every samurai channel follows).
 */
export function latestGateForProject(
  gates: Record<string, SamuraiGateEntry>,
  project: string,
): SamuraiGateEntry | null {
  let latest: SamuraiGateEntry | null = null;
  for (const entry of Object.values(gates)) {
    if (!samePath(entry.progress.project, project)) continue;
    if (latest === null || entry.at > latest.at) latest = entry;
  }
  return latest;
}

// Module-level event listener (the useActivityStore pattern) — but never
// stopped on unmount: gate ticks and the final verdict must keep landing in
// the store while the launch panel is closed (issue #109). Idempotent, so
// the panel can call it on every mount.
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

export async function initSamuraiGateListener(): Promise<void> {
  if (unlisten || starting) return;
  starting = listen<SamuraiTestGateProgress>("samurai-test-gate-event", (event) => {
    useSamuraiGateStore.getState().record(event.payload);
  })
    .then((fn) => {
      unlisten = fn;
    })
    .catch(() => {
      // Event system unavailable (tests) — the launch still resolves.
    })
    .finally(() => {
      starting = null;
    });
  await starting;
}

/** Test-only in practice: detaches the module listener so each test file
 *  run re-captures a fresh handler. Production never stops it. */
export function stopSamuraiGateListener(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
