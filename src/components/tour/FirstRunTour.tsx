import { Factory, Home, Send, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTourStore } from "@/stores/useTourStore";

/**
 * First-run tour: a five-card walkthrough of the mental model and the two
 * views built for the daily loop. Shows once on a fresh install (see
 * `useTourStore`), reopenable from the Home header. Deliberately a plain
 * centered card, not a spotlight tour: the overlays it explains are
 * full-screen and mutually exclusive, so there is nothing stable behind it
 * to point an arrow at.
 */

interface TourStep {
  icon: typeof Home;
  title: string;
  body: string;
  hint?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    icon: TerminalSquare,
    title: "Maestro is a terminal manager",
    body: "Tabs along the top are your projects. Inside each tab you run Claude sessions side by side. Everything else in the app is bolted around that.",
    hint: "Cmd+T for a new terminal, Cmd+G for every project at once",
  },
  {
    icon: Home,
    title: "Home is your decision queue",
    body: "Three bands: blocked waiting on you, landed since you last looked, still running. Parked handoffs sit underneath for triage. Open it, clear it, get on with your day.",
    hint: "Cmd+1, and it opens on launch",
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
    body: "The feed watches the same board Home shows. It pings you when something sits blocked for ten minutes and sends one digest each morning. Nothing to configure in here.",
  },
  {
    icon: X,
    title: "Ignore the rest for now",
    body: "Samurai, Harvest, Second Brain, Journal, Landscape, Marketplace: all inherited from upstream and not wired into your flow. Whatever stays untouched gets stripped later.",
    hint: "Reopen this tour any time from the Home header",
  },
];

export function FirstRunTour() {
  const { isOpen, step, close, next, back } = useTourStore();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog when it appears (Tab starts inside it, screen readers
  // announce it) and let Escape dismiss — the dialog opens unprompted on
  // first launch, so it needs a keyboard-only way out.
  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
