import { openUrl } from "@tauri-apps/plugin-opener";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useHealthStore } from "@/stores/useHealthStore";
import { Toast, ToastStack } from "./Toast";

/** Attention tint for health toasts — the same orange the badges use. */
const HEALTH_ACCENT = "rgb(var(--maestro-orange))";

/**
 * Every background notification Maestro raises, in one bottom-right stack:
 *
 * - GitHub watchdog: one card per newly-appeared review request / assigned
 *   issue, tinted with the project's color. Clicking opens it in the browser
 *   (simpler than driving the git panel to the right project + tab).
 * - Health checker: one card per newly-raised memory/process flag. These have
 *   no destination — the badge and the section highlight carry the detail —
 *   so they are dismiss-only.
 *
 * Both queues only ever hold transitions, and only while notifications are
 * enabled; see the stores for the diffing rules.
 */
export function NotificationToasts() {
  const watchdogToasts = useGitHubWatchdogStore((s) => s.toasts);
  const dismissWatchdogToast = useGitHubWatchdogStore((s) => s.dismissToast);
  const healthToasts = useHealthStore((s) => s.toasts);
  const dismissHealthToast = useHealthStore((s) => s.dismissToast);
  const projectColors = useProjectColors();

  if (watchdogToasts.length === 0 && healthToasts.length === 0) return null;

  return (
    <ToastStack>
      {watchdogToasts.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={projectColors.get(toast.projectName) ?? projectColorFor(toast.projectName)}
          title={toast.projectName}
          subtitle={`${toast.kind === "pr" ? "Review requested" : "Issue assigned"} — #${toast.number} ${toast.title}`}
          onClick={() => {
            openUrl(toast.url).catch((err) => console.error("Failed to open URL:", err));
            dismissWatchdogToast(toast.id);
          }}
          onDismiss={() => dismissWatchdogToast(toast.id)}
        />
      ))}
      {healthToasts.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={HEALTH_ACCENT}
          title={toast.area === "memory" ? "Memory" : "Processes"}
          subtitle={`${toast.target} — ${toast.reason}`}
          onDismiss={() => dismissHealthToast(toast.id)}
        />
      ))}
    </ToastStack>
  );
}
