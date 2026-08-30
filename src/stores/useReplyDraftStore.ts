import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { writeStdin } from "@/lib/terminal";

/**
 * The AI-drafted unblock reply for a session that stopped on a question.
 *
 * The draft is a SUGGESTION, start to finish. `insert` pastes it into the
 * session's input without a newline — a newline at a TUI prompt is the send,
 * so the user still presses Enter themselves. Nothing in this store, and
 * nothing in the Rust command behind it, ever submits a reply.
 *
 * Failure convention matches `useBandStore`: a draft that fails records the
 * error and shows it in the panel. An unreachable Claude CLI costs the user
 * the suggestion, never the ability to answer the session by hand.
 */

export type ReplyDraftStatus = "idle" | "drafting" | "ready" | "error";

export interface ReplyDraftTarget {
  sessionId: number;
  /** Working directory for the headless run — the session's own repo. */
  projectPath: string;
  /** The question the agent stopped on. */
  question: string;
  repo: string | null;
  branch: string | null;
  statusMessage: string | null;
}

/**
 * Guards against a slow draft for a session the user has already navigated
 * away from landing in the panel for a different one.
 */
let requestSeq = 0;

interface ReplyDraftState {
  target: ReplyDraftTarget | null;
  status: ReplyDraftStatus;
  draft: string;
  error: string | null;
  /** Open the panel for a blocked session and start drafting. */
  open: (target: ReplyDraftTarget) => Promise<void>;
  /** The user's edit wins over the suggestion. */
  setDraft: (text: string) => void;
  /** Re-run the draft for the current target. */
  redraft: () => Promise<void>;
  /** Paste the current text into the session's input. Never sends it. */
  insert: () => Promise<void>;
  close: () => void;
}

async function runDraft(target: ReplyDraftTarget, seq: number, set: SetState): Promise<void> {
  try {
    const draft = await invoke<string>("draft_session_reply", {
      context: {
        projectPath: target.projectPath,
        question: target.question,
        repo: target.repo,
        branch: target.branch,
        statusMessage: target.statusMessage,
      },
    });
    if (seq !== requestSeq) return;
    set({ status: "ready", draft, error: null });
  } catch (err) {
    if (seq !== requestSeq) return;
    /* Deliberately does NOT touch `draft`. A failed or timed-out run must
       never leave a partial answer in the box, and on a re-draft the text
       already there is the user's own edit — losing it to a CLI that was not
       on PATH would be the worse failure. */
    set({ status: "error", error: String(err) });
  }
}

type SetState = (partial: Partial<ReplyDraftState>) => void;

export const useReplyDraftStore = create<ReplyDraftState>((set, get) => ({
  target: null,
  status: "idle",
  draft: "",
  error: null,

  open: async (target) => {
    requestSeq += 1;
    const seq = requestSeq;
    set({ target, status: "drafting", draft: "", error: null });
    await runDraft(target, seq, set);
  },

  setDraft: (text) => set({ draft: text }),

  redraft: async () => {
    const { target } = get();
    if (!target) return;
    requestSeq += 1;
    const seq = requestSeq;
    // The existing text stays put until a new draft actually arrives.
    set({ status: "drafting", error: null });
    await runDraft(target, seq, set);
  },

  insert: async () => {
    const { target, draft } = get();
    /* Status-agnostic on purpose: a draft written while the session was
       blocked is still the reply the user wants in the box if the agent has
       moved on in the meantime. Pasting text is always safe — it is the
       Enter that sends, and that stays the user's. */
    if (!target || !draft.trim()) return;
    // No trailing newline, and no carriage return: this lands in the input
    // line for the user to read and press Enter on. See the module comment.
    await writeStdin(target.sessionId, draft.trim());
  },

  close: () => {
    // Bump the sequence so an in-flight draft cannot reopen a closed panel.
    requestSeq += 1;
    set({ target: null, status: "idle", draft: "", error: null });
  },
}));
