import type { ReactNode } from "react";

/** Shared chrome for the control panel's sections, so they read as one grid. */
export function PanelSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded border border-maestro-border bg-maestro-card p-3">
      <header className="flex items-center gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
          {title}
        </h3>
        {hint && <span className="truncate text-[10px] text-maestro-muted/70">{hint}</span>}
        <div className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  );
}

export const sliderClass = "h-1 flex-1 accent-maestro-accent";

/** Empty-state line, used wherever a subsystem is reachable but has no rows. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-dashed border-maestro-border px-2 py-1.5 text-[11px] text-maestro-muted/70">
      {children}
    </p>
  );
}

/** Compact number for token counts, which run to seven figures. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Short relative time; mirrors the Factory run list's own formatting. */
export function relAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
