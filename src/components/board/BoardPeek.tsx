import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { relAgo } from "@/components/board/BoardCard";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import {
  type ClaudeSessionInfo,
  type ClaudeSessionListing,
  listClaudeSessions,
} from "@/lib/terminal";

/**
 * Read-only peek at claude work running outside Maestro.
 *
 * Maestro cannot show another terminal's live screen, and pretending
 * otherwise would be a dead control. What it can show honestly is the
 * transcript trail Claude Code writes as the session runs: the newest
 * conversations in that directory, each with its last activity, branch and
 * age. The one real action is adopting the PROJECT as a tab; adopting the
 * WORK stays with the Suggested handoff flow once the outside session
 * stops, because a second agent on a live directory is the harmful
 * direction.
 */

/** Newest conversations shown; the point is a glance, not a history browser. */
const MAX_PEEK_SESSIONS = 3;

export function BoardPeek({
  dir,
  projectName,
  onClose,
  onOpenProject,
  loadSessions = listClaudeSessions,
}: {
  /** Directory the outside claude process is working in. */
  dir: string;
  projectName: string;
  onClose: () => void;
  /** Open the directory as a Maestro tab (no session launch). */
  onOpenProject: (dir: string) => void;
  /** Injectable for tests; the real one lists Claude Code's transcripts. */
  loadSessions?: (dir: string) => Promise<ClaudeSessionListing>;
}) {
  const [sessions, setSessions] = useState<ClaudeSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    loadSessions(dir).then(
      (listing) => {
        if (cancelled) return;
        const newest = [...listing.sessions].sort(
          (a, b) => Date.parse(b.last_active) - Date.parse(a.last_active),
        );
        setSessions(newest.slice(0, MAX_PEEK_SESSIONS));
      },
      (err) => {
        if (!cancelled) setError(String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dir, loadSessions]);

  function rowText(s: ClaudeSessionInfo): string {
    return s.last_activity ?? s.last_prompt ?? s.first_prompt ?? "No readable messages yet";
  }

  return (
    /* z-46: over the board (z-45), still under the full-screen overlays
       (z-50), which keep stacking over everything board-shaped. Closing
       lives on Escape (BoardView's key handler) and the header button. */
    <div className="absolute inset-0 z-[46] flex items-center justify-center bg-black/50 p-6">
      <div
        role="dialog"
        aria-label={`Outside session in ${projectName}`}
        className="flex max-h-full w-[34rem] flex-col rounded-md border border-maestro-border bg-maestro-bg shadow-xl"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-maestro-text">
            {projectName}
            <span className="ml-2 font-normal text-maestro-muted">working outside Maestro</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          >
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {error ? (
            <p className="text-[11px] text-maestro-yellow">Could not read transcripts: {error}</p>
          ) : sessions === null ? (
            <p className="text-[11px] text-maestro-muted">Reading transcripts…</p>
          ) : sessions.length === 0 ? (
            <p className="text-[11px] text-maestro-muted">
              No transcript found for this directory. The process is running, but no conversation
              has been written here.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => (
                <li
                  key={s.session_id}
                  className="rounded-md border border-maestro-border bg-maestro-card px-2 py-1.5"
                >
                  <span className="block w-full truncate text-[11px] text-maestro-text">
                    {rowText(s)}
                  </span>
                  <span className="mt-1 flex w-full items-center gap-2 text-[10px] text-maestro-muted">
                    {s.git_branch && (
                      <span className={`${badgeBaseClass} bg-maestro-muted/15 text-maestro-muted`}>
                        {s.git_branch}
                      </span>
                    )}
                    <span>{s.message_count} messages</span>
                    <span className="flex-1" />
                    <span>{relAgo(s.last_active)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-maestro-muted/70">
            This work runs in another terminal. Maestro reads its transcript trail; the live view
            stays where it runs. Once the session stops, its handoff appears in Suggested and can be
            resumed from there.
          </p>
        </div>

        <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-t border-maestro-border px-3">
          <button
            type="button"
            onClick={() => onOpenProject(dir)}
            className="rounded border border-maestro-border px-2 py-1 text-[11px] text-maestro-text transition-colors hover:bg-maestro-card"
            title="Open this directory as a Maestro tab. No session is launched, so the outside one keeps running undisturbed."
          >
            Open project in Maestro
          </button>
        </div>
      </div>
    </div>
  );
}
