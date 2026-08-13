import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Loader2, RefreshCw, ScrollText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { samePath } from "@/lib/path";
import {
  type SamuraiAuditEvent,
  type SamuraiAuditEventKind,
  type SamuraiAuditEventPayload,
  samuraiAuditClear,
  samuraiAuditRead,
} from "@/lib/samurai";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** How many rows to load/keep — matches the "existing lists" bar (no virtualization). */
const AUDIT_TAIL = 200;

/** Badge tint per audit event kind (sidebar badge palette). */
const KIND_BADGES: Record<SamuraiAuditEventKind, string> = {
  SPAWN: "bg-maestro-green/20 text-maestro-green",
  HANDOFF: "bg-maestro-blue/15 text-maestro-blue",
  PARK: "bg-maestro-purple/20 text-maestro-purple",
  RESUME: "bg-maestro-accent/20 text-maestro-accent",
  COMPLETE: "bg-maestro-green/20 text-maestro-green",
  ALERT: "bg-red-500/15 text-red-400",
  INJECT: "bg-maestro-orange/20 text-maestro-orange",
};

/**
 * `kind=allowance_threshold window=5h …` — flat scalars only, zero polish.
 * The instruction excerpt (issue #101) is excluded here: it is a long text
 * block that would drown the one-line summary — the expanded row shows it.
 */
function summarizeDetails(details: unknown): string {
  if (details === null || details === undefined) return "";
  if (typeof details === "string") return details;
  if (typeof details === "object") {
    return Object.entries(details as Record<string, unknown>)
      .filter(([k, v]) => v !== null && v !== undefined && typeof v !== "object" && k !== "excerpt")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  }
  return String(details);
}

/** Time for today's rows, date + time for older ones. */
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString();
}

/**
 * Expanded replay details for one row (issue #101): every scalar detail as a
 * labelled line, the bounded instruction excerpt as a wrapped block, and the
 * row's identity (full timestamp, epic, generation, session). Old rows
 * without the new fields render whatever they do carry — every field is
 * optional by construction.
 */
function AuditRowDetails({ event }: { event: SamuraiAuditEvent }) {
  const details =
    event.details && typeof event.details === "object" && !Array.isArray(event.details)
      ? (event.details as Record<string, unknown>)
      : null;
  const excerpt = details && typeof details.excerpt === "string" ? details.excerpt : null;
  const totalChars =
    details && typeof details.total_chars === "number" ? details.total_chars : null;
  const excerptChars = excerpt === null ? 0 : [...excerpt].length;
  // The excerpt gets its own block below; total_chars rides in its label.
  const lines = details
    ? Object.entries(details).filter(
        ([key, value]) =>
          key !== "excerpt" && key !== "total_chars" && value !== null && value !== undefined,
      )
    : [];
  return (
    <div className="mb-0.5 ml-3 space-y-1 rounded border-l-2 border-maestro-border bg-maestro-surface/50 px-2 py-1.5 text-[10px]">
      <p className="break-words text-maestro-muted/80">
        {event.ts}
        {event.epic ? ` · epic ${event.epic}` : ""} · gen-{event.generation} · session{" "}
        {event.session_id}
      </p>
      {lines.length > 0 && (
        <dl className="space-y-px">
          {lines.map(([key, value]) => (
            <div key={key} className="flex gap-1.5">
              <dt className="shrink-0 font-semibold text-maestro-muted">{key}</dt>
              <dd className="min-w-0 break-words text-maestro-text">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {details === null && event.details !== null && event.details !== undefined && (
        <p className="break-words text-maestro-text">{JSON.stringify(event.details)}</p>
      )}
      {excerpt !== null && (
        <div>
          <p className="font-semibold text-maestro-muted">
            instruction excerpt
            {totalChars !== null && totalChars > excerptChars
              ? ` (first ${excerptChars} of ${totalChars} chars)`
              : ""}
          </p>
          <p className="whitespace-pre-wrap break-words rounded bg-maestro-bg px-1.5 py-1 font-mono text-maestro-text">
            {excerpt}
          </p>
        </div>
      )}
    </div>
  );
}

function AuditRow({ event }: { event: SamuraiAuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const badgeCls = KIND_BADGES[event.event] ?? "bg-maestro-muted/15 text-maestro-muted";
  const summary = summarizeDetails(event.details);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-maestro-surface"
        title={`${event.ts}${event.epic ? `\nepic: ${event.epic}` : ""}\n${JSON.stringify(
          event.details ?? {},
          null,
          2,
        )}`}
      >
        <ChevronRight
          size={10}
          className={`shrink-0 text-maestro-muted transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span
          className={`shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide ${badgeCls}`}
        >
          {event.event}
        </span>
        <span className="shrink-0 text-maestro-muted">gen-{event.generation}</span>
        <span className="min-w-0 flex-1 truncate text-maestro-text">{summary}</span>
        <span className="shrink-0 text-[10px] text-maestro-muted/70">{formatTs(event.ts)}</span>
      </button>
      {expanded && <AuditRowDetails event={event} />}
    </div>
  );
}

/**
 * Minimal Samurai audit stream (issue #46, Phase 1): the active project's
 * audit rows newest-first, live-appended from `samurai-audit-event`, with the
 * manual clear (PRD §5.10: the user deletes audit records — human oversight).
 * Issue #101 adds expandable rows: clicking one opens its replay details
 * (instruction excerpts, ACK results, handoff file + WIP commit, spawn
 * triggers) as a readable timeline; the raw JSON stays on the row tooltip.
 * Deliberately zero polish otherwise — no filters, no virtualization.
 */
export function AuditSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  // null = loading; rows are kept newest-first.
  const [events, setEvents] = useState<SamuraiAuditEvent[] | null>(null);
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setEvents([]);
      setFileSizeBytes(0);
      return;
    }
    try {
      const result = await samuraiAuditRead(projectPath, AUDIT_TAIL);
      setEvents(result.events.slice().reverse());
      setFileSizeBytes(result.file_size_bytes);
      setError(null);
    } catch (err) {
      setError(String(err));
      setEvents([]);
    }
  }, [projectPath]);

  useEffect(() => {
    setEvents(null);
    refresh();
  }, [refresh]);

  // Live stream: the backend mirrors every appended row to this channel, so
  // no polling. Rows for other projects (and the account-wide pseudo-project
  // when nothing is supervised) are skipped.
  useEffect(() => {
    if (!projectPath) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen<SamuraiAuditEventPayload>("samurai-audit-event", (e) => {
      if (!samePath(e.payload.project, projectPath)) return;
      setEvents((prev) => [e.payload.event, ...(prev ?? [])].slice(0, AUDIT_TAIL));
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // Event system unavailable (tests) — the list still renders from reads.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [projectPath]);

  const handleClear = async () => {
    const confirmed = await ask(
      "Delete this project's Samurai audit log? It is your oversight record of supervised runs and cannot be recovered.",
      { title: "Clear Audit Log", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    try {
      await samuraiAuditClear(projectPath);
      setEvents([]);
      setFileSizeBytes(0);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={ScrollText}
        label="Samurai Audit"
        iconColor="text-maestro-accent"
        badge={
          events && events.length > 0 ? (
            <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
              {events.length}
            </span>
          ) : undefined
        }
        right={
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh audit log"
              title="Reload the audit log"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={!projectPath || !events || events.length === 0}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
              aria-label="Clear audit log"
              title="Delete this project's audit log (asks first)"
            >
              <Trash2 size={12} />
            </button>
          </span>
        }
      />
      <p className="mb-2 text-[11px] text-maestro-muted">
        Supervisor events for this project, newest first.
        {fileSizeBytes > 0 ? ` ${Math.max(1, Math.round(fileSizeBytes / 1024))} KB on disk.` : ""}
      </p>
      {error && <p className="mb-2 text-[11px] text-maestro-red">{error}</p>}
      {events === null ? (
        <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : events.length === 0 ? (
        <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
          No audit events for this project.
        </p>
      ) : (
        <div className="space-y-0.5">
          {events.map((event, i) => (
            <AuditRow key={`${event.ts}-${event.session_id}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
