import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef } from "react";

interface EagleProjectSwitcherProps {
  /** One entry per open project tab, in tab order. */
  projects: Array<{ tabId: string; name: string; color: string }>;
  /** Index of the project whose git card is currently shown. */
  index: number;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * Eagle-view strip above the git panel content: shows which project's git
 * card is displayed (colored dot + name + position dots) and switches cards
 * via arrow buttons or a horizontal trackpad/mouse-wheel swipe over the strip.
 */
export function EagleProjectSwitcher({
  projects,
  index,
  onPrev,
  onNext,
}: EagleProjectSwitcherProps) {
  // Cooldown so one physical swipe (a burst of wheel events) fires once.
  const lastFire = useRef(0);
  const current = projects[index];

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Horizontal-intent check — same ratio as useSwipeNavigation.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2) return;
    // Keep the window-level tab-switching swipe hook from also firing.
    e.stopPropagation();
    if (Math.abs(e.deltaX) > 15 && Date.now() - lastFire.current > 250) {
      lastFire.current = Date.now();
      // deltaX > 0 = swipe left = next (matches useSwipeNavigation).
      if (e.deltaX > 0) onNext();
      else onPrev();
    }
  };

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-maestro-border bg-maestro-bg px-2"
      onWheel={handleWheel}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={projects.length < 2}
        className="rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Previous project"
      >
        <ChevronLeft size={14} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col items-center">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: current?.color }}
          />
          <span className="truncate text-xs font-medium text-maestro-text">{current?.name}</span>
        </div>
        {projects.length >= 2 && (
          <div className="flex gap-1">
            {projects.map((p, i) => (
              <span
                key={p.tabId}
                className={`h-1.5 w-1.5 rounded-full ${
                  i === index ? "bg-maestro-accent" : "bg-maestro-muted/40"
                }`}
              />
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onNext}
        disabled={projects.length < 2}
        className="rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Next project"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
