import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  History,
  Play,
  RotateCcw,
} from "lucide-react";

import { listClaudeSessions, type ClaudeSessionInfo } from "@/lib/terminal";
import { listWorktrees, type WorktreeInfo } from "@/lib/worktreeManager";
import { projectColorFor } from "@/lib/projectColor";
import { useActivityStore } from "@/stores/useActivityStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Cap per project — the pre-launch card's picker remains the deep archive. */
const MAX_CONVERSATIONS_SHOWN = 10;

interface ProjectHistory {
  loading: boolean;
  conversations: ClaudeSessionInfo[];
  worktrees: WorktreeInfo[];
}

/** Relative time label, mirroring the pre-launch card's session picker. */
function formatRelativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

interface HistorySectionProps {
  /** Called after a recovery launch is queued so App can reveal the project. */
  onLaunch?: (tabId: string) => void;
}

/**
 * Sidebar History tab: per-project collapsibles listing past Claude
 * conversations (one click resumes them in a new terminal) and surviving
 * worktrees (one click launches an agent there). Conversations currently
 * running in a terminal are hidden to avoid double-resuming. Everything
 * here is non-destructive — deleting worktrees stays in the git panel.
 */
export function HistorySection({ onLaunch }: HistorySectionProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setSessionsLaunched = useWorkspaceStore((s) => s.setSessionsLaunched);
  const requestLaunch = usePendingLaunchStore((s) => s.request);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<Record<string, ProjectHistory>>({});

  // Claude conversation UUIDs currently attached to a live terminal, derived
  // from SessionStarted activity events of sessions that still exist.
  const activitySessions = useActivityStore((s) => s.sessions);
  const liveSessions = useSessionStore((s) => s.sessions);
  const liveConversationIds = useMemo(() => {
    const liveIds = new Set(liveSessions.map((s) => s.id));
    const uuids = new Set<string>();
    for (const [maestroId, activity] of Object.entries(activitySessions)) {
      if (!liveIds.has(Number(maestroId))) continue;
      for (const event of activity.events) {
        if (event.event_type === "SessionStarted") uuids.add(event.claude_session_uuid);
      }
    }
    return uuids;
  }, [activitySessions, liveSessions]);

  const loadProject = useCallback(async (tab: WorkspaceTab) => {
    setHistory((prev) => ({
      ...prev,
      [tab.id]: { loading: true, conversations: [], worktrees: [] },
    }));
    const repoPath = tab.selectedRepoPath ?? tab.projectPath;
    const [conversations, worktrees] = await Promise.all([
      listClaudeSessions(repoPath).catch(() => [] as ClaudeSessionInfo[]),
      listWorktrees(repoPath).catch(() => [] as WorktreeInfo[]),
    ]);
    setHistory((prev) => ({
      ...prev,
      [tab.id]: { loading: false, conversations, worktrees },
    }));
  }, []);

  const toggleProject = useCallback(
    (tab: WorkspaceTab) => {
      setExpanded((prev) => ({ ...prev, [tab.id]: !prev[tab.id] }));
      if (!expanded[tab.id]) void loadProject(tab);
    },
    [expanded, loadProject]
  );

  /** Queue the launch, make sure the project's grid mounts, reveal it. */
  const queueLaunch = useCallback(
    (
      tab: WorkspaceTab,
      resumeSessionId: string | null,
      worktree: WorktreeInfo | undefined
    ) => {
      requestLaunch({
        tabId: tab.id,
        mode: "Claude",
        resumeSessionId,
        workingDirOverride: worktree?.path ?? null,
        branch: worktree?.branch ?? null,
      });
      setSessionsLaunched(tab.id, true);
      onLaunch?.(tab.id);
    },
    [requestLaunch, setSessionsLaunched, onLaunch]
  );

  return (
    <div>
      <SectionHeader icon={History} label="History" />
      <p className="mb-2 text-[10px] leading-snug text-maestro-muted">
        Recover past agent conversations and worktrees. Click one to relaunch
        it in its project — no typing needed.
      </p>

      {tabs.map((tab) => {
        const color = projectColorFor(tab.name);
        const isOpen = Boolean(expanded[tab.id]);
        const data = history[tab.id];
        const conversations = (data?.conversations ?? [])
          .filter((c) => !liveConversationIds.has(c.session_id))
          .slice(0, MAX_CONVERSATIONS_SHOWN);
        const worktrees = (data?.worktrees ?? []).filter((w) => !w.is_main_worktree && !w.is_bare);

        return (
          <div key={tab.id} className={`${cardClass} mb-2 !p-2`}>
            <button
              type="button"
              onClick={() => toggleProject(tab)}
              className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-maestro-text"
            >
              {isOpen ? (
                <ChevronDown size={12} className="shrink-0 text-maestro-muted" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-maestro-muted" />
              )}
              <FolderGit2 size={12} className="shrink-0" style={{ color }} />
              <span className="truncate" style={{ color }}>
                {tab.name}
              </span>
            </button>

            {isOpen && (
              <div className="mt-1.5">
                {data?.loading ? (
                  <p className="px-1 py-0.5 text-[10px] text-maestro-muted">Loading…</p>
                ) : (
                  <>
                    <p className="mb-0.5 px-1 text-[9px] font-bold uppercase tracking-wider text-maestro-muted/80">
                      Conversations
                    </p>
                    {conversations.length === 0 ? (
                      <p className="mb-1 px-1 text-[10px] text-maestro-muted">
                        No resumable conversations
                      </p>
                    ) : (
                      conversations.map((conv) => {
                        const worktree = conv.git_branch
                          ? worktrees.find((w) => w.branch === conv.git_branch)
                          : undefined;
                        return (
                          <button
                            key={conv.session_id}
                            type="button"
                            onClick={() => queueLaunch(tab, conv.session_id, worktree)}
                            title="Resume this conversation in a new terminal"
                            className="group mb-0.5 flex w-full items-start gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-maestro-surface"
                          >
                            <RotateCcw
                              size={11}
                              className="mt-0.5 shrink-0 text-maestro-muted group-hover:text-maestro-accent"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 block text-[11px] leading-snug text-maestro-text">
                                {conv.first_prompt?.trim() || "No prompt recorded"}
                              </span>
                              <span className="flex items-center gap-1.5 text-[9px] text-maestro-muted">
                                <span>{formatRelativeTime(conv.last_active)}</span>
                                {conv.git_branch && (
                                  <span className="flex min-w-0 items-center gap-0.5">
                                    <GitBranch size={8} />
                                    <span className="truncate">{conv.git_branch}</span>
                                  </span>
                                )}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    )}

                    <p className="mb-0.5 mt-1.5 px-1 text-[9px] font-bold uppercase tracking-wider text-maestro-muted/80">
                      Worktrees
                    </p>
                    {worktrees.length === 0 ? (
                      <p className="px-1 text-[10px] text-maestro-muted">No worktrees</p>
                    ) : (
                      worktrees.map((worktree) => (
                        <button
                          key={worktree.path}
                          type="button"
                          onClick={() => queueLaunch(tab, null, worktree)}
                          title={`Launch an agent in ${worktree.path}`}
                          className="group mb-0.5 flex w-full items-center gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-maestro-surface"
                        >
                          <Play
                            size={11}
                            className="shrink-0 text-maestro-muted group-hover:text-maestro-green"
                          />
                          <GitBranch size={9} className="shrink-0 text-purple-400" />
                          <span className="truncate text-[11px] text-maestro-text">
                            {worktree.branch ?? worktree.path}
                          </span>
                        </button>
                      ))
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
