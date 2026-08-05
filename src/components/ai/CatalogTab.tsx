import { useEffect } from "react";
import { AlertTriangle, Loader2, ScanSearch, Square } from "lucide-react";

import { MarkdownBody } from "@/components/git/shared/MarkdownBody";
import { cardClass } from "@/components/sidebar/sectionChrome";
import { projectColorFor } from "@/lib/projectColor";
import { useCatalogStore } from "@/stores/useCatalogStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * Catalog tab of the AI panel: what the ACTIVE project's app actually does,
 * feature by feature, and what is missing — written by a headless Claude run
 * that reads its way around the repository itself.
 *
 * It follows the active workspace tab rather than offering its own project
 * picker: the panel already sits beside the project you are in, and one
 * catalogue is kept per project, so switching tabs switches catalogues. Unlike
 * the Report and Plan tabs there is no schedule and no catch-up — a scan is
 * slow, so it happens only when you press the button. The last scan stays the
 * current one, however old, until a rescan replaces it.
 */
export function CatalogTab() {
  const activeTab = useWorkspaceStore((s) => s.tabs.find((t) => t.active));
  const repoPath = activeTab
    ? (activeTab.selectedRepoPath ?? activeTab.projectPath)
    : null;
  const entry = useCatalogStore((s) => (repoPath ? s.catalogs[repoPath] : undefined));
  const loadLatest = useCatalogStore((s) => s.loadLatest);
  const scan = useCatalogStore((s) => s.scan);
  const cancel = useCatalogStore((s) => s.cancel);

  // Show the newest catalogue already on disk as soon as the tab opens (or the
  // active project changes).
  useEffect(() => {
    if (repoPath) void loadLatest(repoPath);
  }, [repoPath, loadLatest]);

  if (!activeTab || !repoPath) {
    return (
      <div className={cardClass}>
        <p className="text-[11px] leading-snug text-maestro-muted">
          Open a project to scan it.
        </p>
      </div>
    );
  }

  const scanning = entry?.status === "scanning";
  const catalog = entry?.catalog ?? null;

  return (
    <div>
      <div className={`${cardClass} mb-2 flex flex-col gap-1.5`}>
        <div className="flex items-center gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-xs font-bold"
            style={{ color: projectColorFor(activeTab.name) }}
          >
            {activeTab.name}
          </span>
          {catalog && (
            <span
              className="shrink-0 text-[9px] text-maestro-muted"
              title={`Last scanned ${catalog.date}`}
            >
              {catalog.date}
            </span>
          )}
        </div>
        <p className="text-[10px] leading-snug text-maestro-muted">
          Claude reads this project and writes down every feature it finds — what
          it does, how to use it, and whether it is done, partial or full of
          gaps. Nothing runs on a schedule. A scan usually takes a few minutes
          and is given up to 45 on a big repo; you can stop it at any point. A
          rescan updates the last catalogue and lists what changed.
        </p>
        {scanning ? (
          <button
            type="button"
            onClick={() => void cancel(repoPath)}
            className="flex items-center justify-center gap-1.5 rounded bg-maestro-surface px-2 py-1 text-xs font-medium text-maestro-text transition-colors hover:bg-maestro-card"
          >
            <Square size={11} />
            Stop scan
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void scan(repoPath)}
            className="flex items-center justify-center gap-1.5 rounded bg-maestro-accent/15 px-2 py-1 text-xs font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/25"
          >
            <ScanSearch size={12} />
            {catalog ? "Rescan project" : "Scan project"}
          </button>
        )}
      </div>

      <div className={`${cardClass} mb-2`}>
        {/* A scan can run for a long time, so announce how it ends: a screen
            reader user should not have to poll the panel for 45 minutes. */}
        <div aria-live="polite" aria-atomic="true">
          {scanning && (
            <p className="mb-1.5 flex items-start gap-1.5 text-[11px] text-maestro-muted">
              <Loader2 size={11} className="mt-0.5 shrink-0 animate-spin" />
              <span className="min-w-0">
                Claude is reading {activeTab.name}. Usually a few minutes, up to
                45 on a big repo — you can keep working, and it survives
                switching tabs.
              </span>
            </p>
          )}
          {entry?.status === "error" && (
            <p className="mb-1.5 flex items-start gap-1.5 text-[11px] text-maestro-red">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{entry.error}</span>
            </p>
          )}
          {entry?.status === "ready" && catalog && (
            <span className="sr-only">
              Catalog for {activeTab.name} ready, scanned {catalog.date}.
            </span>
          )}
        </div>
        {catalog && <MarkdownBody content={catalog.markdown} className="text-xs" />}
        {!catalog && !scanning && entry?.status !== "error" && (
          <p className="text-[11px] text-maestro-muted">
            No catalog yet — hit "Scan project" above.
          </p>
        )}
      </div>
    </div>
  );
}
