import { ShieldAlert, ShieldCheck } from "lucide-react";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import {
  type ActInterventionEvent,
  type ActInterventionRule,
  describeThreshold,
} from "@/lib/actControl";
import { EmptyLine, PanelSection, relAgo } from "./primitives";

/** What an intervention did, coloured by how much it took away. */
const ACTION_BADGES: Record<string, string> = {
  stop: "bg-maestro-red/15 text-maestro-red",
  restart: "bg-maestro-orange/15 text-maestro-orange",
  failover: "bg-maestro-blue/15 text-maestro-blue",
  notify: "bg-maestro-muted/15 text-maestro-muted",
};

function actionBadge(action: string): string {
  return ACTION_BADGES[action] ?? "bg-maestro-muted/15 text-maestro-muted";
}

/**
 * The guardrails: the standing rules ACT enforces on its own agents, and the
 * feed of times it actually intervened.
 *
 * Read-only on purpose. ACT's `updateRule` is in-process only — no route
 * writes a rule back — so offering a toggle here would be a control that
 * silently does nothing.
 */
export function GuardrailFeed({
  rules,
  events,
}: {
  rules: ActInterventionRule[];
  events: ActInterventionEvent[];
}) {
  const enabled = rules.filter((rule) => rule.enabled).length;

  return (
    <>
      <PanelSection
        title="Guardrail rules"
        hint={rules.length > 0 ? `${enabled}/${rules.length} armed` : undefined}
      >
        {rules.length === 0 ? (
          <EmptyLine>No rules read from ACT.</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1">
            {rules.map((rule) => (
              <li key={rule.type} className="flex items-center gap-2">
                {rule.enabled ? (
                  <ShieldCheck size={11} className="shrink-0 text-maestro-green" />
                ) : (
                  <ShieldAlert size={11} className="shrink-0 text-maestro-muted" />
                )}
                <span
                  className={`w-40 shrink-0 truncate text-[11px] ${
                    rule.enabled ? "text-maestro-text" : "text-maestro-muted line-through"
                  }`}
                >
                  {rule.type.replace(/_/g, " ")}
                </span>
                <span className="flex-1 truncate text-[10px] text-maestro-muted">
                  past {describeThreshold(rule.type, rule.threshold)}
                </span>
                <span className={`${badgeBaseClass} ${actionBadge(rule.action)}`}>
                  {rule.action.toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Interventions"
        hint={events.length > 0 ? `${events.length} recorded` : undefined}
      >
        {events.length === 0 ? (
          <EmptyLine>ACT has not had to step in.</EmptyLine>
        ) : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {events.map((event, index) => (
              <li
                // ACT's history has no event id; a rule can fire on the same
                // agent twice in one second, so the index completes the key.
                key={`${event.timestamp}-${event.agentId}-${index}`}
                className="flex items-center gap-2"
              >
                <span className={`${badgeBaseClass} ${actionBadge(event.action)}`}>
                  {event.action.toUpperCase()}
                </span>
                <span className="w-32 shrink-0 truncate text-[11px] text-maestro-text">
                  {event.ruleType.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-maestro-muted">
                  {event.reason || event.agentId}
                </span>
                <span className="shrink-0 text-[10px] text-maestro-muted">
                  {relAgo(event.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  );
}
