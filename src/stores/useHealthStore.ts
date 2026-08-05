import { create } from "zustand";
import {
  diffNewFlags,
  evaluateMemory,
  evaluateProcesses,
  extractPathRefs,
  type HealthArea,
  type HealthFlag,
  type ProcessStreaks,
} from "@/lib/healthRules";
import {
  checkPathsExist,
  encodeProjectDirName,
  listMemoryFiles,
  listMemoryProjects,
  readMemoryFile,
  type MemoryFile,
} from "@/lib/memory";
import { listDevProcesses } from "@/lib/processes";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useProcessWatchlistStore } from "@/stores/useProcessWatchlistStore";

/**
 * Background health checker: pure rules over data Maestro already fetches,
 * run every few minutes. It raises attention badges and one-line reasons; it
 * never deletes a memory file and never kills a process.
 *
 * Follows the GitHub watchdog's shape — a reducer over samples, transition-only
 * toasts, first-run suppression — but polls from the frontend rather than a
 * Rust task, because every input except one path-existence probe is already a
 * frontend command.
 */

/** A queued toast for a newly-raised flag. */
export interface HealthToast {
  id: string;
  area: HealthArea;
  target: string;
  reason: string;
}

/** Keep at most this many queued toasts; oldest are dropped first. */
const MAX_TOASTS = 6;

/**
 * Memory files whose body is read for path references, per project. Bounds
 * the IPC cost of one check; projects with more facts get their oldest-sorted
 * tail skipped rather than the whole rule being abandoned.
 */
const MAX_FILES_SCANNED_PER_PROJECT = 60;

type HealthState = {
  flags: HealthFlag[];
  /** Consecutive-sample counters, carried between process samples. */
  streaks: ProcessStreaks;
  /**
   * Last known flag keys per area, or `null` while that area has never
   * completed a check — the first-run suppression that stops app start from
   * toasting every pre-existing problem.
   */
  baselineKeys: Record<HealthArea, string[] | null>;
  toasts: HealthToast[];
  lastCheckedAt: number | null;
  isChecking: boolean;
};

type HealthActions = {
  /**
   * Runs one full check. `projects` are the repos open in Maestro — only
   * those can have their memory path references verified, since a memory
   * directory name cannot be decoded back into a filesystem path.
   */
  runCheck: (projects: Array<{ projectPath: string }>) => Promise<void>;
  dismissToast: (id: string) => void;
  /** Clears the queue outright — used when notifications are switched off. */
  dismissAllToasts: () => void;
};

let toastSeq = 0;

/** Per-project memory scan; throws so the caller can keep the last-known flags. */
async function checkMemory(
  repoByDirName: Map<string, string>,
  now: number,
): Promise<HealthFlag[]> {
  const projects = await listMemoryProjects("");
  const flags: HealthFlag[] = [];

  for (const project of projects) {
    const files = await listMemoryFiles(project.dirName);
    const repoPath = repoByDirName.get(project.dirName);
    const missingRefs = repoPath
      ? await missingPathRefs(project.dirName, files, repoPath)
      : undefined;
    flags.push(...evaluateMemory({ dirName: project.dirName, files, missingRefs, now }));
  }
  return flags;
}

/**
 * Reads each memory file, extracts its backtick-quoted repo-relative path
 * references and returns, per file, the ones that no longer exist in the repo.
 * One existence probe per project rather than per file.
 */
async function missingPathRefs(
  dirName: string,
  files: MemoryFile[],
  repoPath: string,
): Promise<Record<string, string[]>> {
  const refsByFile = new Map<string, string[]>();
  const allRefs = new Set<string>();

  for (const file of files.slice(0, MAX_FILES_SCANNED_PER_PROJECT)) {
    const body = await readMemoryFile(dirName, file.relPath).catch(() => "");
    const refs = extractPathRefs(body);
    if (refs.length === 0) continue;
    refsByFile.set(file.relPath, refs);
    for (const ref of refs) allRefs.add(ref);
  }
  if (allRefs.size === 0) return {};

  const missing = new Set(await checkPathsExist(repoPath, [...allRefs]));
  const result: Record<string, string[]> = {};
  for (const [relPath, refs] of refsByFile) {
    const gone = refs.filter((ref) => missing.has(ref));
    if (gone.length > 0) result[relPath] = gone;
  }
  return result;
}

export const useHealthStore = create<HealthState & HealthActions>()((set, get) => ({
  flags: [],
  streaks: {},
  baselineKeys: { memory: null, processes: null },
  toasts: [],
  lastCheckedAt: null,
  isChecking: false,

  runCheck: async (projects) => {
    if (get().isChecking) return;
    set({ isChecking: true });
    try {
      const now = Date.now();
      const repoByDirName = new Map(
        projects
          .filter((p) => p.projectPath)
          .map((p) => [encodeProjectDirName(p.projectPath), p.projectPath] as const),
      );

      const { flags: prevFlags, streaks: prevStreaks, baselineKeys, toasts } = get();

      // Areas are checked independently: a failing one keeps its last-known
      // flags and its baseline, so a transient error neither clears the badge
      // nor re-toasts everything on recovery.
      const memoryFlags = await checkMemory(repoByDirName, now).catch((err) => {
        console.error("Health check (memory) failed:", err);
        return null;
      });

      const watchlist = useProcessWatchlistStore.getState().watchlist;
      const processResult = await listDevProcesses(watchlist)
        .then((processes) => evaluateProcesses(processes, prevStreaks))
        .catch((err) => {
          console.error("Health check (processes) failed:", err);
          return null;
        });

      const nextBaseline = { ...baselineKeys };
      const newFlags: HealthFlag[] = [];
      const areas: Array<[HealthArea, HealthFlag[] | null]> = [
        ["memory", memoryFlags],
        ["processes", processResult?.flags ?? null],
      ];
      for (const [area, areaFlags] of areas) {
        if (areaFlags === null) continue;
        newFlags.push(...diffNewFlags(baselineKeys[area], areaFlags));
        nextBaseline[area] = areaFlags.map((f) => f.key);
      }

      const keep = (area: HealthArea) => prevFlags.filter((f) => f.area === area);
      const flags = [
        ...(memoryFlags ?? keep("memory")),
        ...(processResult?.flags ?? keep("processes")),
      ];

      const notificationsEnabled = useGitHubWatchdogStore.getState().notificationsEnabled;
      const queued: HealthToast[] = notificationsEnabled
        ? newFlags.map((flag) => ({
            id: `health-${++toastSeq}`,
            area: flag.area,
            target: flag.target,
            reason: flag.reason,
          }))
        : [];

      set({
        flags,
        streaks: processResult?.streaks ?? prevStreaks,
        baselineKeys: nextBaseline,
        toasts: [...toasts, ...queued].slice(-MAX_TOASTS),
        lastCheckedAt: now,
      });
    } finally {
      set({ isChecking: false });
    }
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  dismissAllToasts: () => set({ toasts: [] }),
}));

/**
 * Reasons for one area, keyed `scope|target` — the identity a section row can
 * reconstruct (memory: `dirName|relPath`; processes: `pid:name|matched`).
 * Rows carry one line per reason.
 */
export function reasonsByRow(flags: HealthFlag[], area: HealthArea): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const flag of flags) {
    if (flag.area !== area) continue;
    const rowKey = `${flag.scope}|${flag.target}`;
    const list = map.get(rowKey);
    if (list) {
      list.push(flag.reason);
    } else {
      map.set(rowKey, [flag.reason]);
    }
  }
  return map;
}

/** Number of flags raised in one area — drives the attention badge count. */
export function countForArea(flags: HealthFlag[], area: HealthArea): number {
  return flags.reduce((n, f) => (f.area === area ? n + 1 : n), 0);
}
