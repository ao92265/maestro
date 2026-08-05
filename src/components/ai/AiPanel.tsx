import { useRef, useState } from "react";

import { CatalogTab } from "@/components/ai/CatalogTab";
import { PlanTab } from "@/components/ai/PlanTab";
import { ReportTab } from "@/components/ai/ReportTab";

type AiTab = "report" | "plan" | "catalog";

const TABS: { id: AiTab; label: string }[] = [
  { id: "report", label: "Report" },
  { id: "plan", label: "Plan" },
  { id: "catalog", label: "Catalog" },
];

/**
 * Body of the right-side AI panel: everything Maestro generates with a
 * headless Claude run, behind one tab strip. Report is the daily per-project
 * standup, Plan is the single cross-project "what to do first today", and
 * Catalog is the on-demand feature catalogue of the active project. Opening
 * the panel always lands on Report.
 *
 * The strip follows the ARIA tabs pattern like the project tabs do: only the
 * selected tab is in the focus order, and arrow keys / Home / End move
 * between them.
 */
export function AiPanel() {
  const [tab, setTab] = useState<AiTab>("report");
  const tabRefs = useRef<Partial<Record<AiTab, HTMLButtonElement | null>>>({});

  const select = (next: AiTab) => {
    setTab(next);
    // Every tab button stays mounted, so it can take focus right away.
    tabRefs.current[next]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      select(TABS[(index + 1) % TABS.length].id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      select(TABS[(index - 1 + TABS.length) % TABS.length].id);
    } else if (e.key === "Home") {
      e.preventDefault();
      select(TABS[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      select(TABS[TABS.length - 1].id);
    }
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="AI panel sections"
        onKeyDown={handleKeyDown}
        className="mb-2 flex gap-1"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`ai-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`ai-tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => select(id)}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              tab === id
                ? "bg-maestro-accent/15 text-maestro-accent"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`ai-tabpanel-${tab}`} aria-labelledby={`ai-tab-${tab}`}>
        {tab === "report" ? <ReportTab /> : tab === "plan" ? <PlanTab /> : <CatalogTab />}
      </div>
    </div>
  );
}
