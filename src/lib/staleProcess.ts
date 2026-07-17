/**
 * Heuristics for spotting "zombie" dev servers in the Processes panel — a
 * server process that keeps holding a network port after the project that
 * started it is gone, which is exactly what lets a later test/dev run silently
 * talk to stale code on that port.
 *
 * A process is a *server* only if it is LISTENING on a port; anything without a
 * port is never flagged (avoids noise from CLIs, language servers, etc.).
 */

/** The confidence with which a process looks like a leftover server. */
export type StaleLevel = "stale" | null;

export interface StaleAssessment {
  level: StaleLevel;
  /** Human-readable explanation, shown as a tooltip. Empty when `level` is null. */
  reason: string;
}

/** Lowercase, forward-slash, no trailing slash — so path compares are stable
 *  across OSes and Windows' case-insensitive, backslash paths. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when `cwd` equals, or sits inside, any of the given project paths. */
export function isUnderAnyPath(cwd: string | null, paths: string[]): boolean {
  if (!cwd) return false;
  const c = normalizePath(cwd);
  return paths.some((p) => {
    const base = normalizePath(p);
    return base.length > 0 && (c === base || c.startsWith(`${base}/`));
  });
}

export interface StaleInput {
  /** True if any process in the group descends from a live Maestro terminal. */
  anyMaestro: boolean;
  /** Working directory (project folder) the process runs in. */
  cwd: string | null;
  /** Ports the process is listening on. */
  ports: number[];
  /** Absolute paths of the projects currently open in Maestro. */
  openProjectPaths: string[];
}

/**
 * Flags a port-holding server that no currently-open project owns.
 *
 * "Owned" means either Maestro launched it in a live terminal, or it runs
 * inside a folder you still have open. A server that is neither is almost
 * certainly a leftover from a closed project — the zombie we care about.
 */
export function assessStaleness({
  anyMaestro,
  cwd,
  ports,
  openProjectPaths,
}: StaleInput): StaleAssessment {
  // Only servers (things holding a port) can be zombie servers.
  if (ports.length === 0) return { level: null, reason: "" };

  const owned = anyMaestro || isUnderAnyPath(cwd, openProjectPaths);
  if (owned) return { level: null, reason: "" };

  const portList = ports.map((p) => `:${p}`).join(", ");
  return {
    level: "stale",
    reason:
      `Holding ${portList} but no open project owns it — likely a leftover ` +
      `dev server. Safe to stop if you're not using it.`,
  };
}
