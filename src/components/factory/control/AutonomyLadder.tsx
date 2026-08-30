import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type ActPolicySnapshot,
  AUTONOMY_LEVEL_BLURB,
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  effectiveLevel,
  l2Caveat,
  TASK_CLASSES,
  type TaskClass,
} from "@/lib/actControl";
import { useActControlStore } from "@/stores/useActControlStore";
import { PanelSection, sliderClass } from "./primitives";

/**
 * The autonomy ladder: what ACT is allowed to do at the delivery boundary,
 * per task class, plus the two sampling dials that decide how much of the
 * eligible volume actually runs unattended.
 *
 * Every control writes the COMPLETE block. ACT replaces the autonomy object
 * rather than merging it (`updatePolicy` spreads `updates` shallowly and
 * deep-merges only agent_priority, tool_policies and today_overrides), so a
 * single-key write erased the default, both sample rates and both switches and
 * persisted that to disk. The store merges each change over the last policy it
 * read; see `setAutonomy`.
 */
export function AutonomyLadder({ policy }: { policy: ActPolicySnapshot | null }) {
  const setAutonomy = useActControlStore((state) => state.setAutonomy);

  if (!policy) {
    return (
      <PanelSection title="Autonomy ladder">
        <p className="text-[11px] text-maestro-muted/70">
          No policy read yet. The ladder appears as soon as ACT answers.
        </p>
      </PanelSection>
    );
  }

  const { autonomy, writesEnabled } = policy;

  const setClass = (taskClass: TaskClass, level: AutonomyLevel) =>
    void setAutonomy({ classes: { ...autonomy.classes, [taskClass]: level } });

  return (
    <PanelSection
      title="Autonomy ladder"
      hint={`default ${autonomy.default}${autonomy.directMerge ? " · direct merge" : ""}`}
    >
      {!writesEnabled && (
        /* ACT's global write switch. The ladder still describes what WOULD
           happen, so it stays readable rather than hidden. */
        <p className="rounded border border-maestro-yellow/40 px-2 py-1 text-[10px] text-maestro-yellow">
          ACT has writes disabled today: these levels describe intent, not what it will do.
        </p>
      )}

      <div className="flex flex-col gap-1">
        {TASK_CLASSES.map((taskClass) => {
          const level = effectiveLevel(autonomy, taskClass);
          const caveat = l2Caveat(autonomy, taskClass);
          const inherited = autonomy.classes[taskClass] === undefined;
          return (
            <div key={taskClass} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-[11px] text-maestro-text">{taskClass}</span>
                <div className="flex overflow-hidden rounded border border-maestro-border">
                  {AUTONOMY_LEVELS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setClass(taskClass, option)}
                      title={AUTONOMY_LEVEL_BLURB[option]}
                      aria-pressed={level === option}
                      className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        level === option
                          ? "bg-maestro-accent/20 text-maestro-accent"
                          : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <span className="truncate text-[10px] text-maestro-muted">
                  {AUTONOMY_LEVEL_BLURB[level]}
                  {inherited && " (inherited)"}
                </span>
              </div>
              {caveat && (
                <p className="flex items-start gap-1 pl-24 text-[10px] text-maestro-yellow">
                  <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                  {caveat}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 border-t border-maestro-border pt-2">
        <SampleRate
          label="Auto-merge sample"
          hint="Share of L2-eligible deliveries that actually merge unattended"
          value={autonomy.l2SampleRate}
          onCommit={(l2SampleRate) => void setAutonomy({ l2SampleRate })}
        />
        <SampleRate
          label="Human review sample"
          hint="Share of auto-merged PRs flagged for a post-merge read"
          value={autonomy.humanSampleRate}
          onCommit={(humanSampleRate) => void setAutonomy({ humanSampleRate })}
        />
        <label className="flex items-center gap-2 text-[11px] text-maestro-text">
          <input
            type="checkbox"
            checked={autonomy.allowAllClasses}
            onChange={(e) => void setAutonomy({ allowAllClasses: e.target.checked })}
            className="accent-maestro-accent"
          />
          Full auto — let any class reach L2, not just docs, labels and copy
        </label>
        {autonomy.allowAllClasses && (
          <p className="pl-6 text-[10px] text-maestro-yellow">
            Code can now auto-merge. The external-author trust gate still holds.
          </p>
        )}
      </div>
    </PanelSection>
  );
}

/**
 * A rate dial. Committing on release rather than on every input event keeps a
 * drag from firing a PUT per pixel, but the thumb has to track the drag in the
 * meantime — so it is controlled locally and resyncs whenever the polled
 * policy changes underneath it (`defaultValue` only applied on mount, which
 * left the thumb and its own label showing different numbers).
 */
function SampleRate({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const committed = Math.round(value * 100);
  const [draft, setDraft] = useState(committed);
  const [dragging, setDragging] = useState(false);

  // Adopt the engine's value unless the user is mid-drag, which would yank
  // the thumb out from under them on a poll.
  useEffect(() => {
    if (!dragging) setDraft(committed);
  }, [committed, dragging]);

  const commit = (next: number) => {
    setDragging(false);
    if (next !== committed) onCommit(next / 100);
  };

  return (
    <label className="flex items-center gap-2" title={hint}>
      <span className="w-36 shrink-0 text-[11px] text-maestro-text">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={draft}
        onChange={(e) => {
          setDragging(true);
          setDraft(Number(e.target.value));
        }}
        /* Pointer events cover mouse, touch and pen alike; onMouseUp alone
           also missed a release that happened outside the track. onBlur is the
           backstop for a drag that ends off-window. */
        onPointerUp={() => commit(draft)}
        onKeyUp={() => commit(draft)}
        onBlur={() => commit(draft)}
        className={sliderClass}
        aria-label={label}
      />
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-maestro-muted">
        {draft}%
      </span>
    </label>
  );
}
