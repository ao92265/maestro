import { Terminal, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { cardClass, SectionHeader } from "@/components/sidebar/sectionChrome";
import { type ExternalSession, useExternalSessionsStore } from "@/stores/useExternalSessionsStore";

/**
 * The terminals running outside Maestro.
 *
 * Maestro's own views only ever showed sessions it spawned, so anything Alex
 * started in iTerm was invisible here. These are grouped by repo because that
 * is how he thinks about them, and they offer only focus and close: they
 * belong to iTerm, and pretending otherwise would be a lie about who owns the
 * process.
 */

const REFRESH_MS = 15 * 1000;
const NO_REPO = "No repo";

/** The tab title if the agent set one, otherwise where the terminal is. */
function labelFor(session: ExternalSession): string {
  return session.title.trim() || session.cwd || session.tty;
}

function groupByRepo(sessions: ExternalSession[]): [string, ExternalSession[]][] {
  const groups = new Map<string, ExternalSession[]>();
  for (const session of sessions) {
    const key = session.repoName ?? NO_REPO;
    const existing = groups.get(key);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(key, [session]);
    }
  }
  // Repos first, alphabetically; the homeless terminals sit at the bottom.
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === NO_REPO) return 1;
    if (b === NO_REPO) return -1;
    return a.localeCompare(b);
  });
}

export function OutsideSection() {
  const { sessions, error, refresh, focus, close } = useExternalSessionsStore();

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const groups = useMemo(() => groupByRepo(sessions), [sessions]);

  return (
    <div className="flex flex-col gap-2">
      <SectionHeader
        icon={Terminal}
        label="Outside Vanguard"
        badge={
          sessions.length > 0 ? (
            <span className="text-[10px] text-maestro-muted">{sessions.length}</span>
          ) : null
        }
      />

      {error && (
        <p className="rounded border border-red-500/30 px-2 py-1.5 text-[11px] text-red-400">
          {error}
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="rounded border border-dashed border-maestro-border px-3 py-2 text-[11px] text-maestro-muted/70">
          No terminals running outside Vanguard.
        </p>
      ) : (
        groups.map(([repo, rows]) => (
          <div key={repo} className="flex flex-col gap-1">
            <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted/70">
              {repo}
            </span>
            {rows.map((session) => {
              const label = labelFor(session);
              return (
                <div key={session.id} className={`${cardClass} flex items-center gap-2 !py-2`}>
                  <button
                    type="button"
                    onClick={() => void focus(session.id)}
                    aria-label={`Focus ${label}`}
                    className="flex-1 truncate text-left text-[11px] text-maestro-text transition-colors hover:text-maestro-green"
                    title={session.cwd}
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    onClick={() => void close(session.id)}
                    aria-label={`Close ${label}`}
                    className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-red-400"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
