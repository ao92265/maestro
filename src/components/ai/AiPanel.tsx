import { useState } from "react";

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
 */
export function AiPanel() {
  const [tab, setTab] = useState<AiTab>("report");
  return (
    <div>
      <div role="tablist" aria-label="AI panel sections" className="mb-2 flex gap-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
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
      {tab === "report" ? <ReportTab /> : tab === "plan" ? <PlanTab /> : <CatalogTab />}
    </div>
  );
}
