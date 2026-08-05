import { ask } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Container,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useDevProcesses } from "@/hooks/useDevProcesses";
import {
  killProcessTree,
  stopDockerContainer,
  type DevProcess,
  type DockerContainer,
} from "@/lib/processes";
import { HealthReasonLines } from "@/components/shared/HealthReasonLines";
import { processKey, type HealthFlag } from "@/lib/healthRules";
import { assessStaleness } from "@/lib/staleProcess";
import { flagsByRow, useHealthStore } from "@/stores/useHealthStore";
import {
  DEFAULT_WATCHLIST,
  useProcessWatchlistStore,
} from "@/stores/useProcessWatchlistStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Identical command+directory pairs collapse into one row with a ×N count. */
interface ProcessGroup {
  key: string;
  matched: string;
  cmd: string;
  cwd: string | null;
  procs: DevProcess[];
  memoryBytes: number;
  cpuPercent: number;
  anyMaestro: boolean;
  /** Union of every process's listening ports in this group, sorted ascending. */
  ports: number[];
}

function groupProcesses(procs: DevProcess[]): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  for (const p of procs) {
    const key = `${p.matched}|${p.cmd}|${p.cwd ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.procs.push(p);
      existing.memoryBytes += p.memoryBytes;
      existing.cpuPercent += p.cpuPercent;
      existing.anyMaestro ||= p.isMaestro;
      for (const port of p.ports) {
        if (!existing.ports.includes(port)) existing.ports.push(port);
      }
    } else {
      groups.set(key, {
        key,
        matched: p.matched,
        cmd: p.cmd,
        cwd: p.cwd,
        procs: [p],
        memoryBytes: p.memoryBytes,
        cpuPercent: p.cpuPercent,
        anyMaestro: p.isMaestro,
        ports: [...p.ports],
      });
    }
  }
  const result = [...groups.values()];
  for (const g of result) g.ports.sort((a, b) => a - b);
  return result.sort((a, b) => b.memoryBytes - a.memoryBytes);
}

function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

/** Last path segment of a working directory ("C:\git\maestro" → "maestro"). */
function dirBasename(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

const maestroBadge = (
  <span className="shrink-0 rounded bg-maestro-accent/20 px-1 text-[9px] font-bold text-maestro-accent">
    MAESTRO
  </span>
);

/** Monospace `:3000 :5173` chip listing the ports a process/group is holding. */
function portChips(ports: number[]) {
  if (ports.length === 0) return null;
  return (
    <span
      className="shrink-0 rounded bg-maestro-border/50 px-1 font-mono text-[9px] text-maestro-muted"
      title={`Listening on ${ports.map((p) => `port ${p}`).join(", ")}`}
    >
      {ports.map((p) => `:${p}`).join(" ")}
    </span>
  );
}

/**
 * Live view of dev-stack OS processes (node, vite, uvicorn, claude, ...)
 * matched against a user-editable watchlist, plus running Docker containers.
 * Kill buttons terminate the whole process tree — orphaned children are the
 * very thing this section exists to clean up.
 */
export function ProcessesSection() {
  const [expanded, setExpanded] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [editingWatchlist, setEditingWatchlist] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const watchlist = useProcessWatchlistStore((s) => s.watchlist);
  const { processes, containers, dockerAvailable, error, refresh } = useDevProcesses(
    expanded,
    watchlist,
  );

  const groups = useMemo(() => groupProcesses(processes ?? []), [processes]);
  const totalCount = processes?.length ?? 0;

  // Which projects are open right now — a port-holding server whose folder is
  // none of these (and that Maestro didn't launch) is a likely zombie.
  // Select the stable `tabs` reference, then derive paths (a mapped selector
  // would return a fresh array each render and defeat store memoization).
  const tabs = useWorkspaceStore((s) => s.tabs);
  const openProjectPaths = useMemo(() => tabs.map((t) => t.projectPath), [tabs]);

  const assessedGroups = useMemo(() => {
    const assessed = groups.map((group) => ({
      group,
      stale: assessStaleness({
        anyMaestro: group.anyMaestro,
        cwd: group.cwd,
        ports: group.ports,
        openProjectPaths,
      }),
    }));
    // Float likely zombies to the top; keep memory order within each bucket.
    return assessed.sort((a, b) => {
      const rank = (s: (typeof a)["stale"]) => (s.level === "stale" ? 0 : 1);
      const diff = rank(a.stale) - rank(b.stale);
      return diff !== 0 ? diff : b.group.memoryBytes - a.group.memoryBytes;
    });
  }, [groups, openProjectPaths]);

  const staleCount = assessedGroups.filter((g) => g.stale.level === "stale").length;

  // Health checker flags, resolved per PID. A group inherits every flag raised
  // against any of its processes (the rows are grouped, the rules are not).
  const healthFlags = useHealthStore((s) => s.flags);
  const healthRows = useMemo(() => flagsByRow(healthFlags, "processes"), [healthFlags]);
  const flagsForProcess = useCallback(
    (p: DevProcess) => healthRows.get(`${processKey(p)}|${p.matched}`),
    [healthRows],
  );
  const flagsForGroup = useCallback(
    (g: ProcessGroup): HealthFlag[] | undefined => {
      const groupFlags = g.procs.flatMap((p) => flagsForProcess(p) ?? []);
      return groupFlags.length > 0 ? groupFlags : undefined;
    },
    [flagsForProcess],
  );

  // One confirm dialog per target: guards double-clicks on kill buttons.
  const pendingKills = useRef(new Set<string>());
  const confirmAndRun = useCallback(
    async (key: string, message: string, title: string, action: () => Promise<void>) => {
      if (pendingKills.current.has(key)) return;
      pendingKills.current.add(key);
      try {
        const confirmed = await ask(message, { title, kind: "warning" }).catch(() => false);
        if (!confirmed) return;
        setActionError(null);
        try {
          await action();
        } catch (err) {
          setActionError(String(err));
        }
        await refresh();
      } finally {
        pendingKills.current.delete(key);
      }
    },
    [refresh],
  );

  const handleKillProcess = (p: DevProcess) =>
    confirmAndRun(
      `pid-${p.pid}`,
      `Kill "${p.matched}" (PID ${p.pid}) and all its child processes?`,
      "Kill Process Tree",
      () => killProcessTree(p.pid),
    );

  const handleKillGroup = (g: ProcessGroup) =>
    confirmAndRun(
      `group-${g.key}`,
      `Kill all ${g.procs.length} "${g.matched}" processes${
        g.cwd ? ` in ${dirBasename(g.cwd)}` : ""
      } and their children?`,
      "Kill Process Trees",
      async () => {
        for (const p of g.procs) {
          await killProcessTree(p.pid);
        }
      },
    );

  const handleStopContainer = (c: DockerContainer) =>
    confirmAndRun(
      `container-${c.id}`,
      `Stop container "${c.name}" (${c.image})?`,
      "Stop Container",
      () => stopDockerContainer(c.id),
    );

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className={cardClass}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block w-full text-left"
      >
        <SectionHeader
          icon={Activity}
          label="Processes"
          iconColor={totalCount > 0 ? "text-maestro-green" : undefined}
          badge={
            totalCount > 0 ? (
              <span
                className="rounded-full bg-maestro-green/20 px-1.5 text-[10px] font-bold text-maestro-green"
                title={`${totalCount} watched process${totalCount === 1 ? "" : "es"} running`}
              >
                {totalCount}
              </span>
            ) : undefined
          }
          right={
            expanded ? (
              <ChevronDown size={12} className="text-maestro-muted" />
            ) : (
              <ChevronRight size={12} className="text-maestro-muted" />
            )
          }
        />
      </button>

      {expanded && (
        <>
          <div className="mb-1 flex items-center gap-1 px-1">
            <p className="flex-1 text-[10px] text-maestro-muted/70">
              Dev processes on this machine, grouped by command.
            </p>
            <button
              type="button"
              onClick={() => setEditingWatchlist((v) => !v)}
              className={`rounded p-0.5 hover:bg-maestro-border/40 ${
                editingWatchlist ? "text-maestro-accent" : "text-maestro-muted"
              }`}
              title="Edit watched techs"
            >
              <SlidersHorizontal size={12} />
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded p-0.5 text-maestro-muted hover:bg-maestro-border/40"
              title="Refresh now"
            >
              <RefreshCw size={12} />
            </button>
          </div>

          {staleCount > 0 && (
            <p className="mb-1 flex items-start gap-1 px-1 text-[10px] text-maestro-red">
              <AlertTriangle size={11} className="mt-px shrink-0" />
              <span>
                {staleCount} likely leftover server{staleCount === 1 ? "" : "s"} holding a port
                with no open project — {staleCount === 1 ? "it's" : "they're"} flagged below.
              </span>
            </p>
          )}

          {editingWatchlist && (
            <WatchlistEditor onClose={() => setEditingWatchlist(false)} />
          )}

          {(error || actionError) && (
            <p className="break-words px-1 py-0.5 text-[10px] text-maestro-red">
              {actionError ?? error}
            </p>
          )}

          {processes === null ? (
            <div className="flex items-center gap-2 px-1 py-1">
              <Loader2 size={13} className="shrink-0 animate-spin text-maestro-muted" />
              <span className="text-xs text-maestro-muted">Scanning...</span>
            </div>
          ) : groups.length === 0 ? (
            <p className="px-1 py-0.5 text-[11px] text-maestro-muted">
              No watched processes running
            </p>
          ) : (
            <div className="space-y-0.5">
              {assessedGroups.map(({ group, stale }) => {
                const isMulti = group.procs.length > 1;
                const groupExpanded = expandedGroups.has(group.key);
                const repo = dirBasename(group.cwd);
                const isStale = stale.level === "stale";
                const groupReasons = flagsForGroup(group);
                return (
                  <div key={group.key}>
                    <div
                      className={`group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-maestro-border/30 ${
                        isStale ? "bg-maestro-red/5" : groupReasons ? "bg-maestro-orange/5" : ""
                      }`}
                      title={isStale ? stale.reason : group.cmd || group.matched}
                    >
                      {isMulti ? (
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          className="shrink-0 rounded p-px hover:bg-maestro-border/40"
                          title={groupExpanded ? "Collapse" : "Show each process"}
                        >
                          {groupExpanded ? (
                            <ChevronDown size={11} className="text-maestro-muted" />
                          ) : (
                            <ChevronRight size={11} className="text-maestro-muted" />
                          )}
                        </button>
                      ) : (
                        <span className="w-[13px] shrink-0" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs text-maestro-text">
                            {group.matched}
                          </span>
                          {isMulti && (
                            <span className="shrink-0 rounded bg-maestro-orange/20 px-1 text-[9px] font-bold text-maestro-orange">
                              ×{group.procs.length}
                            </span>
                          )}
                          {group.anyMaestro && maestroBadge}
                          {portChips(group.ports)}
                          {isStale && (
                            <span
                              className="flex shrink-0 items-center gap-0.5 rounded bg-maestro-red/20 px-1 text-[9px] font-bold text-maestro-red"
                              title={stale.reason}
                            >
                              <AlertTriangle size={9} />
                              STALE
                            </span>
                          )}
                        </span>
                        {(repo || group.cmd) && (
                          <span className="block truncate text-[10px] text-maestro-muted">
                            {repo ? `${repo} — ` : ""}
                            {group.cmd || group.procs[0].name}
                          </span>
                        )}
                        {groupReasons && <HealthReasonLines flags={groupReasons} />}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-maestro-muted">
                        {formatMem(group.memoryBytes)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void (isMulti ? handleKillGroup(group) : handleKillProcess(group.procs[0]))
                        }
                        className="shrink-0 rounded p-0.5 text-maestro-muted opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                        title={
                          isMulti
                            ? `Kill all ${group.procs.length} process trees`
                            : "Kill this process tree"
                        }
                        aria-label={`Kill ${group.matched}`}
                      >
                        <Square size={10} />
                      </button>
                    </div>

                    {isMulti && groupExpanded && (
                      <div className="ml-3 border-l border-maestro-border/40 pl-1.5">
                        {group.procs.map((p) => (
                          <div
                            key={p.pid}
                            className={`group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-maestro-border/30 ${
                              flagsForProcess(p) ? "bg-maestro-orange/5" : ""
                            }`}
                            title={p.cmd}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[11px] text-maestro-text/80">
                                PID {p.pid}
                              </span>
                              {flagsForProcess(p) && (
                                <HealthReasonLines flags={flagsForProcess(p) ?? []} />
                              )}
                            </span>
                            {p.isMaestro && maestroBadge}
                            {portChips(p.ports)}
                            <span className="shrink-0 text-[10px] tabular-nums text-maestro-muted">
                              {p.cpuPercent >= 0.5 ? `${Math.round(p.cpuPercent)}% · ` : ""}
                              {formatMem(p.memoryBytes)} · {formatUptime(p.runTimeSecs)}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleKillProcess(p)}
                              className="shrink-0 rounded p-0.5 text-maestro-muted opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                              title="Kill this process tree"
                              aria-label={`Kill PID ${p.pid}`}
                            >
                              <Square size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {dockerAvailable && (
            <>
              <div className="mt-2 mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
                <Container size={11} className="text-maestro-muted/80" />
                <span className="flex-1">Containers</span>
                {containers.length > 0 && (
                  <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
                    {containers.length}
                  </span>
                )}
              </div>
              {containers.length === 0 ? (
                <p className="px-1 py-0.5 text-[11px] text-maestro-muted">
                  No running containers
                </p>
              ) : (
                <div className="space-y-0.5">
                  {containers.map((c) => (
                    <div
                      key={c.id}
                      className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-maestro-border/30"
                      title={`${c.name} — ${c.image} (${c.status})`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-maestro-text">{c.name}</span>
                        <span className="block truncate text-[10px] text-maestro-muted">
                          {c.image} — {c.status}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleStopContainer(c)}
                        className="shrink-0 rounded p-0.5 text-maestro-muted opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                        title="Stop this container"
                        aria-label={`Stop ${c.name}`}
                      >
                        <Square size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Inline editor for the watched-tech list (one entry per line or comma). */
function WatchlistEditor({ onClose }: { onClose: () => void }) {
  const watchlist = useProcessWatchlistStore((s) => s.watchlist);
  const setWatchlist = useProcessWatchlistStore((s) => s.setWatchlist);
  const [draft, setDraft] = useState(watchlist.join("\n"));

  const handleSave = () => {
    setWatchlist(draft.split(/[\n,]/));
    onClose();
  };

  return (
    <div className="mb-1.5 rounded-md border border-maestro-border/60 bg-maestro-surface p-1.5">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        spellCheck={false}
        className="w-full resize-y rounded border border-maestro-border/60 bg-maestro-bg px-1.5 py-1 font-mono text-[11px] text-maestro-text focus:border-maestro-accent focus:outline-none"
        placeholder={"node\nvite\nuvicorn"}
      />
      <p className="mt-1 text-[10px] text-maestro-muted/70">
        One tech per line. Entries match the executable name exactly; entries of 4+ characters
        also match anywhere in the command line (so "vite" finds node running vite).
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          className="rounded bg-maestro-accent px-2 py-0.5 text-[11px] text-white hover:bg-maestro-accent/80"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-[11px] text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
        >
          Cancel
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setDraft(DEFAULT_WATCHLIST.join("\n"))}
          className="rounded px-2 py-0.5 text-[11px] text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
          title="Restore the default tech list"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
