import { useMemo } from "react";

import { samePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** Chip status dot colors — mirrors the sidebar's SESSION_STATUS_BADGES palette. */
const STATUS_DOT: Record<BackendSessionStatus, string> = {
  Starting: "bg-orange-400",
  Idle: "bg-maestro-muted",
  Working: "bg-maestro-accent",
  NeedsInput: "bg-yellow-500",
  Done: "bg-maestro-green",
  Error: "bg-red-500",
  Timeout: "bg-red-500",
};

/** Last path segment, used as the project label in the eagle shelf. */
function basenameOf(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * Chip border per status. Parked terminals stay parked (WhatsApp-archive
 * semantics), but a chip whose agent stopped and wants the user turns
 * yellow and pulses; errors turn red; explicit Done turns green.
 */
function chipBorderClass(status: BackendSessionStatus): string {
  switch (status) {
    case "NeedsInput":
      return "parked-chip-attention";
    case "Error":
    case "Timeout":
      return "border-maestro-red";
    case "Done":
      return "border-maestro-green";
    default:
      return "border-maestro-border";
  }
}

/** Statuses that make the shelf itself call for the user's eye. */
const ATTENTION_STATUSES: BackendSessionStatus[] = ["NeedsInput", "Error", "Timeout"];

interface ParkedShelfProps {
  /** When given, only parked sessions of this project are shown (per-project grid). */
  projectPath?: string;
  onUnpark: (sessionId: number) => void;
  /** Eagle view: prefix each chip with its project name (color-coded). */
  showProjectLabels?: boolean;
}

/**
 * Thin strip at the bottom edge of the terminal grid listing parked
 * terminals as chips (name + live status dot). Clicking a chip restores
 * the terminal to the grid. Renders nothing while no terminal is parked.
 */
export function ParkedShelf({ projectPath, onUnpark, showProjectLabels = false }: ParkedShelfProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const parkedIds = useSessionStore((s) => s.parkedSessionIds);

  const parkedSessions = useMemo(
    () =>
      sessions.filter(
        (sess) =>
          parkedIds.includes(sess.id) &&
          (projectPath === undefined || samePath(sess.project_path, projectPath))
      ),
    [sessions, parkedIds, projectPath]
  );

  if (parkedSessions.length === 0) return null;

  const hasAttention = parkedSessions.some((sess) => ATTENTION_STATUSES.includes(sess.status));

  return (
    <div
      className={`flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-t bg-maestro-surface px-2 ${
        hasAttention ? "border-maestro-yellow/60" : "border-maestro-border"
      }`}
    >
      <span
        className={`shrink-0 text-[10px] font-medium uppercase tracking-wider ${
          hasAttention ? "text-maestro-yellow" : "text-maestro-muted"
        }`}
      >
        Parked
      </span>
      {parkedSessions.map((sess) => {
        const projectName = showProjectLabels ? basenameOf(sess.project_path) : null;
        return (
          <button
            key={sess.id}
            type="button"
            onClick={() => onUnpark(sess.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border bg-maestro-card px-2.5 py-0.5 text-xs text-maestro-text transition-colors hover:border-maestro-accent ${chipBorderClass(sess.status)}`}
            title="Restore terminal"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[sess.status] ?? STATUS_DOT.Idle}`} />
            <ThinkingIndicator sessionId={sess.id} size={3} />
            {projectName && (
              <span className="font-bold" style={{ color: projectColorFor(projectName) }}>
                {projectName}
              </span>
            )}
            <span className="max-w-[140px] truncate">
              {sess.name?.trim() || `Session #${sess.id}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
