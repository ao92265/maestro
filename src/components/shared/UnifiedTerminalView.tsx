import { useMemo, useState } from "react";
import { samePath } from "@/lib/path";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { gridDimensions } from "../terminal/splitTree";
import { TerminalView } from "../terminal/TerminalView";

/**
 * A single running terminal joined to the project (tab) it belongs to.
 */
interface UnifiedPane {
  session: SessionConfig;
  tab: WorkspaceTab;
}

/**
 * Unified "All Terminals" view.
 *
 * Renders every running terminal across ALL open projects in one grid, with
 * each pane bordered and labeled in its project's accent color so the user can
 * tell them apart. Panes are ordered by project (tab order), then by session id.
 *
 * This is an aggregate/overlay view: it mounts its own {@link TerminalView}
 * instances (fresh xterm buffers) for each live backend session. The per-project
 * grid stays mounted underneath, so toggling this view off restores each
 * project's terminals with their scrollback intact. The backend PTYs are shared,
 * so input and live output work here exactly as they do in the per-project grid.
 *
 * This is a monitor/interact view: terminals accept input and scroll, but
 * session lifecycle (kill, launch, worktree cleanup) stays owned by the
 * per-project grid, so no kill affordance is exposed here.
 */
export function UnifiedTerminalView() {
  const sessions = useSessionStore((s) => s.sessions);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const [focusedSessionId, setFocusedSessionId] = useState<number | null>(null);

  // Join each session to its owning project tab, preserving tab order then session id.
  const panes = useMemo<UnifiedPane[]>(() => {
    const result: UnifiedPane[] = [];
    for (const tab of tabs) {
      const projectSessions = sessions
        .filter((s) => samePath(s.project_path, tab.projectPath))
        .sort((a, b) => a.id - b.id);
      for (const session of projectSessions) {
        result.push({ session, tab });
      }
    }
    return result;
  }, [sessions, tabs]);

  const { cols } = useMemo(() => gridDimensions(panes.length), [panes.length]);

  if (panes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-maestro-bg text-center">
        <p className="text-sm text-maestro-text">No running terminals</p>
        <p className="text-xs text-maestro-muted">
          Launch sessions in a project to see them gathered here.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-maestro-bg p-2">
      <div
        className="grid h-full min-h-0 gap-2"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: "minmax(0, 1fr)",
        }}
      >
        {panes.map(({ session, tab }) => (
          <div
            key={session.id}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border-2 bg-maestro-bg"
            style={{ borderColor: tab.color }}
          >
            {/* Project label bar — the primary way to tell projects apart. */}
            <div
              className="flex shrink-0 items-center gap-1.5 px-2 py-1"
              style={{ backgroundColor: `${tab.color}22` }}
              title={tab.projectPath}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: tab.color }}
              />
              <span className="truncate text-[11px] font-semibold" style={{ color: tab.color }}>
                {tab.name}
              </span>
              {session.branch && (
                <span className="truncate text-[10px] text-maestro-muted">{session.branch}</span>
              )}
            </div>

            {/* The live terminal. */}
            <div className="min-h-0 flex-1">
              <TerminalView
                key={`unified-${session.id}`}
                sessionId={session.id}
                isActive
                isFocused={focusedSessionId === session.id}
                onFocus={() => setFocusedSessionId(session.id)}
                terminalCount={panes.length}
                isZoomed={false}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
