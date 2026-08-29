import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SNOOZE_PRESET_HOURS, type SnoozeKey } from "@/lib/sessionActions";
import { useSnoozeStore } from "@/stores/useSnoozeStore";

/**
 * "Not now" on a decision-queue row: hides it for a chosen number of hours.
 *
 * A small popover rather than a single fixed duration (rohcna's "Snooze 3h"):
 * the same three rows come back at different useful times, and one extra
 * click is cheaper than a wrong deadline.
 */
export function SnoozeButton({ snoozeKey, label }: { snoozeKey: SnoozeKey; label: string }) {
  const snooze = useSnoozeStore((s) => s.snooze);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /* Click-away close: the popover sits inside a scrolling band, so leaving it
     open while the user scrolls elsewhere would strand it over other rows. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded border border-maestro-border px-1.5 py-0.5 text-[11px] text-maestro-muted transition-colors hover:border-maestro-muted/50 hover:text-maestro-text"
        title={`Hide ${label} from this band for a while`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Clock size={11} /> Later
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 flex flex-col rounded border border-maestro-border bg-maestro-card py-0.5 shadow-lg"
        >
          {SNOOZE_PRESET_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              role="menuitem"
              onClick={() => {
                snooze(snoozeKey, hours);
                setOpen(false);
              }}
              className="whitespace-nowrap px-3 py-1 text-left text-[11px] text-maestro-muted transition-colors hover:bg-maestro-bg hover:text-maestro-text"
            >
              {hours}h
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
