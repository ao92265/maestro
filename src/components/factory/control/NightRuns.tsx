import { CalendarClock, CloudOff, Moon, Play, Save, Square } from "lucide-react";
import { AUTONOMY_LEVEL_BLURB, AUTONOMY_LEVELS, type AutonomyLevel } from "@/lib/actControl";
import {
  DEFAULT_NIGHT_RUN_SETTINGS,
  describeWindow,
  formatClock,
  loopSummary,
  type NightRunOutcome,
  nextWindowLine,
  outcomeLabel,
  parseClock,
  settingsProblem,
} from "@/lib/nightRun";
import { useNightRunStore } from "@/stores/useNightRunStore";
import { EmptyLine, PanelSection, relAgo } from "./primitives";

/** How many outcome rows fit before the panel stops being a glance. */
const VISIBLE_OUTCOMES = 4;

const fieldClass =
  "rounded border border-maestro-border bg-maestro-card px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent/50 focus:outline-none";
const rowClass = "flex items-center gap-2";
const nameClass = "w-28 shrink-0 text-[11px] text-maestro-text";

function OutcomeRow({ outcome }: { outcome: NightRunOutcome }) {
  return (
    <div
      className={`flex flex-col gap-0.5 border-l-2 pl-2 ${
        outcome.ok ? "border-maestro-green/40" : "border-maestro-yellow/50"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={`text-[11px] font-medium ${
            outcome.ok ? "text-maestro-text" : "text-maestro-yellow"
          }`}
        >
          {outcomeLabel(outcome)}
        </span>
        <span className="text-[10px] text-maestro-muted">{relAgo(outcome.at)}</span>
      </div>
      <span className="text-[10px] text-maestro-muted/80">{outcome.detail}</span>
    </div>
  );
}

/**
 * Night runs: start and stop ACT's intake loop, and hand it an overnight
 * window that does it unattended.
 *
 * The window is the part that can fail silently, so this panel always answers
 * two questions without being asked — what happens next, and what happened
 * last time. `nextWindowLine` is the first of those and is never hidden, not
 * even while ACT is unreachable: the schedule is a local fact and stays true
 * whether or not the engine is answering.
 */
export function NightRuns() {
  const view = useNightRunStore((state) => state.view);
  const draft = useNightRunStore((state) => state.draft);
  const error = useNightRunStore((state) => state.error);
  const isBusy = useNightRunStore((state) => state.isBusy);
  const setDraft = useNightRunStore((state) => state.setDraft);
  const discardDraft = useNightRunStore((state) => state.discardDraft);
  const save = useNightRunStore((state) => state.save);
  const start = useNightRunStore((state) => state.start);
  const stop = useNightRunStore((state) => state.stop);

  const settings = draft ?? view?.settings ?? DEFAULT_NIGHT_RUN_SETTINGS;
  const problem = settingsProblem(settings);
  const running = view?.loop?.isRunning ?? false;
  const unreachable = view?.loopError ?? error;

  return (
    <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
      <PanelSection
        title="Intake loop"
        hint={loopSummary(view?.loop ?? null)}
        action={
          running ? (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={isBusy}
              className="flex items-center gap-1 rounded border border-maestro-border px-2 py-0.5 text-[11px] text-maestro-muted transition-colors hover:border-red-500/50 hover:text-red-400 disabled:opacity-40"
            >
              <Square size={10} /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={isBusy || problem !== null}
              title={problem ?? "Start the loop now with these settings"}
              className="flex items-center gap-1 rounded border border-maestro-accent/50 px-2 py-0.5 text-[11px] font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/10 disabled:opacity-40"
            >
              <Play size={10} /> Start now
            </button>
          )
        }
      >
        {unreachable && (
          /* Stale, not broken: the last known state stays on screen and the
             schedule keeps its own clock regardless. */
          <p className="flex items-center gap-1.5 rounded border border-maestro-yellow/40 bg-maestro-yellow/5 px-2 py-1 text-[10px] text-maestro-yellow">
            <CloudOff size={11} />
            ACT did not answer. Showing the last known state — {unreachable}
          </p>
        )}

        <div className={rowClass}>
          <span className={nameClass}>Check every</span>
          <input
            type="number"
            min={1}
            max={240}
            value={settings.intervalMinutes}
            onChange={(event) => setDraft({ intervalMinutes: Number(event.target.value) })}
            className={`${fieldClass} w-16`}
          />
          <span className="text-[10px] text-maestro-muted">minutes</span>
        </div>

        <div className={rowClass}>
          <span className={nameClass}>Take issues</span>
          <input
            type="text"
            value={settings.label}
            onChange={(event) => setDraft({ label: event.target.value })}
            placeholder="labelled… (blank = every open issue)"
            className={`${fieldClass} min-w-0 flex-1`}
          />
        </div>

        <div className={rowClass}>
          <span className={nameClass}>At most</span>
          <input
            type="number"
            min={1}
            max={10}
            value={settings.maxAgents}
            onChange={(event) => setDraft({ maxAgents: Number(event.target.value) })}
            className={`${fieldClass} w-16`}
          />
          <span className="text-[10px] text-maestro-muted">agents at once</span>
        </div>

        <div className={rowClass}>
          <span className={nameClass}>Autonomy</span>
          <div className="flex overflow-hidden rounded border border-maestro-border">
            {AUTONOMY_LEVELS.map((level: AutonomyLevel) => (
              <button
                key={level}
                type="button"
                onClick={() => setDraft({ autonomy: level })}
                aria-pressed={settings.autonomy === level}
                title={AUTONOMY_LEVEL_BLURB[level]}
                className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                  settings.autonomy === level
                    ? "bg-maestro-accent/20 text-maestro-accent"
                    : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
                }`}
              >
                {level}
              </button>
            ))}
          </div>
          {/* Says what this dial actually does, so it does not read as a
              second copy of the ladder below. */}
          <span className="text-[10px] text-maestro-muted/70">
            sets the ladder's default rung when the loop starts
          </span>
        </div>

        {running && view && !view.scheduleOwnsLoop && (
          <p className="text-[10px] text-maestro-muted">
            This loop was not started by the schedule, so the window will not stop it.
          </p>
        )}
      </PanelSection>

      <PanelSection
        title="Overnight window"
        hint={settings.windowEnabled ? describeWindow(settings) : "off"}
        action={
          draft && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={discardDraft}
                className="rounded px-1.5 py-0.5 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={isBusy || problem !== null}
                title={problem ?? "Save the window and these settings"}
                className="flex items-center gap-1 rounded border border-maestro-accent/50 px-2 py-0.5 text-[11px] font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/10 disabled:opacity-40"
              >
                <Save size={10} /> Save
              </button>
            </div>
          )
        }
      >
        <label className="flex items-center gap-2 text-[11px] text-maestro-text">
          <input
            type="checkbox"
            checked={settings.windowEnabled}
            onChange={(event) => setDraft({ windowEnabled: event.target.checked })}
            className="accent-maestro-accent"
          />
          <Moon size={11} className="text-maestro-muted" />
          Run unattended between
          <input
            type="time"
            value={formatClock(settings.startMinute)}
            onChange={(event) => {
              const minute = parseClock(event.target.value);
              if (minute !== null) setDraft({ startMinute: minute });
            }}
            className={`${fieldClass} w-24`}
          />
          and
          <input
            type="time"
            value={formatClock(settings.stopMinute)}
            onChange={(event) => {
              const minute = parseClock(event.target.value);
              if (minute !== null) setDraft({ stopMinute: minute });
            }}
            className={`${fieldClass} w-24`}
          />
        </label>

        {problem && <p className="text-[10px] text-maestro-yellow">{problem}</p>}

        {/* The anti-silence line. Always present, always naming a time. */}
        <p className="flex items-center gap-1.5 rounded border border-maestro-border px-2 py-1 text-[11px] text-maestro-text">
          <CalendarClock size={11} className="shrink-0 text-maestro-muted" />
          {view ? nextWindowLine(view) : "Reading the schedule…"}
        </p>

        {draft && (
          <p className="text-[10px] text-maestro-muted/70">
            Unsaved. The schedule keeps running the saved window until you save this one.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
            What happened
          </span>
          {view?.outcomes.length ? (
            view.outcomes
              .slice(0, VISIBLE_OUTCOMES)
              .map((outcome) => (
                <OutcomeRow key={`${outcome.at}-${outcome.action}`} outcome={outcome} />
              ))
          ) : (
            <EmptyLine>
              Nothing yet. Every start and stop lands here, including a window that could not run.
            </EmptyLine>
          )}
        </div>
      </PanelSection>
    </div>
  );
}
