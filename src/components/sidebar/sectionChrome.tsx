/** Shared visual chrome for sidebar section cards. */

export const cardClass =
  "sidebar-card-link rounded-lg border border-maestro-border/60 bg-maestro-card p-3 overflow-hidden shadow-[0_1px_4px_rgb(0_0_0/0.15),0_0_0_1px_rgb(255_255_255/0.03)_inset] transition-shadow hover:shadow-[0_2px_8px_rgb(0_0_0/0.25),0_0_0_1px_rgb(255_255_255/0.05)_inset]";

export const divider = <div className="h-px bg-maestro-border/30 my-1" />;

export function SectionHeader({
  icon: Icon,
  label,
  breathe = false,
  iconColor,
  badge,
  right,
}: {
  icon: React.ElementType;
  label: string;
  breathe?: boolean;
  iconColor?: string;
  badge?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
      <Icon
        size={13}
        className={`${iconColor ?? "text-maestro-muted/80"} ${breathe ? "animate-breathe" : ""}`}
      />
      <span className="flex-1">{label}</span>
      {badge}
      {right}
    </div>
  );
}
