import { cardClass } from "@/components/sidebar/sectionChrome";

/**
 * Catalog tab placeholder. The catalog itself lands in a later change; this
 * keeps the tab strip honest about what is coming rather than hiding it.
 */
export function CatalogTab() {
  return (
    <div className={cardClass}>
      <p className="text-[11px] leading-snug text-maestro-muted">
        Catalog — coming soon.
      </p>
    </div>
  );
}
