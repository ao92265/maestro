import { Activity, Brain, X } from "lucide-react";
import { MemorySection } from "@/components/sidebar/MemorySection";
import { ProcessesSection } from "@/components/sidebar/ProcessesSection";

export type UtilityPanelKind = "memory" | "processes";

const PANEL_META: Record<UtilityPanelKind, { title: string; icon: React.ElementType }> = {
  memory: { title: "Memory", icon: Brain },
  processes: { title: "Processes", icon: Activity },
};

/**
 * Right-side panel for the Memory and Processes views, opened from the
 * top-bar buttons. Reuses the same section components the sidebar tabs used
 * to render, just docked on the right instead of the left.
 */
export function UtilityPanel({
  panel,
  onClose,
}: {
  panel: UtilityPanelKind;
  onClose: () => void;
}) {
  const { title, icon: Icon } = PANEL_META[panel];
  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-maestro-border bg-maestro-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-maestro-border/60 px-3">
        <Icon size={14} className="text-maestro-accent" />
        <span className="flex-1 text-sm font-medium text-maestro-text">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label={`Close ${title} panel`}
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {panel === "memory" ? <MemorySection /> : <ProcessesSection />}
      </div>
    </aside>
  );
}
