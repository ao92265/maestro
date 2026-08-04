import { openUrl } from "@tauri-apps/plugin-opener";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { Toast, ToastStack } from "./Toast";

/**
 * Renders the queued GitHub-watchdog toasts: one card per newly-appeared
 * review request / assigned issue, tinted with the project's color.
 *
 * Clicking a toast opens the PR/issue in the browser (simpler than driving
 * the git panel to the right project + tab + selection) and dismisses it.
 */
export function GitHubWatchdogToasts() {
  const toasts = useGitHubWatchdogStore((s) => s.toasts);
  const dismissToast = useGitHubWatchdogStore((s) => s.dismissToast);
  const projectColors = useProjectColors();

  if (toasts.length === 0) return null;

  return (
    <ToastStack>
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={projectColors.get(toast.projectName) ?? projectColorFor(toast.projectName)}
          title={toast.projectName}
          subtitle={`${toast.kind === "pr" ? "Review requested" : "Issue assigned"} — #${toast.number} ${toast.title}`}
          onClick={() => {
            openUrl(toast.url).catch((err) => console.error("Failed to open URL:", err));
            dismissToast(toast.id);
          }}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </ToastStack>
  );
}
