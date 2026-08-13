import type { HealthArea } from "@/lib/healthRules";
import { countForArea, useHealthStore } from "@/stores/useHealthStore";

/**
 * Small count badge pinned to the corner of the top-bar Memory / Processes
 * buttons when the health checker has something worth a look. Renders nothing
 * when the area is clean, so a healthy setup stays visually silent.
 *
 * The parent button must be `relative` for the absolute positioning to bite.
 */
export function HealthAttentionBadge({ area }: { area: HealthArea }) {
  const flags = useHealthStore((s) => s.flags);
  const count = countForArea(flags, area);
  if (count === 0) return null;

  const reasons = flags
    .filter((f) => f.area === area)
    .map((f) => `${f.target} — ${f.reason}`)
    .join("\n");

  return (
    <span
      role="img"
      className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-[13px] rounded-full bg-maestro-orange px-1 text-center text-[8px] font-bold leading-[13px] text-maestro-bg"
      title={reasons}
      aria-label={`${count} health ${count === 1 ? "item" : "items"} need a look`}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}
