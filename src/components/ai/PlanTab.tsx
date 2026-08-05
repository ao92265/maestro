import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { MarkdownBody } from "@/components/git/shared/MarkdownBody";
import { cardClass } from "@/components/sidebar/sectionChrome";
import { usePlanStore } from "@/stores/usePlanStore";
import { localDateString, useStandupStore } from "@/stores/useStandupStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** Idle time before a keystroke reaches the persisted store (and its file). */
const CONCERNS_SAVE_DELAY_MS = 600;

/**
 * Plan tab of the AI panel: ONE prioritised plan across every open project
 * (cross-project ordering is the point, so there is no per-project card).
 * It is generated on the same daily schedule as the Report tab — including
 * the catch-up when the app was closed at schedule time — and kept until the
 * next day's plan replaces it. The concerns box is persisted free text that
 * goes into the prompt as the highest-priority input.
 */
export function PlanTab() {
  // useShallow is required: the mapped array is a fresh object on every
  // getSnapshot, and zustand v5 dropped the memoized selector path — without
  // it React re-renders forever ("The result of getSnapshot should be cached").
  const repoPaths = useWorkspaceStore(
    useShallow((s) => s.tabs.map((t) => t.selectedRepoPath ?? t.projectPath))
  );
  const status = usePlanStore((s) => s.status);
  const plan = usePlanStore((s) => s.plan);
  const error = usePlanStore((s) => s.error);
  const concerns = usePlanStore((s) => s.concerns);
  const setConcerns = usePlanStore((s) => s.setConcerns);
  const loadLatest = usePlanStore((s) => s.loadLatest);
  const generate = usePlanStore((s) => s.generate);
  // The plan rides the Report tab's schedule; with it off, nothing fires.
  const scheduleEnabled = useStandupStore((s) => s.scheduleEnabled);
  const scheduleTime = useStandupStore((s) => s.scheduleTime);

  // Show the newest plan already on disk as soon as the tab opens.
  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // The textarea is driven by local state while typing: routing every
  // keystroke through the persisted store rewrites its file per character.
  const [draft, setDraft] = useState(concerns);
  const lastCommitted = useRef(concerns);
  const commit = useCallback(
    (value: string) => {
      if (value === lastCommitted.current) return;
      lastCommitted.current = value;
      setConcerns(value);
    },
    [setConcerns]
  );
  // Adopt changes that came from elsewhere — notably the async hydration of
  // the persisted settings, which lands after mount — without clobbering
  // whatever is being typed right now.
  useEffect(() => {
    if (concerns !== lastCommitted.current) {
      lastCommitted.current = concerns;
      setDraft(concerns);
    }
  }, [concerns]);
  // Save once typing pauses; blur (including the one the Generate button
  // causes on mousedown, before its click fires) commits immediately.
  useEffect(() => {
    if (draft === lastCommitted.current) return;
    const timer = setTimeout(() => commit(draft), CONCERNS_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, commit]);

  const generating = status === "generating";
  // Retention keeps the newest plan visible until the next one exists, so the
  // badge flags a previous day's date rather than passing it off as today's.
  const planIsToday = !plan || plan.date === localDateString();

  return (
    <div>
      <div className={`${cardClass} mb-2 flex flex-col gap-1.5`}>
        <label htmlFor="plan-concerns" className="text-xs font-medium text-maestro-text">
          What's on your mind?
        </label>
        <textarea
          id="plan-concerns"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          placeholder="Deadlines, what you're stuck on, what you want to get to this week…"
          spellCheck={false}
          className="min-h-[70px] resize-y rounded border border-maestro-border bg-maestro-surface p-2 text-[11px] leading-snug text-maestro-text outline-none focus:border-maestro-blue"
        />
        <p className="text-[10px] leading-snug text-maestro-muted">
          Kept between runs and weighed above everything else when the plan is
          written. One plan covers all open projects at once.
        </p>
        {scheduleEnabled ? (
          <p className="text-[10px] leading-snug text-maestro-muted">
            Generated automatically at {scheduleTime} — the daily time set on
            the Report tab, which drives both. If the app was closed then, it
            catches up on the next launch.
          </p>
        ) : (
          <p className="flex items-start gap-1.5 text-[10px] leading-snug text-maestro-orange">
            <AlertTriangle size={11} className="mt-px shrink-0" />
            <span>
              The daily schedule is off, so no plan is generated automatically.
              Turn on "Daily report at" on the Report tab — it drives both — or
              use the button below whenever you want one.
            </span>
          </p>
        )}
        <button
          type="button"
          disabled={generating || repoPaths.length === 0}
          onClick={() => void generate(repoPaths)}
          className="flex items-center justify-center gap-1.5 rounded bg-maestro-accent/15 px-2 py-1 text-xs font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/25 disabled:opacity-50"
        >
          <RefreshCw size={12} className={generating ? "animate-spin" : ""} />
          {generating ? "Generating…" : "Generate plan"}
        </button>
      </div>

      <div className={`${cardClass} mb-2`}>
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-maestro-text">
            Today's plan
          </span>
          {plan && (
            <span
              className={`shrink-0 text-[9px] ${
                planIsToday ? "text-maestro-muted" : "font-semibold text-maestro-orange"
              }`}
              title={planIsToday ? undefined : "Latest plan — from a previous day"}
            >
              {plan.date}
            </span>
          )}
        </div>

        {generating && (
          <p className="flex items-center gap-1.5 text-[11px] text-maestro-muted">
            <Loader2 size={11} className="animate-spin" />
            Claude is writing the plan…
          </p>
        )}
        {status === "error" && (
          <p className="flex items-start gap-1.5 text-[11px] text-maestro-red">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        {plan && !generating && <MarkdownBody content={plan.markdown} className="text-xs" />}
        {!plan && status !== "generating" && status !== "error" && (
          <p className="text-[11px] text-maestro-muted">
            No plan yet — hit "Generate plan" above.
          </p>
        )}
      </div>
    </div>
  );
}
