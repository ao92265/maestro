import type { LucideIcon } from "lucide-react";
import { Columns, Factory, MoreHorizontal, Send, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTourStore } from "@/stores/useTourStore";

/**
 * First-run tour: a five-card walkthrough of the mental model and the
 * views built for the daily loop, the Board and the terminal grid. Shows
 * once on a fresh install (see `useTourStore`), reopenable from the Board
 * or Home header. Deliberately a plain centered card, not a spotlight tour:
 * the overlays it explains are full-screen and mutually exclusive, so there
 * is nothing stable behind it to point an arrow at.
 */

interface TourStep {
  icon: LucideIcon;
  title: string;
  body: string;
  hint?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    icon: Columns,
    title: "The Board is your deck",
    body: "Columns track work as it moves: Suggested, Planning, Building, Checking, Review, Done. A card glowing red needs you: it stopped and is waiting on an answer.",
    hint: "Cmd+E takes you to your terminals",
  },
  {
    icon: TerminalSquare,
    title: "Terminals are one keystroke away",
    body: "Cmd+E swaps the Board for Grid. Tabs there are your projects, and inside each one you run Claude sessions side by side.",
    hint: "Cmd+T for a new terminal, Cmd+G for every project at once",
  },
  {
    icon: Factory,
    title: "Factory runs jobs end to end",
    body: "Describe what you want built and submit. The engine plans, builds, tests and opens a PR, pausing here only when a decision needs you.",
    hint: "Cmd+7",
  },
  {
    icon: Send,
    title: "Telegram fetches you",
    body: "The feed watches the same board you just saw. It pings you when something sits blocked for ten minutes and sends one digest each morning. Nothing to configure in here.",
  },
  {
    icon: MoreHorizontal,
    title: "Everything else lives behind More",
    body: "Landscape and Memory are one click from the ⋯ menu at the top right, alongside Extensions (MCP servers, plugins, skills). Samurai, Harvest, Second Brain and Journal are still in the app, just off today's map.",
    hint: "Reopen this tour any time from the Board header",
  },
];

export function FirstRunTour() {
  const { isOpen, step, close, next, back } = useTourStore();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog when it appears (Tab starts inside it, screen readers
  // announce it), keep Tab cycling inside it (everything behind the backdrop
  // is focusable but invisible), let Escape dismiss, and hand focus back to
  // whatever had it on close — the dialog opens unprompted on first launch,
  // so the whole keyboard story has to work without a mouse.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Queried live on every Tab: the focusable set changes between steps
      // (Back appears from step 1, Next becomes Done). NOTE: "button" is
      // accurate for today's markup; a card that ever gains a link or input
      // must widen this selector or the trap fails open (focus escapes).
      const focusables = dialog.querySelectorAll<HTMLElement>("button");
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(active)) {
        // Focus escaped anyway (or never entered): pull it back in.
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, close]);

  if (!isOpen) return null;

  const last = step >= TOUR_STEPS.length - 1;
  const current = TOUR_STEPS[Math.min(step, TOUR_STEPS.length - 1)];
  const Icon = current.icon;

  return (
    /* fixed, not absolute: the backdrop must dim the whole window (TopBar,
       sidebar, panels), matching the aria-modal claim. */
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Maestro tour"
        className="w-[420px] rounded-lg border border-maestro-border bg-maestro-card p-5 shadow-xl outline-none"
      >
        <div className="flex items-start justify-between">
          <Icon size={20} className="text-maestro-accent" />
          <button
            type="button"
            aria-label="Skip tour"
            onClick={close}
            className="rounded p-1 text-maestro-muted transition-colors hover:text-maestro-text"
          >
            <X size={14} />
          </button>
        </div>

        <h2 className="mt-3 text-[14px] font-semibold text-maestro-text">{current.title}</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-maestro-muted">{current.body}</p>
        {current.hint && <p className="mt-2 text-[11px] text-maestro-accent/80">{current.hint}</p>}

        <div className="mt-5 flex items-center justify-between">
          <div className="flex gap-1.5">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.title}
                className={`h-1.5 w-1.5 rounded-full ${
                  i === step ? "bg-maestro-accent" : "bg-maestro-muted/30"
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={back}
                className="rounded border border-maestro-border px-2.5 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={last ? close : next}
              className="rounded bg-maestro-accent/15 px-2.5 py-1 text-[11px] font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/25"
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
