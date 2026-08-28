import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, GitPullRequest } from "lucide-react";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import { type ActLedgerEntry, attemptsOf, deliveredPrs } from "@/lib/actControl";
import { EmptyLine, PanelSection, relAgo } from "./primitives";

const STATUS_BADGES: Record<string, string> = {
  completed: "bg-maestro-green/15 text-maestro-green",
  in_progress: "bg-maestro-blue/15 text-maestro-blue",
  blocked: "bg-maestro-accent/15 text-maestro-accent",
  failed: "bg-maestro-red/15 text-maestro-red",
  pending: "bg-maestro-muted/15 text-maestro-muted",
  archived: "bg-maestro-muted/15 text-maestro-muted",
};

function statusBadge(status: string): string {
  return STATUS_BADGES[status] ?? "bg-maestro-muted/15 text-maestro-muted";
}

function openExternal(url: string) {
  void openUrl(url).catch((err) => console.error("Failed to open:", err));
}

/**
 * The intake ledger: everything ACT took in, what each one cost in attempts,
 * and the PRs that came out the other end.
 *
 * Attempts matter more than status here — a task that shipped on its fourth
 * runtime is a different story from one that shipped first time, and ACT
 * records those as two separate counters.
 */
export function IntakeLedger({ ledger }: { ledger: ActLedgerEntry[] }) {
  const delivered = deliveredPrs(ledger);
  const retried = ledger.filter((entry) => attemptsOf(entry) > 1).length;

  return (
    <>
      <PanelSection
        title="Intake ledger"
        hint={
          ledger.length > 0
            ? `${ledger.length} tasks · ${retried} needed more than one attempt`
            : undefined
        }
      >
        {ledger.length === 0 ? (
          <EmptyLine>Nothing in the ledger yet.</EmptyLine>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {ledger.map((entry) => {
              const attempts = attemptsOf(entry);
              return (
                <li key={entry.id} className="flex items-center gap-2">
                  <span className={`${badgeBaseClass} ${statusBadge(entry.status)}`}>
                    {entry.status.replace(/_/g, " ").toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-text">
                    {entry.title}
                  </span>
                  {entry.blockReason && (
                    <span className="shrink-0 text-[10px] text-maestro-accent">
                      {entry.blockReason.replace(/_/g, " ")}
                    </span>
                  )}
                  <span
                    className={`shrink-0 font-mono text-[10px] ${
                      attempts > 1 ? "text-maestro-orange" : "text-maestro-muted"
                    }`}
                    title={
                      attempts > 1
                        ? `${entry.retryCount} retries, ${entry.failoverCount} runtime failovers${
                            entry.lastFailoverReason ? ` — ${entry.lastFailoverReason}` : ""
                          }`
                        : "Ran once"
                    }
                  >
                    {attempts}×
                  </span>
                  {entry.prUrl ? (
                    <button
                      type="button"
                      onClick={() => entry.prUrl && openExternal(entry.prUrl)}
                      className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:text-maestro-text"
                      aria-label={`Open the PR for ${entry.title}`}
                    >
                      <GitPullRequest size={11} />
                    </button>
                  ) : (
                    <span className="w-[18px] shrink-0" />
                  )}
                  <span className="w-14 shrink-0 text-right text-[10px] text-maestro-muted">
                    {relAgo(entry.completedAt ?? entry.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Delivered"
        hint={delivered.length > 0 ? `${delivered.length} PRs` : undefined}
      >
        {delivered.length === 0 ? (
          <EmptyLine>No PRs delivered yet.</EmptyLine>
        ) : (
          <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {delivered.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => entry.prUrl && openExternal(entry.prUrl)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-maestro-bg"
                >
                  <GitPullRequest size={11} className="shrink-0 text-maestro-green" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-text">
                    {entry.title}
                  </span>
                  {entry.branchName && (
                    <span className="hidden max-w-40 truncate font-mono text-[10px] text-maestro-muted lg:block">
                      {entry.branchName}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-maestro-muted">
                    {relAgo(entry.completedAt)}
                  </span>
                  <ExternalLink size={10} className="shrink-0 text-maestro-muted" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  );
}
