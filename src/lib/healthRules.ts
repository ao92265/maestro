/**
 * Rule-based health checks for project memory files and watched processes.
 *
 * Pure rules — no AI, no network, no side effects. Everything here is a
 * function of data Maestro already fetches (`lib/memory.ts`, `lib/processes.ts`)
 * plus a batch path-existence probe (`check_paths_exist`). The checker never
 * deletes a file or kills a process; it only produces {@link HealthFlag}s that
 * the UI renders as an attention badge plus a one-line reason.
 *
 * Design bias: **false positives are worse than misses.** Every rule below
 * errs towards staying silent when the data is ambiguous.
 */

import type { MemoryFile } from "@/lib/memory";
import type { DevProcess } from "@/lib/processes";

/* ================================================================ */
/*  THRESHOLDS — the single place to tune the checker                */
/* ================================================================ */

/**
 * Every threshold the health rules use. Deliberately gathered in one object
 * so tuning never means grepping the codebase.
 */
export const HEALTH_THRESHOLDS = {
  /**
   * A project's memory is "sprawling" above this many fact files (the
   * MEMORY.md index does not count). Claude loads the index every session,
   * so a very long fact list is a sign it wants pruning.
   */
  maxFactFiles: 30,

  /**
   * MEMORY.md is loaded into context on every single session, so its size is
   * a direct, recurring token cost. 8 KB ~= 2k tokens of pure index.
   */
  maxIndexBytes: 8 * 1024,

  /**
   * A fact file untouched for this long is likely describing a state of the
   * repo that no longer holds. 6 months, in days.
   */
  staleFactDays: 183,

  /**
   * Sustained CPU share of the whole machine (`DevProcess.cpuPercent` is
   * already normalized 0-100 across all cores).
   */
  cpuPercent: 80,

  /** Resident memory of a single watched process. 2 GB. */
  memoryBytes: 2 * 1024 * 1024 * 1024,

  /**
   * How many CONSECUTIVE health samples a process must exceed the CPU/RAM
   * threshold before it is flagged. Three samples at the checker's interval
   * is minutes of sustained load, not a build-step spike.
   */
  consecutiveSamples: 3,

  /**
   * A watched process running longer than this is probably a forgotten dev
   * server rather than something actively in use. 24 hours, in seconds.
   */
  runTimeSecs: 24 * 60 * 60,

  /**
   * Upper bound on path references extracted from one memory file. Guards a
   * pathological file from turning one check into thousands of stat calls.
   */
  maxPathRefsPerFile: 40,
} as const;

/** How often the background checker runs. Quiet by design — this is not a monitor. */
export const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000;

/* ================================================================ */
/*  FLAGS                                                            */
/* ================================================================ */

/** Which section a flag belongs to — drives which badge lights up. */
export type HealthArea = "memory" | "processes";

/** One thing worth a look. Never an action, only an observation. */
export interface HealthFlag {
  /**
   * Stable identity across checks. Transition detection ("is this flag NEW?")
   * compares these, so it must not embed changing numbers.
   */
  key: string;
  area: HealthArea;
  /**
   * Identifies the flagged row for the section that renders it: the memory
   * directory name for memory flags, `pid:name` for process flags. Distinct
   * from {@link target} because two projects can hold a `MEMORY.md` and two
   * processes can share a name.
   */
  scope: string;
  /** Short label for the flagged item, e.g. a memory file or process name. */
  target: string;
  /** One-line reason shown next to the item, e.g. "14 facts". */
  reason: string;
}

/* ================================================================ */
/*  MEMORY RULES                                                     */
/* ================================================================ */

/** Everything one project's memory check needs. */
export interface MemoryCheckInput {
  /** Encoded project dir under ~/.claude/projects (e.g. "C--git-maestro"). */
  dirName: string;
  files: MemoryFile[];
  /**
   * Repo-relative paths, per memory file, that were confirmed missing from
   * that project's repo. Empty/absent when the repo root is unknown (the
   * project is not open in Maestro) — the rule then simply does not fire.
   */
  missingRefs?: Record<string, string[]>;
  /** Evaluation time, injected so tests are deterministic. */
  now: number;
}

/**
 * Backtick-quoted repo-relative file paths referenced in a memory file body.
 *
 * Memory files are prose with inline code spans, and only a narrow slice of
 * those spans are checkable file paths. A candidate must:
 *
 * - be inside single backticks;
 * - contain a `/` (bare filenames are too ambiguous to attribute to a repo);
 * - contain no whitespace (rules out commands, sentences, "and / or");
 * - contain no `\` or `:` (Windows paths, `http://`, `note: x`);
 * - contain no glob/brace/wildcard characters;
 * - not be absolute (`/x`, `~/x`) or contain `..`;
 * - end in a file extension — 1-5 alphanumerics after a final dot.
 *
 * The extension requirement is what makes the rule safe: it drops branch names
 * (`feat/health-checker`), media types (`application/json`), dates and
 * `n/a`-style slashes, at the cost of missing directory references. That
 * trade is deliberate.
 */
export function extractPathRefs(body: string): string[] {
  const refs = new Set<string>();
  // Single-backtick spans only; ``` fenced blocks are code samples, not
  // references to this repo's files.
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1].trim();
    if (!candidate.includes("/")) continue;
    if (/[\s\\:*?[\]{}()<>|"'`]/.test(candidate)) continue;
    if (candidate.startsWith("/") || candidate.startsWith("~")) continue;
    if (candidate.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) continue;
    if (!/\.[A-Za-z0-9]{1,5}$/.test(candidate)) continue;
    refs.add(candidate);
    if (refs.size >= HEALTH_THRESHOLDS.maxPathRefsPerFile) break;
  }
  return [...refs];
}

/** Whole-days elapsed since an RFC 3339 timestamp; null when unparseable. */
function daysSince(modified: string | null, now: number): number | null {
  if (!modified) return null;
  const then = Date.parse(modified);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / (24 * 60 * 60 * 1000));
}

/**
 * Evaluates the four memory rules for one project:
 *
 * 1. more than {@link HEALTH_THRESHOLDS.maxFactFiles} fact files;
 * 2. MEMORY.md larger than {@link HEALTH_THRESHOLDS.maxIndexBytes};
 * 3. a fact file untouched for {@link HEALTH_THRESHOLDS.staleFactDays};
 * 4. a fact file referencing repo-relative paths that no longer exist.
 *
 * Rules 3 and 4 flag the individual file; 1 and 2 flag the project.
 */
export function evaluateMemory({
  dirName,
  files,
  missingRefs = {},
  now,
}: MemoryCheckInput): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const facts = files.filter((f) => !f.isIndex);

  if (facts.length > HEALTH_THRESHOLDS.maxFactFiles) {
    flags.push({
      key: `memory:${dirName}:count`,
      area: "memory",
      scope: dirName,
      target: dirName,
      reason: `${facts.length} facts`,
    });
  }

  const index = files.find((f) => f.isIndex);
  if (index && index.sizeBytes > HEALTH_THRESHOLDS.maxIndexBytes) {
    flags.push({
      key: `memory:${dirName}:index-size`,
      area: "memory",
      scope: dirName,
      target: index.relPath,
      reason: `index ${Math.round(index.sizeBytes / 1024)} KB`,
    });
  }

  for (const file of facts) {
    const age = daysSince(file.modified, now);
    if (age !== null && age >= HEALTH_THRESHOLDS.staleFactDays) {
      flags.push({
        key: `memory:${dirName}:${file.relPath}:age`,
        area: "memory",
        scope: dirName,
        target: file.relPath,
        reason: `not touched in ${Math.floor(age / 30)} months`,
      });
    }
  }

  for (const file of files) {
    const missing = missingRefs[file.relPath];
    if (!missing || missing.length === 0) continue;
    const extra = missing.length > 1 ? ` +${missing.length - 1} more` : "";
    flags.push({
      key: `memory:${dirName}:${file.relPath}:missing-paths`,
      area: "memory",
      scope: dirName,
      target: file.relPath,
      reason: `references missing ${missing[0]}${extra}`,
    });
  }

  return flags;
}

/* ================================================================ */
/*  PROCESS RULES                                                    */
/* ================================================================ */

/**
 * How many consecutive samples a process has been over each threshold.
 * Carried between checks by the store; a process that drops below resets to 0,
 * which is what makes "sustained" mean sustained.
 */
export type ProcessStreaks = Record<string, { cpu: number; mem: number }>;

/**
 * Identity of a process across samples. PID alone is reusable by the OS, so
 * the executable name is folded in — a recycled PID landing on a different
 * program then starts its streak from zero.
 */
export function processKey(p: Pick<DevProcess, "pid" | "name">): string {
  return `${p.pid}:${p.name}`;
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Evaluates the process rules against one sample, folding in the streak
 * counters from previous samples.
 *
 * - CPU / RAM: flagged only after {@link HEALTH_THRESHOLDS.consecutiveSamples}
 *   consecutive samples over the threshold, so a build spike stays quiet.
 * - Runtime: flagged immediately — a 24-hour-old process is sustained by
 *   definition, no streak needed.
 *
 * Returns the flags plus the streak map to carry into the next sample; entries
 * for processes that have exited are dropped.
 */
export function evaluateProcesses(
  processes: DevProcess[],
  prev: ProcessStreaks,
): { flags: HealthFlag[]; streaks: ProcessStreaks } {
  const flags: HealthFlag[] = [];
  const streaks: ProcessStreaks = {};

  for (const p of processes) {
    const key = processKey(p);
    const before = prev[key] ?? { cpu: 0, mem: 0 };
    const cpu = p.cpuPercent > HEALTH_THRESHOLDS.cpuPercent ? before.cpu + 1 : 0;
    const mem = p.memoryBytes > HEALTH_THRESHOLDS.memoryBytes ? before.mem + 1 : 0;
    streaks[key] = { cpu, mem };

    // Sustained-load minutes, derived from the sample count rather than
    // guessed, so the copy stays honest if the interval changes.
    const sustainedMin = Math.round(
      (cpu * HEALTH_CHECK_INTERVAL_MS) / 60_000,
    );

    if (cpu >= HEALTH_THRESHOLDS.consecutiveSamples) {
      flags.push({
        key: `process:${key}:cpu`,
        area: "processes",
        scope: key,
        target: p.matched,
        reason: `CPU >${HEALTH_THRESHOLDS.cpuPercent}% for ${sustainedMin}+ min`,
      });
    }
    if (mem >= HEALTH_THRESHOLDS.consecutiveSamples) {
      flags.push({
        key: `process:${key}:mem`,
        area: "processes",
        scope: key,
        target: p.matched,
        reason: `RAM ${formatGb(p.memoryBytes)}`,
      });
    }
    if (p.runTimeSecs > HEALTH_THRESHOLDS.runTimeSecs) {
      flags.push({
        key: `process:${key}:runtime`,
        area: "processes",
        scope: key,
        target: p.matched,
        reason: `running ${Math.floor(p.runTimeSecs / 3600)}h`,
      });
    }
  }

  return { flags, streaks };
}

/* ================================================================ */
/*  TRANSITIONS                                                      */
/* ================================================================ */

/**
 * Flags present in `next` that were absent from `prev`.
 *
 * `prev === null` means no check has completed yet (app start): everything
 * would look new, so nothing is reported — the same first-run suppression the
 * GitHub watchdog uses. Flags that clear never notify.
 */
export function diffNewFlags(prev: readonly string[] | null, next: HealthFlag[]): HealthFlag[] {
  if (prev === null) return [];
  const seen = new Set(prev);
  return next.filter((f) => !seen.has(f.key));
}
