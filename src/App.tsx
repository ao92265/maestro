import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { GitFork, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAC_TITLE_BAR_INSET_PX, useMacTitleBarPadding } from "@/hooks/useMacTitleBarPadding";
import { getDeduplicatedCurrentBranch } from "@/lib/git";
import { isMac } from "@/lib/platform";
import { projectColorFor } from "@/lib/projectColor";
import { killSession } from "@/lib/terminal";
import { useOpenProject } from "@/lib/useOpenProject";
import { useProjectColors } from "@/lib/useProjectColors";
import { useFDAStore } from "@/stores/useFDAStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { type RepositoryInfo, useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { GitGraphPanel } from "./components/git/GitGraphPanel";
import type { GitPanelTab } from "./components/git/GitPanelTabs";
import { BottomBar } from "./components/shared/BottomBar";
import { FDADialog } from "./components/shared/FDADialog";
import {
  MultiProjectView,
  type MultiProjectViewHandle,
} from "./components/shared/MultiProjectView";
import {
  loadRightPanelWidth,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "./components/shared/PanelResizeHandle";
import { ProjectTabs } from "./components/shared/ProjectTabs";
import { type EagleProjectOption, TopBar } from "./components/shared/TopBar";
import { UtilityPanel, type UtilityPanelKind } from "./components/shared/UtilityPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { UpdateNotification } from "./components/update/UpdateNotification";
import { useAppKeyboard } from "./hooks/useAppKeyboard";
import { useSwipeNavigation } from "./hooks/useSwipeNavigation";
import { initActivityListener, stopActivityListener } from "./stores/useActivityStore";
import { initAgentListener, stopAgentListener } from "./stores/useAgentStore";
import { useGitStore } from "./stores/useGitStore";
import { useTerminalSettingsStore } from "./stores/useTerminalSettingsStore";
import { useUpdateStore } from "./stores/useUpdateStore";

const DEFAULT_SESSION_COUNT = 6;

/** Header title for each git-panel tab. */
const GIT_PANEL_TITLES: Record<GitPanelTab, string> = {
  commits: "Commits",
  branches: "Branches",
  status: "Status",
  prs: "Pull Requests",
  issues: "Issues",
  discussions: "Discussions",
};

type Theme = "dark" | "light";

function isValidTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light";
}

function App() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const projectColors = useProjectColors();
  const selectTab = useWorkspaceStore((s) => s.selectTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const reorderTabs = useWorkspaceStore((s) => s.reorderTabs);
  const moveTab = useWorkspaceStore((s) => s.moveTab);
  const setSessionsLaunched = useWorkspaceStore((s) => s.setSessionsLaunched);
  const setSelectedRepo = useWorkspaceStore((s) => s.setSelectedRepo);
  const rehydrateRepositories = useWorkspaceStore((s) => s.rehydrateRepositories);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const initListeners = useSessionStore((s) => s.initListeners);
  const { openProject: handleOpenProject } = useOpenProject();
  const showFDADialog = useFDAStore((s) => s.showDialog);
  const fdaPath = useFDAStore((s) => s.pendingPath);
  const dismissFDADialog = useFDAStore((s) => s.dismiss);
  const dismissFDADialogPermanently = useFDAStore((s) => s.dismissPermanently);
  const retryAfterFDAGrant = useFDAStore((s) => s.retryAfterGrant);
  const multiProjectRef = useRef<MultiProjectViewHandle>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  // Git-panel tab (commits/branches/…) is deliberately a single app-level
  // state shared across eagle carousel cards: swiping keeps you on the same
  // tab for every project. Per-repo selections are cleared by GitGraphPanel
  // whenever repoPath changes, so no per-project tab state is needed.
  const [gitPanelTab, setGitPanelTab] = useState<GitPanelTab>("status");
  const [sessionCounts, setSessionCounts] = useState<
    Map<string, { slotCount: number; launchedCount: number }>
  >(new Map());
  const [isStoppingAll, setIsStoppingAll] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | undefined>(undefined);
  // Eagle view: one flat grid of every project's terminals at once
  const [eagleView, setEagleView] = useState(false);
  // Eagle view git carousel: index of the project whose git panel card shows.
  const [eagleGitIndex, setEagleGitIndex] = useState(0);
  // Right-side utility panel (Memory / Processes), opened from the top bar.
  // One at a time: opening one replaces the other.
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanelKind | null>(null);
  // One shared width for every right-docked panel (Memory/Processes, Git),
  // so switching between them never changes the pane size. Persisted.
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(loadRightPanelWidth);
  const handleRightPanelResize = useCallback((width: number) => {
    setRightPanelWidth(width);
    localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(width));
  }, []);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("maestro-theme");
    return isValidTheme(stored) ? stored : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("maestro-theme", theme);
  }, [theme]);

  // Tag the document with platform class so CSS can disable expensive effects
  // (e.g. box-shadow animations) that aren't GPU-accelerated on WebKitGTK/Linux.
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("linux")) {
      document.documentElement.classList.add("platform-linux");
    }
  }, []);

  // Clean up orphaned PTY sessions on mount, then fetch fresh session state.
  // kill_all_sessions clears both ProcessManager (PTYs) and SessionManager
  // (metadata), so fetchSessions must run AFTER cleanup completes to avoid
  // loading stale "idle" sessions from a previous frontend lifecycle.
  useEffect(() => {
    invoke<number>("kill_all_sessions")
      .then((count) => {
        if (count > 0) {
          console.log(`Cleaned up ${count} orphaned PTY session(s) from previous page load`);
        }
      })
      .catch((err) => {
        console.error("Failed to clean up orphaned sessions:", err);
      })
      .finally(() => {
        fetchSessions().catch((err) => {
          console.error("Failed to fetch sessions:", err);
        });
      });

    const unlistenPromise = initListeners().catch((err) => {
      console.error("Failed to initialize listeners:", err);
      return () => {}; // no-op cleanup
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [fetchSessions, initListeners]);

  // Initialize terminal settings store (detects available fonts)
  const initializeTerminalSettings = useTerminalSettingsStore((s) => s.initialize);
  useEffect(() => {
    initializeTerminalSettings().catch((err) => {
      console.error("Failed to initialize terminal settings:", err);
    });
  }, [initializeTerminalSettings]);

  // Initialize update event listeners and auto-check
  const initUpdateListeners = useUpdateStore((s) => s.initListeners);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const autoCheckEnabled = useUpdateStore((s) => s.autoCheckEnabled);
  const checkIntervalMinutes = useUpdateStore((s) => s.checkIntervalMinutes);

  useEffect(() => {
    const unlistenPromise = initUpdateListeners().catch((err) => {
      console.error("Failed to initialize update listeners:", err);
      return () => {};
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [initUpdateListeners]);

  // Initialize activity event listener (claude-event from transcript watcher)
  useEffect(() => {
    initActivityListener().catch((err) => {
      console.error("Failed to initialize activity listener:", err);
    });
    return () => {
      stopActivityListener();
    };
  }, []);

  // Initialize agent listener (tracks subagents for the sidebar Agents section)
  useEffect(() => {
    initAgentListener().catch((err) => {
      console.error("Failed to initialize agent listener:", err);
    });
    return () => {
      stopAgentListener();
    };
  }, []);

  // Listen for CLI-initiated project open events (from `maestro /path`).
  //
  // Two triggers:
  //   1. A subsequent `maestro <path>` invocation fires the
  //      `cli-open-project` event immediately via the single-instance plugin.
  //   2. On first launch the path was captured in a backend slot; we drain it
  //      here on mount via `take_pending_cli_path`. That replaces the older
  //      500ms sleep + emit dance, which raced against slow frontend mounts.
  useEffect(() => {
    const openFromCli = async (path: string) => {
      if (!path) return;
      try {
        await useWorkspaceStore.getState().openProject(path);
      } catch (err) {
        console.error("cli-open-project failed:", err);
        return;
      }
      getCurrentWindow()
        .setFocus()
        .catch(() => {});
    };

    // Drain any path captured before we mounted.
    invoke<string | null>("take_pending_cli_path")
      .then((path) => {
        if (path) void openFromCli(path);
      })
      .catch(() => {});

    const unlisten = listen<string>("cli-open-project", (event) => {
      void openFromCli(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!autoCheckEnabled) return;
    // Check on mount
    checkForUpdates();
    // Then periodically
    const interval = setInterval(checkForUpdates, checkIntervalMinutes * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoCheckEnabled, checkIntervalMinutes, checkForUpdates]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const macTitleBarPadding = useMacTitleBarPadding();
  const activeTab = tabs.find((tab) => tab.active) ?? null;

  // Eagle view git carousel: the git panel shows one project card at a time.
  // The index is clamped as a derivation (not an effect) so closing tabs can
  // never leave it out of bounds; zero tabs → null target → the panel's
  // "open a git repository" empty state. Outside eagle view this collapses to
  // the active tab, so non-eagle behavior is unchanged.
  const clampedEagleGitIndex = tabs.length === 0 ? 0 : Math.min(eagleGitIndex, tabs.length - 1);
  const gitTargetTab = eagleView ? (tabs[clampedEagleGitIndex] ?? null) : activeTab;
  const gitRepoPath = gitTargetTab ? (gitTargetTab.selectedRepoPath ?? gitTargetTab.projectPath) : undefined;

  // Entering eagle view starts the carousel on the currently active project.
  useEffect(() => {
    if (!eagleView) return;
    const ts = useWorkspaceStore.getState().tabs;
    const idx = ts.findIndex((t) => t.active);
    if (idx >= 0) setEagleGitIndex(idx);
  }, [eagleView]);

  // Swipe between carousel cards with wraparound. `getState()` keeps these
  // callbacks stable (mirrors switchToNextTab/switchToPrevTab semantics).
  const handleEagleGitPrev = useCallback(() => {
    setEagleGitIndex((i) => {
      const n = useWorkspaceStore.getState().tabs.length;
      return n === 0 ? 0 : (Math.min(i, n - 1) - 1 + n) % n;
    });
  }, []);

  const handleEagleGitNext = useCallback(() => {
    setEagleGitIndex((i) => {
      const n = useWorkspaceStore.getState().tabs.length;
      return n === 0 ? 0 : (Math.min(i, n - 1) + 1) % n;
    });
  }, []);

  // Trackpad two-finger horizontal swipe to switch project tabs
  const switchToNextTab = useCallback(() => {
    const idx = tabs.findIndex((t) => t.active);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) selectTab(next.id);
  }, [tabs, selectTab]);

  const switchToPrevTab = useCallback(() => {
    const idx = tabs.findIndex((t) => t.active);
    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (prev) selectTab(prev.id);
  }, [tabs, selectTab]);

  useSwipeNavigation({
    onSwipeLeft: switchToNextTab,
    onSwipeRight: switchToPrevTab,
    enabled: tabs.length >= 2,
  });

  // Git store for commit count and refresh
  const { commits, fetchCommits } = useGitStore();
  const [isRefreshingGit, setIsRefreshingGit] = useState(false);

  const handleRefreshGit = useCallback(async () => {
    if (!gitRepoPath) return;
    setIsRefreshingGit(true);
    try {
      await fetchCommits(gitRepoPath);
    } finally {
      setIsRefreshingGit(false);
    }
  }, [gitRepoPath, fetchCommits]);

  useEffect(() => {
    let cancelled = false;
    if (!gitRepoPath) {
      setCurrentBranch(undefined);
      return () => {};
    }
    getDeduplicatedCurrentBranch(gitRepoPath)
      .then((branch) => {
        if (!cancelled) setCurrentBranch(branch);
      })
      .catch((err) => {
        console.error("Failed to load current branch:", err);
        if (!cancelled) setCurrentBranch(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [gitRepoPath]);

  // Rehydrate multi-repo tabs after store rehydration
  useEffect(() => {
    rehydrateRepositories().catch((err) => {
      console.error("Failed to rehydrate repositories:", err);
    });
  }, [rehydrateRepositories]);

  // Auto-refresh repos on window focus (with 2s debounce)
  useEffect(() => {
    let lastRefresh = 0;
    const COOLDOWN_MS = 2000;

    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefresh < COOLDOWN_MS) return;
      lastRefresh = now;

      const tab = useWorkspaceStore.getState().tabs.find((t) => t.active);
      if (!tab) return;

      if (tab.workspaceType === "multi-repo") {
        invoke<RepositoryInfo[]>("detect_repositories", { path: tab.projectPath })
          .then((repos) => {
            useWorkspaceStore.getState().updateRepositories(tab.id, repos);
          })
          .catch((err) => console.error("Failed to refresh repos on focus:", err));
      }

      // Refresh branch for the active repo
      const repoPath = tab.selectedRepoPath ?? tab.projectPath;
      if (repoPath) {
        getDeduplicatedCurrentBranch(repoPath)
          .then(setCurrentBranch)
          .catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Derive state from active tab
  const activeTabSessionsLaunched = activeTab?.sessionsLaunched ?? false;
  const activeTabCounts = activeTab ? sessionCounts.get(activeTab.id) : undefined;
  const activeTabSlotCount = activeTabCounts?.slotCount ?? 0;
  const activeTabLaunchedCount = activeTabCounts?.launchedCount ?? 0;

  const handleStopAll = useCallback(async () => {
    if (!activeTab || isStoppingAll) return;
    setIsStoppingAll(true);
    try {
      const sessionStore = useSessionStore.getState();
      const projectSessions = sessionStore.getSessionsByProject(activeTab.projectPath);
      const results = await Promise.allSettled(projectSessions.map((s) => killSession(s.id)));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Failed to stop session:", result.reason);
        }
      }
      await sessionStore.removeSessionsForProject(activeTab.projectPath);
      setSessionsLaunched(activeTab.id, false);
      setSessionCounts((prev) => {
        const next = new Map(prev);
        next.set(activeTab.id, { slotCount: 0, launchedCount: 0 });
        return next;
      });
    } finally {
      setIsStoppingAll(false);
    }
  }, [activeTab, isStoppingAll, setSessionsLaunched]);

  // Cmd/Ctrl+T: add a new session slot in grid view
  const handleAddSessionShortcut = useCallback(() => {
    multiProjectRef.current?.addSessionToActiveProject();
  }, []);

  const handleToggleUtilityPanel = useCallback((panel: UtilityPanelKind) => {
    setUtilityPanel((prev) => (prev === panel ? null : panel));
  }, []);

  // Eagle view add-terminal dropdown: every open project tab is offered.
  // Picking one leaves eagle view and opens a normal pre-launch card in that
  // project, so the terminal is configured (name/branch/worktree/…) before
  // launching — the same flow as adding a session outside eagle view.
  const eagleProjects: EagleProjectOption[] = tabs
    .map((t) => ({
      tabId: t.id,
      name: t.name,
      color: projectColors.get(t.name) ?? projectColorFor(t.name),
      atMax: (sessionCounts.get(t.id)?.slotCount ?? 0) >= DEFAULT_SESSION_COUNT,
    }));

  const handleAddSessionToProject = useCallback(
    (tabId: string) => {
      setEagleView(false);
      selectTab(tabId);
      multiProjectRef.current?.addSessionInProject(tabId);
    },
    [selectTab],
  );

  // Sidebar Agents section: zoom into a terminal. In eagle view the eagle zoom
  // overlay is used (panes stay mounted); otherwise activate the project tab
  // and zoom its pane once the tab switch has committed to the DOM.
  const handleAgentNavigate = useCallback(
    (tabId: string, sessionId: number) => {
      selectTab(tabId);
      requestAnimationFrame(() => {
        multiProjectRef.current?.zoomSessionInProject(tabId, sessionId);
      });
    },
    [selectTab],
  );

  // Sidebar Agents section: kill one terminal. Normally routed through the
  // project's grid for full pane cleanup; if that grid isn't mounted (stale
  // session row), fall back to killing the PTY and store entries directly so
  // a confirmed kill never silently no-ops.
  const handleAgentKill = useCallback((tabId: string, sessionId: number) => {
    const handledByGrid = multiProjectRef.current?.killSessionInProject(tabId, sessionId) ?? false;
    if (!handledByGrid) {
      killSession(sessionId).catch(console.error);
      useSessionStore.getState().removeSession(sessionId);
      useWorkspaceStore.getState().removeSessionFromProject(tabId, sessionId);
    }
  }, []);

  const handleToggleSidebar = useCallback(() => setSidebarOpen((prev) => !prev), []);

  // Closing a project tab terminates every terminal running in it, so when the
  // tab has live sessions we confirm first. `getState()` (not the reactive
  // `tabs` closure) keeps this callback stable and always reads fresh counts.
  const handleCloseTab = useCallback(
    async (id: string) => {
      const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === id);
      const count = tab?.sessionIds.length ?? 0;
      if (count > 0) {
        const confirmed = await ask(
          `Close "${tab?.name}"? This will terminate ${count} running terminal${
            count === 1 ? "" : "s"
          } in this project.`,
          { title: "Close project", kind: "warning" },
        ).catch(() => false);
        if (!confirmed) return;
      }
      closeTab(id);
    },
    [closeTab],
  );

  // Ctrl/Cmd+2 always lands the panel on the Status tab when toggling open.
  // Manual tab switches while the panel is open are preserved until the next open.
  // Works in eagle view too, where the panel is a per-project carousel.
  const handleToggleGitPanel = useCallback(() => {
    setGitPanelOpen((prev) => {
      if (!prev) setGitPanelTab("status");
      return !prev;
    });
  }, []);

  useAppKeyboard({
    onAddSession: handleAddSessionShortcut,
    canAddSession: activeTabSessionsLaunched,
    onToggleSidebar: handleToggleSidebar,
    onToggleGitPanel: handleToggleGitPanel,
    onToggleEagleView: useCallback(() => setEagleView((v) => !v), []),
  });

  // Handler to enter grid view for the active project
  const handleEnterGridView = () => {
    if (activeTab) {
      setSessionsLaunched(activeTab.id, true);
    }
  };

  const handleSessionCountChange = useCallback(
    (tabId: string, slotCount: number, launchedCount: number) => {
      setSessionCounts((prev) => {
        const next = new Map(prev);
        next.set(tabId, { slotCount, launchedCount });
        return next;
      });
    },
    [],
  );

  const macTitleBarInset = isMac() && macTitleBarPadding ? `${MAC_TITLE_BAR_INSET_PX}px` : "0";

  return (
    <div
      className="flex h-screen w-screen flex-col bg-maestro-bg"
      style={{ ["--mac-title-bar-inset" as string]: macTitleBarInset }}
    >
      {/* Project tabs — full width at top (with window controls) */}
      <ProjectTabs
        tabs={tabs.map((t) => ({
          id: t.id,
          name: t.name,
          active: t.active,
          color: projectColors.get(t.name) ?? projectColorFor(t.name),
        }))}
        onSelectTab={selectTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleOpenProject}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        sidebarOpen={sidebarOpen}
        onReorderTab={reorderTabs}
        onMoveTab={moveTab}
      />

      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — below project tabs */}
        <Sidebar
          collapsed={!sidebarOpen}
          onCollapse={() => setSidebarOpen(false)}
          theme={theme}
          onToggleTheme={toggleTheme}
          launchedCount={activeTabLaunchedCount}
          isStoppingAll={isStoppingAll}
          onStopAll={handleStopAll}
          onAgentNavigate={handleAgentNavigate}
          onAgentKill={handleAgentKill}
        />

        {/* Right column: top bar + content + bottom bar */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top bar row - includes git panel header when open */}
          <div className="flex h-10 shrink-0 bg-maestro-bg">
            {/* TopBar takes flex-1 to fill available space */}
            <TopBar
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
              onToggleGitPanel={() => setGitPanelOpen((prev) => !prev)}
              gitPanelOpen={gitPanelOpen}
              hideWindowControls
              inGridView={activeTabSessionsLaunched}
              slotCount={activeTabSlotCount}
              maxSessions={DEFAULT_SESSION_COUNT}
              onAddSession={() => multiProjectRef.current?.addSessionToActiveProject()}
              eagleView={eagleView}
              onToggleEagleView={() => setEagleView((v) => !v)}
              eagleProjects={eagleProjects}
              onAddSessionToProject={handleAddSessionToProject}
              memoryPanelOpen={utilityPanel === "memory"}
              onToggleMemoryPanel={() => handleToggleUtilityPanel("memory")}
              processesPanelOpen={utilityPanel === "processes"}
              onToggleProcessesPanel={() => handleToggleUtilityPanel("processes")}
              notesPanelOpen={utilityPanel === "notes"}
              onToggleNotesPanel={() => handleToggleUtilityPanel("notes")}
            />

            {/* Git panel header - inline at same level as TopBar.
                In eagle view it describes the carousel-selected project. */}
            {gitPanelOpen && (
              <div
                className="flex h-10 shrink-0 items-center border-l border-maestro-border px-3 gap-2 bg-maestro-bg"
                style={{ width: rightPanelWidth }}
              >
                <GitFork size={14} className="text-maestro-muted" />
                {gitTargetTab?.workspaceType === "multi-repo" && gitTargetTab.selectedRepoPath && (
                  <span className="text-xs font-medium text-maestro-accent">
                    {
                      gitTargetTab.repositories.find(
                        (r) => r.path === gitTargetTab.selectedRepoPath,
                      )?.name
                    }
                  </span>
                )}
                <span className="text-sm font-medium text-maestro-text">
                  {GIT_PANEL_TITLES[gitPanelTab]}
                </span>
                {gitPanelTab === "commits" && commits.length > 0 && (
                  <span className="rounded-full bg-maestro-accent/15 px-1.5 py-px text-[10px] font-medium text-maestro-accent">
                    {commits.length}
                  </span>
                )}
                <div className="flex-1" />
                {gitRepoPath && (
                  <button
                    type="button"
                    onClick={handleRefreshGit}
                    disabled={isRefreshingGit}
                    className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
                    aria-label="Refresh commits"
                  >
                    <RefreshCw size={14} className={isRefreshingGit ? "animate-spin" : ""} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setGitPanelOpen(false)}
                  className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
                  aria-label="Close git panel"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Content area (main + optional git panel) */}
          <div className="flex flex-1 overflow-hidden">
            {/* Main content - MultiProjectView keeps all projects alive */}
            <main className="relative flex-1 overflow-hidden bg-maestro-bg">
              <MultiProjectView
                ref={multiProjectRef}
                onSessionCountChange={handleSessionCountChange}
                eagleView={eagleView}
              />
            </main>

            {/* Memory / Processes utility panel (optional right side) */}
            {utilityPanel && (
              <UtilityPanel
                panel={utilityPanel}
                width={rightPanelWidth}
                onResize={handleRightPanelResize}
                onClose={() => setUtilityPanel(null)}
              />
            )}

            {/* Git graph panel (optional right side). Stays mounted when
                closed (width 0 + inert) so its state survives toggling. In
                eagle view it becomes a carousel: one project card at a time,
                switched via the EagleProjectSwitcher strip — the git stores
                are singletons, so exactly one panel is ever mounted. */}
            <GitGraphPanel
              open={gitPanelOpen}
              onClose={() => setGitPanelOpen(false)}
              repoPath={gitRepoPath ?? null}
              currentBranch={currentBranch ?? null}
              repositories={gitTargetTab?.repositories ?? []}
              workspaceType={gitTargetTab?.workspaceType ?? "single-repo"}
              onRepoChange={(path) => gitTargetTab && setSelectedRepo(gitTargetTab.id, path)}
              activeTab={gitPanelTab}
              onActiveTabChange={setGitPanelTab}
              width={rightPanelWidth}
              onResize={handleRightPanelResize}
              eagleProjects={eagleView ? eagleProjects : undefined}
              eagleIndex={clampedEagleGitIndex}
              onEaglePrev={handleEagleGitPrev}
              onEagleNext={handleEagleGitNext}
            />
          </div>

          {/* Bottom action bar */}
          <div className="bg-maestro-bg">
            <BottomBar
              inGridView={activeTabSessionsLaunched}
              slotCount={activeTabSlotCount}
              launchedCount={activeTabLaunchedCount}
              onLaunchAll={() => {
                if (!activeTabSessionsLaunched && activeTab) {
                  // First enter grid view, then launch
                  handleEnterGridView();
                }
                multiProjectRef.current?.launchAllInActiveProject();
              }}
            />
          </div>
        </div>
      </div>

      {/* FDA Dialog for macOS TCC-protected paths */}
      {showFDADialog && (
        <FDADialog
          path={fdaPath}
          onDismiss={dismissFDADialog}
          onDismissPermanently={dismissFDADialogPermanently}
          onRetry={retryAfterFDAGrant}
        />
      )}

      <UpdateNotification />
    </div>
  );
}

export default App;
