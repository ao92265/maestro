import { Loader2, Sparkles, X } from "lucide-react";
import { badgeBaseClass } from "@/components/session/agentPresentation";
import { useReplyDraftStore } from "@/stores/useReplyDraftStore";

/**
 * The AI-drafted unblock reply, shown as what it is: a suggestion.
 *
 * The dialog never sends. Its primary action puts the text into the session's
 * input line and takes the user there to read it and press Enter themselves —
 * the wording, the button label and the store's `insert` all say the same
 * thing, because a draft that could send itself is a different feature.
 */
export function ReplyDraftDialog({ onNavigate }: { onNavigate: (sessionId: number) => void }) {
  const { target, status, draft, error, setDraft, redraft, insert, close } = useReplyDraftStore();

  if (!target) return null;

  const drafting = status === "drafting";
  const canInsert = draft.trim().length > 0;

  return (
    /* z-[60]: above the Home overlay (z-50) that opened it. */
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-xl flex-col gap-3 rounded border border-maestro-border bg-maestro-bg p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="shrink-0 text-maestro-accent" />
          <h2 className="text-[12px] font-semibold text-maestro-text">Suggested reply</h2>
          <span className={`${badgeBaseClass} bg-maestro-yellow/15 text-maestro-yellow`}>
            DRAFT — NOT SENT
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-maestro-muted transition-colors hover:text-maestro-text"
            aria-label="Close draft"
          >
            <X size={13} />
          </button>
        </div>

        <p className="text-[11px] text-maestro-muted">
          <span className="text-maestro-text">Asked:</span> {target.question}
        </p>

        {drafting ? (
          <div className="flex items-center gap-2 rounded border border-dashed border-maestro-border px-3 py-6 text-[11px] text-maestro-muted">
            <Loader2 size={13} className="animate-spin" /> Drafting a reply…
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="Nothing drafted — write the reply yourself."
            className="w-full resize-y rounded border border-maestro-border bg-maestro-card px-2 py-1.5 text-[12px] text-maestro-text outline-none focus:border-maestro-accent"
            aria-label="Suggested reply, editable before sending"
          />
        )}

        {error && (
          <p className="text-[11px] text-maestro-red">
            Could not draft a reply: {error}. Your text is untouched — write the reply yourself, or
            try again.
          </p>
        )}

        <p className="text-[10px] text-maestro-muted/70">
          Edit this first. "Insert into session" types it into the terminal's input and leaves it
          there — you press Enter to send it.
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void redraft()}
            disabled={drafting}
            className="rounded border border-maestro-border px-2 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-50"
          >
            Draft again
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={close}
            className="rounded border border-maestro-border px-2 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const sessionId = target.sessionId;
              void insert()
                .then(() => {
                  close();
                  onNavigate(sessionId);
                })
                .catch((err) => console.error("Failed to insert draft:", err));
            }}
            disabled={!canInsert || drafting}
            className="rounded border border-maestro-accent/60 px-2 py-1 text-[11px] text-maestro-text transition-colors hover:bg-maestro-accent/10 disabled:opacity-40"
            title="Puts the text in the session's input for you to send"
          >
            Insert into session
          </button>
        </div>
      </div>
    </div>
  );
}
