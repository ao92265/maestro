import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitFork, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAC_TITLE_BAR_INSET_PX, useMacTitleBarPadding } from "@/hooks/useMacTitleBarPadding";
import { getDeduplicatedCurrentBranch, invalidateCurrentBranchCache } from "@/lib/git";
import { isMac } from "@/lib/platform";
import { projectColorFor } from "@/lib/projectColor";
import { initSamuraiSpawnListener, stopSamuraiSpawnListener } from "@/lib/spawnSession";
import { killSession } from "@/lib/terminal";
import { useOpenProject } from "@/lib/useOpenProject";
import { useProjectColors } from "@/lib/useProjectColors";
import { useFDAStore } from "@/stores/useFDAStore";
import { usePlanStore } from "@/stores/usePlanStore";
import {
  initContextUsageListener,
  initSamuraiSupervisorListener,
  type SessionConfig,
  stopContextUsageListener,
  stopSamuraiSupervisorListener,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useStandupStore } from "@/stores/useStandupStore";
import { type RepositoryInfo, useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { BoardView } from "./components/board/BoardView";
import { GitGraphPanel } from "./components/git/GitGraphPanel";
import type { GitPanelTab } from "./components/git/GitPanelTabs";
import { BottomBar } from "./components/shared/BottomBar";
import { EagleProjectPickerModal } from "./components/shared/EagleProjectPickerModal";
import { FDADialog } from "./components/shared/FDADialog";
import {
  MultiProjectView,
  type MultiProjectViewHandle,
} from "./components/shared/MultiProjectView";
import { NotificationToasts } from "./components/shared/NotificationToasts";
import {
  loadRightPanelWidth,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "./components/shared/PanelResizeHandle";
import { ProjectTabs } from "./components/shared/ProjectTabs";
import { QuickOpenPalette } from "./components/shared/QuickOpenPalette";
import { type EagleProjectOption, TopBar } from "./components/shared/TopBar";
import { UtilityPanel, type UtilityPanelKind } from "./components/shared/UtilityPanel";
import {
  loadSavedSidebarTab,
  Sidebar,
  type SidebarTabId,
  saveSidebarTab,
  sidebarTabShortcutTransition,
} from "./components/sidebar/Sidebar";
import { MAX_SESSIONS } from "./components/terminal/splitTree";
import { FirstRunTour } from "./components/tour/FirstRunTour";
import { UpdateNotification } from "./components/update/UpdateNotification";
import { useAppKeyboard } from "./hooks/useAppKeyboard";
import { useBandPolling } from "./hooks/useBandPolling";
import { useLaunchHandoff } from "./hooks/useLaunchHandoff";
import { useQuickOpenItems } from "./hooks/useQuickOpenItems";
import { useSwipeNavigation } from "./hooks/useSwipeNavigation";
import { useVanguardSnapshot } from "./hooks/useVanguardSnapshot";
import { HEALTH_CHECK_INTERVAL_MS } from "./lib/healthRules";
import type { QuickOpenItem } from "./lib/quickOpen";
import { initActivityListener, stopActivityListener } from "./stores/useActivityStore";
import { useActStore } from "./stores/useActStore";
import { initAgentListener, stopAgentListener } from "./stores/useAgentStore";
import { useGitHubStore } from "./stores/useGitHubStore";
import {
  useGitHubWatchdogStore,
  WATCHDOG_ISSUE_SEARCH,
  WATCHDOG_PR_SEARCH,
  watchedProjectsFromTabs,
} from "./stores/useGitHubWatchdogStore";
import { useGitStore } from "./stores/useGitStore";
import { useHealthStore } from "./stores/useHealthStore";
import { useSurfaceStore } from "./stores/useSurfaceStore";
import { useTerminalSettingsStore } from "./stores/useTerminalSettingsStore";
import { useUpdateStore } from "./stores/useUpdateStore";

/**
 * Landscape graph, loaded on demand: it pulls in React Flow, which would
 * otherwise sit in the entry chunk even though the view only renders when
 * `landscapeView` is on. Already conditionally rendered, so the boundary is
 * just the import.
 */
const LandscapeView = lazy(() =>
  import("./components/landscape/LandscapeView").then((m) => ({ default: m.LandscapeView })),
);

/**
 * Full-screen workflow editor, loaded on demand for the same reason as
 * LandscapeView above — its own React Flow canvas, opened from the Launch
 * tab via `useSurfaceStore` rather than a prop passed down.
 */
const WorkflowsView = lazy(() =>
  import("./components/workflows/WorkflowsView").then((m) => ({ default: m.WorkflowsView })),
);

/**
 * Home decision queue, now one keystroke away (Cmd/Ctrl+1) rather than the
 * surface the app opens on: that is the Board. Lazy like the other
 * full-screen overlays, and unlike the Board, which would flash a Suspense
 * fallback on every launch.
 */
const HomeView = lazy(() =>
  import("./components/home/HomeView").then((m) => ({ default: m.HomeView })),
);

/**
 * Factory — the ACT lane: hand a spec over, watch runs, unblock gates. Same
 * lazy overlay shell as the rest.
 */
const FactoryView = lazy(() =>
  import("./components/factory/FactoryView").then((m) => ({ default: m.FactoryView })),
);

/**
 * Orchestrator — the goal box, session scope and safe-mode proposal queue.
 * Same lazy overlay shell as the rest.
 */
const OrchestratorView = lazy(() =>
  import("./components/orchestrator/OrchestratorView").then((m) => ({
    default: m.OrchestratorView,
  })),
);

/**
 * Pulse — today's timeline, the flow score and the metrics pulse. Same lazy
 * overlay shell as the rest; its git and transcript scans only run while it
 * is on screen.
 */
const PulseView = lazy(() =>
  import("./components/pulse/PulseView").then((m) => ({ default: m.PulseView })),
);

/** Header title for each git-panel tab. */
const GIT_PANEL_TITLES: Record<GitPanelTab, string> = {
  commits: "Commits",
  branches: "Branches",
  status: "Status",
  prs: "Pull Requests",
  issues: "Issues",
  discussions: "Discussions",
};

/** Stable empty list so the closed palette's selector never changes identity. */
const EMPTY_SESSIONS: SessionConfig[] = [];

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
  // Active left-sidebar tab — lifted out of Sidebar so Alt+1-3 can drive it.
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>(loadSavedSidebarTab);
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
  // What you are looking at. One store, so two full-screen surfaces cannot be
  // open together and no caller can change the grid underneath one of them.
  // The old per-surface booleans are derived below purely so the render tree
  // and the TopBar props stay as they were.
  const surfaceBase = useSurfaceStore((s) => s.base);
  const surfaceOverlay = useSurfaceStore((s) => s.overlay);
  // Eagle view: one flat grid of every project's terminals at once
  const eagleView = useSurfaceStore((s) => s.eagle);
  // Eagle view Cmd/Ctrl+T: arrow-navigable project picker for the new terminal.
  const [eagleAddPickerOpen, setEagleAddPickerOpen] = useState(false);
  // Cmd/Ctrl+P quick-open palette across sessions and worktrees.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  // Only subscribe to the session list while the palette is up. The store
  // replaces the array on every status event, so an unconditional subscription
  // would re-render App (and the whole terminal subtree) all day for data
  // nothing else here reads.
  const quickOpenSessions = useSessionStore((s) => (quickOpenOpen ? s.sessions : EMPTY_SESSIONS));
  // Eagle view git carousel: index of the project whose git panel card shows.
  const [eagleGitIndex, setEagleGitIndex] = useState(0);
  // Landscape view: every project, terminal and subagent on one graph. Rendered
  // over the terminals rather than instead of them, so nothing is torn down.
  // It is an overlay like the rest now: being outside the union is exactly what
  // let it sit open underneath the workflow editor.
  const landscapeView = surfaceOverlay === "landscape";
  // Full-screen workflow editor (Launch tab → "Open workflow editor").
  const workflowsViewOpen = surfaceOverlay === "workflows";
  // Board layer: the shell the app opens on. It sits at z-45, under every
  // overlay that follows, so an overlay hides it rather than replacing it.
  const boardViewOpen = surfaceBase === "board";
  // The remaining full-screen overlays. Exactly one of these can be true,
  // by construction rather than by every handler remembering to close the
  // others.
  const homeViewOpen = surfaceOverlay === "home";
  const factoryViewOpen = surfaceOverlay === "factory";
  const orchestratorViewOpen = surfaceOverlay === "orchestrator";
  const pulseViewOpen = surfaceOverlay === "pulse";
  // Returning to the base surface. Every overlay's own close button wants the
  // same thing, so they all get the same function.
  const closeOverlay = useSurfaceStore((s) => s.closeOverlay);
  const closeWorkflowsView = closeOverlay;
  const closeHomeView = closeOverlay;
  const closeFactoryView = closeOverlay;
  const closeOrchestratorView = closeOverlay;
  const closePulseView = closeOverlay;
  // "Show me the terminals themselves." Every route that selects, adds or
  // zooms a terminal must call this FIRST: it drops the overlay AND the Board,
  // which is the step fifteen call sites each forgot a different part of.
  const showGrid = useSurfaceStore((s) => s.showGrid);
  // Marks the landscape button while a terminal anywhere is blocked on you.
  const needsInputAnywhere = useSessionStore((s) =>
    s.sessions.some((session) => session.status === "NeedsInput"),
  );
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

  // Initialize activity event listener (batched claude-events from the transcript watcher)
  useEffect(() => {
    initActivityListener().catch((err) => {
      console.error("Failed to initialize activity listener:", err);
    });
    return () => {
      stopActivityListener();
    };
  }, []);

  // Initialize context usage listener (per-session context-window % from
  // ContextUsageUpdate events, surfaced on the session store)
  useEffect(() => {
    initContextUsageListener().catch((err) => {
      console.error("Failed to initialize context usage listener:", err);
    });
    return () => {
      stopContextUsageListener();
    };
  }, []);

  // Samurai supervisor listener: tracks generation/state for the badges
  // (issue #46), flips DEAD sessions (silent-death watchdog, issue #44) to
  // Error chrome + attention, and flags supervised sessions on allowance
  // threshold crossings (issue #45).
  useEffect(() => {
    initSamuraiSupervisorListener().catch((err) => {
      console.error("Failed to initialize samurai supervisor listener:", err);
    });
    return () => {
      stopSamuraiSupervisorListener();
    };
  }, []);

  // Samurai successor spawns (issue #55): after killing gen-N the backend
  // emits samurai-spawn-successor; this listener queues the gen-N+1 launch
  // through the existing pending-launch flow (same path as History-tab
  // recoveries) and the grid registers it under supervision.
  useEffect(() => {
    initSamuraiSpawnListener().catch((err) => {
      console.error("Failed to initialize samurai spawn listener:", err);
    });
    return () => {
      stopSamuraiSpawnListener();
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

  // GitHub watchdog: receive poll snapshots from the Rust background task.
  const initWatchdogListeners = useGitHubWatchdogStore((s) => s.initListeners);
  useEffect(() => {
    const unlistenPromise = initWatchdogListeners().catch((err) => {
      console.error("Failed to initialize GitHub watchdog listeners:", err);
      return () => {};
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [initWatchdogListeners]);

  // GitHub watchdog: keep the Rust poller's project set in sync with the
  // open workspace tabs (deduplicated by repo path — see helper docs).
  // Serialized so active-tab flips (which also mutate `tabs`) don't
  // re-invoke the command; the backend additionally ignores identical sets.
  const watchedProjectsJson = useMemo(() => JSON.stringify(watchedProjectsFromTabs(tabs)), [tabs]);
  useEffect(() => {
    void useGitHubWatchdogStore.getState().syncProjects(JSON.parse(watchedProjectsJson));
  }, [watchedProjectsJson]);

  // Health checker: rule-based memory/process checks on a quiet interval.
  // Independent of the open tabs — it scans every project with saved memory
  // and the whole watched process table — so nothing here restarts the
  // interval or resets the CPU/RAM streaks.
  // The first run is delayed rather than fired on mount: it enumerates the
  // whole process table (and shells out for listening ports), which would
  // compete with first paint and terminal spawn. The badge still populates
  // long before the first interval tick, and first-run suppression via
  // `baselineKeys` keeps the toast behaviour identical whenever it lands.
  useEffect(() => {
    const runCheck = () => void useHealthStore.getState().runCheck();
    const firstRun = setTimeout(runCheck, 30_000);
    const interval = setInterval(runCheck, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(firstRun);
      clearInterval(interval);
    };
  }, []);

  // Daily-AI scheduler: a minute tick that fires the standup report AND the
  // cross-project plan once the configured local time has passed (at most
  // once per day each; the stores gate on lastRunDate and skip artifacts
  // already on disk). Both ride the one schedule setting, which lives in the
  // standup store. Besides the minute tick, a tick fires when either store's
  // persisted settings finish hydrating and whenever the set of open repo
  // paths changes — the settings and tabs both load async from disk after
  // mount, so these extra ticks are what let a run missed while the app was
  // closed catch up right at startup instead of a minute later.
  const maybeRunScheduledStandup = useStandupStore((s) => s.maybeRunScheduled);
  const maybeRunScheduledPlan = usePlanStore((s) => s.maybeRunScheduled);
  // Stable projection of the open repo paths (newline-joined so string
  // equality skips re-renders): tab switches flip flags and rebuild the tabs
  // array every time, and depending on `tabs` directly would tear down and
  // recreate the interval on each switch. This only changes when a path is
  // actually added/removed — which is exactly when a fresh tick is wanted.
  const standupRepoPathsKey = useWorkspaceStore((s) =>
    s.tabs.map((t) => t.selectedRepoPath ?? t.projectPath).join("\n"),
  );
  useEffect(() => {
    const repoPaths = standupRepoPathsKey === "" ? [] : standupRepoPathsKey.split("\n");
    const tick = () => {
      void maybeRunScheduledStandup(repoPaths);
      void maybeRunScheduledPlan(repoPaths);
    };
    tick();
    const unsubStandupHydration = useStandupStore.persist.onFinishHydration(tick);
    const unsubPlanHydration = usePlanStore.persist.onFinishHydration(tick);
    const interval = setInterval(tick, 60_000);
    return () => {
      unsubStandupHydration();
      unsubPlanHydration();
      clearInterval(interval);
    };
  }, [maybeRunScheduledStandup, maybeRunScheduledPlan, standupRepoPathsKey]);

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
  const gitRepoPath = gitTargetTab
    ? (gitTargetTab.selectedRepoPath ?? gitTargetTab.projectPath)
    : undefined;

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

  // Git store for commit count and refresh. Granular selectors, not the whole
  // store: a selector-less subscription re-renders App on every git `set()`,
  // and App has no memo barrier in front of the terminals.
  const commitCount = useGitStore((s) => s.commits.length);
  const fetchCommits = useGitStore((s) => s.fetchCommits);
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

      // Refresh branch for the active repo. The branch may have changed while
      // the window was away, so drop the short-lived cache first — this path
      // exists precisely to re-read git.
      const repoPath = tab.selectedRepoPath ?? tab.projectPath;
      if (repoPath) {
        invalidateCurrentBranchCache(repoPath);
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

  // Cmd/Ctrl+T: add a new terminal. In eagle view this opens the project
  // picker modal; otherwise the active project's grid gets a new slot (the
  // grid keeps the zoom-in view and zooms the new slot when one is zoomed).
  const handleAddSessionShortcut = useCallback(() => {
    if (eagleView) {
      setEagleAddPickerOpen(true);
      return;
    }
    // Show the terminals first. On a cold start the Board covers the idle
    // landing view (the big "+" that tells a new user what to do), so adding
    // a session from behind it produced a card nobody could see.
    useSurfaceStore.getState().showGrid();
    multiProjectRef.current?.addSessionToActiveProject();
  }, [eagleView]);

  // Leaving eagle view always drops the picker.
  useEffect(() => {
    if (!eagleView) setEagleAddPickerOpen(false);
  }, [eagleView]);

  const handleToggleUtilityPanel = useCallback((panel: UtilityPanelKind) => {
    setUtilityPanel((prev) => (prev === panel ? null : panel));
  }, []);

  // Eagle view add-terminal dropdown: every open project tab is offered.
  // Picking one leaves eagle view and opens a normal pre-launch card in that
  // project, so the terminal is configured (name/branch/worktree/…) before
  // launching — the same flow as adding a session outside eagle view.
  const eagleProjects: EagleProjectOption[] = tabs.map((t) => ({
    tabId: t.id,
    name: t.name,
    color: projectColors.get(t.name) ?? projectColorFor(t.name),
    atMax: (sessionCounts.get(t.id)?.slotCount ?? 0) >= MAX_SESSIONS,
  }));

  /**
   * The one route to a terminal. Every caller that wants a terminal on screen
   * goes through here: it shows the grid FIRST (which drops both the overlay
   * and the Board), then selects, then zooms once the tab switch has committed
   * to the DOM.
   *
   * Fifteen call sites used to inline some subset of this and each forgot a
   * different part, so the selection landed correctly underneath something the
   * user was still looking at and the click read as dead.
   */
  const navigateToTerminal = useCallback(
    (tabId: string, sessionId?: number) => {
      showGrid();
      selectTab(tabId);
      if (sessionId === undefined) return;
      requestAnimationFrame(() => {
        multiProjectRef.current?.zoomSessionInProject(tabId, sessionId);
      });
    },
    [selectTab, showGrid],
  );

  /**
   * Jump between terminals WITHOUT rearranging the shell: the footer navigator
   * and the sidebar Agents list both mean "put me in that terminal", not "take
   * me to that project". `navigateToSession` keeps the user's eagle view and
   * their grid-versus-zoom context, which a plain zoom would throw away.
   */
  const jumpToTerminal = useCallback((tabId: string, sessionId: number) => {
    useSurfaceStore.getState().showTerminals();
    multiProjectRef.current?.navigateToSession(tabId, sessionId);
  }, []);

  /** The one route to a NEW terminal, for the same reason. */
  const addTerminalInProject = useCallback(
    (tabId: string) => {
      showGrid();
      selectTab(tabId);
      multiProjectRef.current?.addSessionInProject(tabId);
    },
    [selectTab, showGrid],
  );

  const handleAddSessionToProject = addTerminalInProject;

  // Sidebar History tab queued a recovery launch: show the project's grid so
  // it mounts and consumes the pending launch. Used to leave eagle view only,
  // which launched the recovered session behind whatever was covering it.
  const handleHistoryLaunch = useCallback(
    (tabId: string) => {
      navigateToTerminal(tabId);
    },
    [navigateToTerminal],
  );

  // Sidebar Agents section: jump to a terminal. In eagle view the eagle zoom
  // overlay is used (panes stay mounted); otherwise the pane is focused or
  // zoomed to match whatever the user was already looking at.
  const handleAgentNavigate = jumpToTerminal;

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

  // Landscape view: clicking a node leaves the graph for that project (and,
  // when the node is a terminal, zooms it) — the same route the sidebar's
  // Agents section takes.
  const handleLandscapeNavigate = navigateToTerminal;

  // Home view: clicking a band row leaves the queue for that terminal — the
  // same route the landscape takes, plus closing the Home overlay itself.
  const handleHomeNavigate = navigateToTerminal;

  // Board: clicking a card leaves the board for the terminal it describes,
  // the same rAF handshake Home uses. The board layer closes in the same
  // commit as the tab selection, so the zoom lands on a visible grid.
  const handleBoardNavigate = navigateToTerminal;

  // Resuming a handoff from the Board: same flow as Home's, and the Board
  // gets out of the way so the launching terminal is the thing on screen.
  const handleBoardLaunchHandoff = useLaunchHandoff(handleBoardNavigate);

  // A gated run is unblocked in the Factory, so the card hands over to it.
  const handleBoardOpenRun = useCallback((runId: string) => {
    void useActStore.getState().openDetail(runId);
    useSurfaceStore.getState().openOverlay("factory");
  }, []);

  // Adopting an outside session's project from the Board peek: open the tab,
  // never a second agent. Resuming the work itself stays with the Suggested
  // handoff flow once the outside session stops. Same FDA gate and
  // open-if-missing dance as useLaunchHandoff, minus the launch.
  const handleBoardOpenProject = useCallback(
    (dir: string) => {
      void useFDAStore.getState().requireAccess(dir, async () => {
        const ws = useWorkspaceStore.getState();
        if (!ws.getTabByPath(dir)) await ws.openProject(dir);
        const tab = useWorkspaceStore.getState().getTabByPath(dir);
        if (!tab) {
          console.error("Board open project: no tab after openProject", dir);
          return;
        }
        handleBoardNavigate(tab.id);
      });
    },
    [handleBoardNavigate],
  );

  // Cmd/Ctrl+E and the TopBar segments both land here. The Board is a layer,
  // never a replacement: closing it reveals the grid that was mounted all
  // along, so there is nothing to tear down or rebuild either way.
  const handleSetBoardView = useCallback((open: boolean) => {
    // A two-position selector, so each segment names the surface it shows.
    // Setting the Board flag alone used to open the Board UNDERNEATH whatever
    // overlay was up, and "Grid" closed a Board nobody could see: both
    // segments looked dead from Home.
    if (open) useSurfaceStore.getState().showBoard();
    else useSurfaceStore.getState().showGrid();
  }, []);

  // Cmd/Ctrl+E. Under an overlay the visible meaning of the keystroke is
  // "show me the Board" rather than "flip a bit I cannot see", which the store
  // now owns for every caller.
  const handleToggleBoardView = useCallback(() => {
    useSurfaceStore.getState().toggleBoard();
  }, []);

  // The full-screen overlays are never open together: opening Home or the
  // Factory closes every other overlay,
  // Every overlay toggle is now the same one-liner: the store holds a single
  // overlay slot, so "close the other five" is not something a handler can
  // forget to do.
  const handleToggleHomeView = useCallback(() => {
    useSurfaceStore.getState().toggleOverlay("home");
  }, []);

  const quickOpenItems = useQuickOpenItems(quickOpenOpen, quickOpenSessions, tabs);

  const handleQuickOpenPick = useCallback(
    (item: QuickOpenItem) => {
      setQuickOpenOpen(false);
      // A worktree with no live session has no terminal to zoom; surfacing its
      // project is the most we can honestly do. Either way this goes through
      // the one terminal route, which used to close five overlays by hand and
      // still leave the Board covering every result.
      const { sessionId } = item;
      navigateToTerminal(item.tabId, sessionId ?? undefined);
    },
    [navigateToTerminal],
  );

  const handleToggleFactoryView = useCallback(() => {
    useSurfaceStore.getState().toggleOverlay("factory");
  }, []);

  const handleToggleOrchestratorView = useCallback(() => {
    useSurfaceStore.getState().toggleOverlay("orchestrator");
  }, []);

  const handleTogglePulseView = useCallback(() => {
    useSurfaceStore.getState().toggleOverlay("pulse");
  }, []);

  // The effect that used to force overlay exclusivity is gone: a single
  // overlay slot cannot hold two surfaces, so there is no state to reconcile
  // after the fact. It also never covered Landscape against Workflows, which
  // is how those two ended up open together.

  // Band data (handoffs, PR polls, ACT) refreshes app-wide, and every change
  // mirrors to the Vanguard snapshot file the launchd digest reads.
  useBandPolling();
  useVanguardSnapshot();

  const handleSelectSidebarTab = useCallback((tab: SidebarTabId) => {
    setSidebarTab(tab);
    // Extensions (infra) has no strip slot of its own — it's a transient
    // surface reached via the TopBar's More menu (or the transient pill
    // that appears while it's active), and "infra" no longer validates in
    // loadSavedSidebarTab. Persisting it would silently reset to General on
    // the next launch, so skip the write for it and keep it for real tabs.
    if (tab !== "infra") saveSidebarTab(tab);
  }, []);

  // TopBar's More menu → Extensions: the Infra tab (MCP servers, plugins,
  // skills) no longer has its own strip button, but its content still
  // renders when selected — this is the fallback route to it.
  const handleOpenExtensions = useCallback(() => {
    setSidebarOpen(true);
    handleSelectSidebarTab("infra");
  }, [handleSelectSidebarTab]);

  // TopBar's More menu → Workflows: the full-screen workflow editor is a
  // standalone store-driven overlay (see useSurfaceStore) — its only
  // trigger used to be a button inside the now-cut Launch panel, but the
  // overlay itself never depended on that panel being open.
  const handleOpenWorkflows = useCallback(() => {
    useSurfaceStore.getState().openOverlay("workflows");
  }, []);

  // Alt+1-3: open the sidebar on tab N; pressing the active tab's shortcut
  // again closes the sidebar (per-tab toggle, no separate pane toggle).
  const handleSidebarTabShortcut = useCallback(
    (index: number) => {
      const next = sidebarTabShortcutTransition(sidebarOpen, sidebarTab, index);
      if (!next) return;
      setSidebarOpen(next.open);
      if (next.open && next.tab !== sidebarTab) {
        handleSelectSidebarTab(next.tab);
      }
    },
    [sidebarOpen, sidebarTab, handleSelectSidebarTab],
  );

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

  // GitHub watchdog badge click: land on the git panel's PRs/Issues tab with
  // the watchdog's search filter, in the project that has matching items
  // (preferring the active project). Reuses the git-panel store fetches; the
  // in-flight token guard absorbs the duplicate fetch GitGraphPanel fires.
  const handleWatchdogNavigate = useCallback(
    (kind: "prs" | "issues") => {
      const watchdogProjects = useGitHubWatchdogStore.getState().projects;
      const wsTabs = useWorkspaceStore.getState().tabs;
      const pick = kind === "prs" ? "reviewRequests" : "assignedIssues";
      const withItems = watchdogProjects.filter((p) => p[pick].length > 0);
      const activeWsTab = wsTabs.find((t) => t.active);
      const activeRepo = activeWsTab
        ? (activeWsTab.selectedRepoPath ?? activeWsTab.projectPath)
        : null;
      const target = withItems.find((p) => p.repoPath === activeRepo) ?? withItems[0] ?? null;

      if (target) {
        const targetTab = wsTabs.find(
          (t) => (t.selectedRepoPath ?? t.projectPath) === target.repoPath,
        );
        if (targetTab && !targetTab.active) selectTab(targetTab.id);
      }
      // The git panel targets the active tab outside eagle view, so leave
      // eagle. It renders beside the shell rather than under it, so there is
      // no reason to dismiss the Board or an overlay the user is reading.
      if (useSurfaceStore.getState().eagle) useSurfaceStore.getState().showGrid();

      const repoPath = target?.repoPath ?? activeRepo;
      if (repoPath) {
        if (kind === "prs") {
          void useGitHubStore.getState().fetchPullRequests(repoPath, "open", WATCHDOG_PR_SEARCH);
        } else {
          void useGitHubStore.getState().fetchIssues(repoPath, "open", WATCHDOG_ISSUE_SEARCH);
        }
      }
      setGitPanelTab(kind);
      setGitPanelOpen(true);
    },
    [selectTab],
  );

  useAppKeyboard({
    onAddSession: handleAddSessionShortcut,
    // Eagle view: Cmd/Ctrl+T opens the project picker instead of adding
    // directly, so it only needs at least one open project.
    // A project being open is the only precondition. This used to require a
    // session to ALREADY be running, so the shortcut the first-run tour
    // advertises did nothing on a fresh install.
    canAddSession: tabs.length > 0,
    onSidebarTab: handleSidebarTabShortcut,
    onToggleGitPanel: handleToggleGitPanel,
    onToggleUtilityPanel: handleToggleUtilityPanel,
    onToggleEagleView: useCallback(() => useSurfaceStore.getState().toggleEagle(), []),
    onToggleBoardView: handleToggleBoardView,
    onToggleLandscapeView: useCallback(
      () => useSurfaceStore.getState().toggleOverlay("landscape"),
      [],
    ),
    onToggleHomeView: handleToggleHomeView,
    onToggleFactoryView: handleToggleFactoryView,
    onToggleOrchestratorView: handleToggleOrchestratorView,
    onTogglePulseView: handleTogglePulseView,
    onToggleQuickOpen: useCallback(() => setQuickOpenOpen((v) => !v), []),
    onNextProject: switchToNextTab,
    onPrevProject: switchToPrevTab,
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
          activeTab={sidebarTab}
          onSelectTab={handleSelectSidebarTab}
          theme={theme}
          onToggleTheme={toggleTheme}
          launchedCount={activeTabLaunchedCount}
          isStoppingAll={isStoppingAll}
          onStopAll={handleStopAll}
          onAgentNavigate={handleAgentNavigate}
          onAgentKill={handleAgentKill}
          onHistoryLaunch={handleHistoryLaunch}
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
              slotCount={activeTabSlotCount}
              maxSessions={MAX_SESSIONS}
              onAddSession={handleAddSessionShortcut}
              hasProject={tabs.length > 0}
              eagleView={eagleView}
              onToggleEagleView={() => useSurfaceStore.getState().toggleEagle()}
              eagleProjects={eagleProjects}
              onAddSessionToProject={handleAddSessionToProject}
              landscapeView={landscapeView}
              onToggleLandscapeView={() => useSurfaceStore.getState().toggleOverlay("landscape")}
              landscapeAttention={needsInputAnywhere}
              boardViewOpen={boardViewOpen}
              onSetBoardView={handleSetBoardView}
              homeViewOpen={homeViewOpen}
              onToggleHomeView={handleToggleHomeView}
              factoryViewOpen={factoryViewOpen}
              onToggleFactoryView={handleToggleFactoryView}
              orchestratorViewOpen={orchestratorViewOpen}
              onToggleOrchestratorView={handleToggleOrchestratorView}
              pulseViewOpen={pulseViewOpen}
              onTogglePulseView={handleTogglePulseView}
              homeAttention={needsInputAnywhere}
              onToggleMemoryPanel={() => handleToggleUtilityPanel("memory")}
              processesPanelOpen={utilityPanel === "processes"}
              onToggleProcessesPanel={() => handleToggleUtilityPanel("processes")}
              aiPanelOpen={utilityPanel === "ai"}
              onToggleAiPanel={() => handleToggleUtilityPanel("ai")}
              onWatchdogNavigate={handleWatchdogNavigate}
              onOpenExtensions={handleOpenExtensions}
              onOpenWorkflows={handleOpenWorkflows}
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
                {gitPanelTab === "commits" && commitCount > 0 && (
                  <span className="rounded-full bg-maestro-accent/15 px-1.5 py-px text-[10px] font-medium text-maestro-accent">
                    {commitCount}
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

              {/* The Board, at z-45: above the zoomed grid pane (z-40) and
                  below every overlay after it (z-50), which is why the Board
                  needs no entry in the overlay-exclusivity rules. Open by
                  default (BOARD_DEFAULT_OPEN), and a layer like the rest, so
                  the terminals underneath keep running while it is up. */}
              {boardViewOpen && (
                <BoardView
                  onNavigateSession={handleBoardNavigate}
                  onOpenRun={handleBoardOpenRun}
                  onLaunchHandoff={handleBoardLaunchHandoff}
                  onOpenPr={(url) =>
                    void openUrl(url).catch((err) => console.error("Failed to open PR:", err))
                  }
                  onShowGrid={showGrid}
                  onOpenProject={handleBoardOpenProject}
                  // Any overlay at all, Pulse included: it used to be left out,
                  // so j/k still moved a hidden Board selection and Enter could
                  // launch something off screen.
                  overlayOpen={surfaceOverlay !== null}
                />
              )}

              {/* Landscape graph — an overlay, never a replacement: unmounting
                  MultiProjectView would tear down every live terminal. */}
              {landscapeView && (
                <Suspense
                  fallback={
                    /* z-50 like the landscape itself: the zoomed eagle pane is
                       z-40, and the fallback must cover it too. */
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <LandscapeView onNavigate={handleLandscapeNavigate} onClose={closeOverlay} />
                </Suspense>
              )}

              {/* Workflow editor — an overlay, same shell as the landscape
                  graph above (both z-50; not expected to be open together). */}
              {workflowsViewOpen && (
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <WorkflowsView onClose={closeWorkflowsView} />
                </Suspense>
              )}

              {/* Home decision queue — same overlay shell as the two above;
                  open by default so the day starts on what is blocked on you. */}
              {homeViewOpen && (
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <HomeView onNavigate={handleHomeNavigate} onClose={closeHomeView} />
                </Suspense>
              )}

              {/* Factory — the ACT lane, same overlay shell. */}
              {factoryViewOpen && (
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <FactoryView onClose={closeFactoryView} />
                </Suspense>
              )}

              {/* Orchestrator — the goal box + proposal queue, same overlay shell. */}
              {orchestratorViewOpen && (
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <OrchestratorView onClose={closeOrchestratorView} />
                </Suspense>
              )}

              {/* Pulse — how the day is going, same overlay shell. */}
              {pulseViewOpen && (
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <PulseView onClose={closePulseView} />
                </Suspense>
              )}
            </main>

            {/* Memory / Processes utility panel (optional right side) */}
            {utilityPanel && (
              <UtilityPanel
                panel={utilityPanel}
                width={rightPanelWidth}
                onResize={handleRightPanelResize}
                onClose={() => setUtilityPanel(null)}
                onNavigateToSession={handleAgentNavigate}
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
              slotCount={activeTabSlotCount}
              launchedCount={activeTabLaunchedCount}
              onLaunchAll={() => {
                if (!activeTabSessionsLaunched && activeTab) {
                  // First enter grid view, then launch
                  handleEnterGridView();
                }
                // Launching into a grid hidden behind the Board (or any
                // overlay) would look like the button did nothing.
                showGrid();
                multiProjectRef.current?.launchAllInActiveProject();
              }}
              onNavigateToSession={jumpToTerminal}
            />
          </div>
        </div>
      </div>

      {/* Cmd/Ctrl+P: fuzzy jump to any session or worktree */}
      {quickOpenOpen && (
        <QuickOpenPalette
          items={quickOpenItems}
          onPick={handleQuickOpenPick}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}

      {/* Eagle view Cmd/Ctrl+T: pick which project gets the new terminal */}
      {eagleAddPickerOpen && (
        <EagleProjectPickerModal
          projects={eagleProjects}
          onPick={(tabId) => {
            setEagleAddPickerOpen(false);
            handleAddSessionToProject(tabId);
          }}
          onClose={() => setEagleAddPickerOpen(false)}
        />
      )}

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
      <NotificationToasts />

      {/* First-run tour — at the root, not inside <main>, so its backdrop
          dims the whole window (TopBar and sidebar included) and the dialog
          is as modal as it claims to be. */}
      <FirstRunTour />
    </div>
  );
}

export default App;
