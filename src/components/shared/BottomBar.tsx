import { useEffect } from "react";
import { Play, UserRound } from "lucide-react";
import { UsageBar } from "./UsageBar";
import { SystemMetrics } from "./SystemMetrics";
import { TerminalNavigator } from "./TerminalNavigator";
import { useClaudeAccountStore } from "@/stores/useClaudeAccountStore";

interface BottomBarProps {
  /** Whether in the grid view (project selected and launched) */
  inGridView: boolean;
  /** Number of total slots (pre-launch + launched) */
  slotCount: number;
  /** Number of actually running sessions */
  launchedCount: number;
  onLaunchAll: () => void;
  /** Footer navigator: bring the given session in front of the user. */
  onNavigateToSession: (tabId: string, sessionId: number) => void;
}

export function BottomBar({
  inGridView,
  slotCount,
  launchedCount,
  onLaunchAll,
  onNavigateToSession,
}: BottomBarProps) {
  const hasUnlaunchedSlots = slotCount > launchedCount;
  const unlaunchedCount = slotCount - launchedCount;
  const account = useClaudeAccountStore((s) => s.account);
  const fetchAccount = useClaudeAccountStore((s) => s.fetch);

  useEffect(() => {
    fetchAccount();
  }, [fetchAccount]);

  return (
    <div className="no-select relative flex h-11 items-center justify-center gap-3 px-4">
      {/* Centered with inset-y-0 + items-center rather than
          top-1/2/-translate-y-1/2: a transform creates a stacking context, and
          that would trap TerminalNavigator's drop-up below the terminal layers
          (project wrapper z-10, zoomed pane z-40) no matter its own z-index. */}
      <div className="absolute inset-y-0 left-4 flex max-w-[40%] items-center gap-2">
        <TerminalNavigator onNavigate={onNavigateToSession} />
        {account?.email && (
          <div
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-maestro-muted/70"
            title={`Claude Code account: ${account.email}`}
          >
            <UserRound size={12} className="shrink-0" />
            <span className="truncate">{account.email}</span>
          </div>
        )}
      </div>
      {(hasUnlaunchedSlots || !inGridView) && (
        <button
          type="button"
          onClick={unlaunchedCount > 0 ? onLaunchAll : undefined}
          disabled={unlaunchedCount === 0}
          className="flex items-center gap-2 rounded-lg bg-maestro-accent px-4 py-1.5 text-xs font-medium text-white shadow-md shadow-black/20 transition-colors hover:bg-maestro-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play size={11} fill="currentColor" />
          {unlaunchedCount === 0
            ? "Launch Sessions"
            : unlaunchedCount === 1
              ? "Launch Session"
              : `Launch All (${unlaunchedCount})`}
        </button>
      )}

      <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-4">
        <SystemMetrics />
        <UsageBar />
      </div>
    </div>
  );
}
