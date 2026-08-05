import { X } from "lucide-react";
import type { HealthFlag } from "@/lib/healthRules";
import { useHealthStore } from "@/stores/useHealthStore";

/**
 * The one-line reasons the health checker raised against a row, each with a
 * dismiss button.
 *
 * Dismissing is the only action the checker offers, and it is deliberately
 * weak: it hides the flag for this app session and does not touch a file, a
 * process or any config. It exists so a permanent, unfixable flag — a
 * six-month-old fact in a project you have finished with — cannot pin the
 * attention badge on forever.
 *
 * Must not be rendered inside a `<button>`: it contains one.
 */
export function HealthReasonLines({ flags }: { flags: HealthFlag[] }) {
  const dismissFlag = useHealthStore((s) => s.dismissFlag);
  return (
    <>
      {flags.map((flag) => (
        <span key={flag.key} className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[10px] text-maestro-orange">
            {flag.reason}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismissFlag(flag.key);
            }}
            className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-border/40 hover:text-maestro-text"
            title="Dismiss this flag until it clears and comes back"
            aria-label={`Dismiss health flag: ${flag.reason}`}
          >
            <X size={9} />
          </button>
        </span>
      ))}
    </>
  );
}
