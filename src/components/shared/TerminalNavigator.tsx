import { useEffect, useRef, useState } from "react";
import { ChevronUp, ParkingSquare, Terminal } from "lucide-react";

import { projectColorFor } from "@/lib/projectColor";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { SessionStatusDot } from "../terminal/ThinkingIndicator";

interface TerminalNavigatorProps {
  /** Bring the session in front of the user (zoom or focus — the view decides). */
  onNavigate: (tabId: string, sessionId: number) => void;
}

/**
 * Footer drop-up listing every open terminal grouped by project (parked ones
 * marked with the park icon). Sits left of the account email; opens upward
 * because it lives in the bottom bar. Clicking a terminal navigates to it:
 * zoomed in when a zoom-in view is active, cursor-focused otherwise; parked
 * terminals are restored first.
 */
export function TerminalNavigator({ onNavigate }: TerminalNavigatorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const parkedIds = useSessionStore((s) => s.parkedSessionIds);

  // Close on click-away or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const groups = tabs
    .map((tab) => ({
      tab,
      terminals: tab.sessionIds
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => s != null),
    }))
    .filter((g) => g.terminals.length > 0);
  const total = groups.reduce((n, g) => n + g.terminals.length, 0);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Open terminals"
        aria-label="Open terminals"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-maestro-card hover:text-maestro-text ${
          open ? "bg-maestro-card text-maestro-text" : "text-maestro-muted/70"
        }`}
      >
        <Terminal size={12} className="shrink-0" />
        {total > 0 && <span>{total}</span>}
        <ChevronUp
          size={10}
          className={`shrink-0 transition-transform ${open ? "" : "rotate-180"}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-[60vh] w-64 overflow-y-auto rounded-lg border border-maestro-border bg-maestro-card p-1.5 shadow-xl shadow-black/40">
          {total === 0 && (
            <p className="px-2 py-1.5 text-[11px] text-maestro-muted">
              No terminals running.
            </p>
          )}
          {groups.map(({ tab, terminals }) => {
            const color = projectColorFor(tab.name);
            return (
              <div key={tab.id} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="min-w-0 truncate text-[10px] font-bold uppercase tracking-wider"
                    style={{ color }}
                  >
                    {tab.name}
                  </span>
                </div>
                {terminals.map((sess) => {
                  const isParked = parkedIds.includes(sess.id);
                  return (
                    <button
                      key={sess.id}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onNavigate(tab.id, sess.id);
                      }}
                      title={
                        isParked
                          ? "Parked — click to restore and go to it"
                          : "Go to this terminal"
                      }
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-surface"
                    >
                      <SessionStatusDot sessionId={sess.id} />
                      <span className="min-w-0 flex-1 truncate">
                        {sess.name?.trim() || `Session #${sess.id}`}
                      </span>
                      {isParked && (
                        <ParkingSquare
                          size={11}
                          className="shrink-0 text-maestro-muted"
                          aria-label="Parked"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
