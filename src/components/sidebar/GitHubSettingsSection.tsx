import { Bell } from "lucide-react";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { cardClass, SectionHeader } from "./sectionChrome";

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return "Never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Sidebar settings card for the GitHub watchdog (follows the
 * UpdateSettingsSection pattern). The toggle mutes toast notifications only:
 * polling and the top-bar badge keep working either way.
 */
export function GitHubSettingsSection() {
  const notificationsEnabled = useGitHubWatchdogStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useGitHubWatchdogStore((s) => s.setNotificationsEnabled);
  const status = useGitHubWatchdogStore((s) => s.status);
  const lastPolledAt = useGitHubWatchdogStore((s) => s.lastPolledAt);

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={Bell}
        label="GitHub"
        iconColor="text-maestro-accent"
        right={
          <span className="text-[10px] normal-case tracking-normal text-maestro-muted">
            {formatTimeAgo(lastPolledAt)}
          </span>
        }
      />

      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text hover:bg-maestro-border/40">
        <span className="flex-1">GitHub notifications</span>
        <button
          type="button"
          onClick={() => setNotificationsEnabled(!notificationsEnabled)}
          className={`relative h-4 w-7 rounded-full transition-colors ${
            notificationsEnabled ? "bg-maestro-accent" : "bg-maestro-border"
          }`}
          aria-label="Toggle GitHub notifications"
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              notificationsEnabled ? "left-3.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <p className="px-2 pt-0.5 text-[10px] text-maestro-muted/70">
        Toasts for new review requests and assigned issues. The top-bar badge
        stays on either way.
      </p>

      {status === "gh-missing" && (
        <p className="px-2 pt-1 text-[10px] text-maestro-muted">
          GitHub CLI (gh) not found — watchdog is paused.
        </p>
      )}
      {status === "not-authenticated" && (
        <p className="px-2 pt-1 text-[10px] text-maestro-muted">
          Not authenticated — run <code className="rounded bg-maestro-border/40 px-1">gh auth login</code>.
        </p>
      )}
    </div>
  );
}
