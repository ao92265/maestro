import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/terminal", () => ({ writeStdin: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { writeStdin } from "@/lib/terminal";
import { type ReplyDraftTarget, useReplyDraftStore } from "../useReplyDraftStore";

const invokeMock = vi.mocked(invoke);
const writeStdinMock = vi.mocked(writeStdin);

function target(overrides: Partial<ReplyDraftTarget> = {}): ReplyDraftTarget {
  return {
    sessionId: 7,
    projectPath: "/repo",
    question: "Deploy to prod?",
    repo: "maestro",
    branch: "feat/x",
    statusMessage: null,
    ...overrides,
  };
}

function reset() {
  useReplyDraftStore.setState({ target: null, status: "idle", draft: "", error: null });
}

describe("useReplyDraftStore", () => {
  beforeEach(() => {
    reset();
    invokeMock.mockReset();
    writeStdinMock.mockClear();
  });

  it("open drafts via the backend and lands in a ready, editable state", async () => {
    invokeMock.mockResolvedValueOnce("yes, deploy it");

    await useReplyDraftStore.getState().open(target());

    expect(invokeMock).toHaveBeenCalledWith("draft_session_reply", {
      context: {
        projectPath: "/repo",
        question: "Deploy to prod?",
        repo: "maestro",
        branch: "feat/x",
        statusMessage: null,
      },
    });
    const s = useReplyDraftStore.getState();
    expect(s.status).toBe("ready");
    expect(s.draft).toBe("yes, deploy it");
    expect(s.error).toBeNull();
  });

  it("opens immediately in the drafting state so the panel is never blank", async () => {
    let resolve: (v: string) => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise<string>((r) => {
        resolve = r;
      }),
    );

    const pending = useReplyDraftStore.getState().open(target());
    expect(useReplyDraftStore.getState().status).toBe("drafting");
    expect(useReplyDraftStore.getState().target?.sessionId).toBe(7);

    resolve("ok");
    await pending;
    expect(useReplyDraftStore.getState().status).toBe("ready");
  });

  it("a failed draft surfaces the error and never invents a draft", async () => {
    invokeMock.mockRejectedValueOnce("Claude CLI not found on PATH");

    await useReplyDraftStore.getState().open(target());

    const s = useReplyDraftStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("Claude CLI not found on PATH");
    expect(s.draft).toBe("");
  });

  /* Opening a second session while the first draft is still running must not
     drop the first session's answer into the second session's box. */
  it("a late draft for a superseded target is discarded", async () => {
    let resolveFirst: (v: string) => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise<string>((r) => {
        resolveFirst = r;
      }),
    );
    const first = useReplyDraftStore.getState().open(target({ sessionId: 7 }));

    invokeMock.mockResolvedValueOnce("second answer");
    await useReplyDraftStore.getState().open(target({ sessionId: 9 }));

    resolveFirst("first answer");
    await first;

    const s = useReplyDraftStore.getState();
    expect(s.target?.sessionId).toBe(9);
    expect(s.draft).toBe("second answer");
  });

  it("setDraft keeps the user's edit and leaves it ready to insert", () => {
    useReplyDraftStore.setState({ target: target(), status: "ready", draft: "ai text" });

    useReplyDraftStore.getState().setDraft("my own words");

    expect(useReplyDraftStore.getState().draft).toBe("my own words");
    expect(useReplyDraftStore.getState().status).toBe("ready");
  });

  it("redraft re-runs against the same target", async () => {
    invokeMock.mockResolvedValueOnce("first");
    await useReplyDraftStore.getState().open(target());
    invokeMock.mockResolvedValueOnce("second");

    await useReplyDraftStore.getState().redraft();

    expect(useReplyDraftStore.getState().draft).toBe("second");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  /* The whole point of the feature: the draft is a suggestion. Inserting puts
     the text in the terminal's input for the user to press Enter on — a
     trailing newline here would submit it for them. */
  it("insert pastes the text without a trailing newline", async () => {
    useReplyDraftStore.setState({ target: target(), status: "ready", draft: "yes, deploy it" });

    await useReplyDraftStore.getState().insert();

    expect(writeStdinMock).toHaveBeenCalledWith(7, "yes, deploy it");
    const written = String(writeStdinMock.mock.calls[0][1]);
    expect(written.endsWith("\n")).toBe(false);
    expect(written).not.toContain("\r");
  });

  it("insert does nothing when the draft is blank", async () => {
    useReplyDraftStore.setState({ target: target(), status: "ready", draft: "   " });

    await useReplyDraftStore.getState().insert();

    expect(writeStdinMock).not.toHaveBeenCalled();
  });

  it("close clears the panel", async () => {
    invokeMock.mockResolvedValueOnce("text");
    await useReplyDraftStore.getState().open(target());

    useReplyDraftStore.getState().close();

    expect(useReplyDraftStore.getState()).toMatchObject({
      target: null,
      status: "idle",
      draft: "",
      error: null,
    });
  });

  /* The draft is text for the box, not a decision about the session. If the
     agent moved on while Claude was drafting, the user still gets to paste
     and edit what was written. */
  it("insert still pastes when the session is no longer blocked", async () => {
    useReplyDraftStore.setState({
      target: target({ question: "" }),
      status: "error",
      draft: "yes, deploy it",
    });

    await useReplyDraftStore.getState().insert();

    expect(writeStdinMock).toHaveBeenCalledWith(7, "yes, deploy it");
  });

  /* A CLI that was not on PATH, or a run that hit the timeout, must not cost
     the user the text they had already written. */
  it("a failed redraft leaves the existing text untouched", async () => {
    invokeMock.mockResolvedValueOnce("ai suggestion");
    await useReplyDraftStore.getState().open(target());
    useReplyDraftStore.getState().setDraft("my own edit");

    invokeMock.mockRejectedValueOnce("Claude run timed out after 60s");
    await useReplyDraftStore.getState().redraft();

    const s = useReplyDraftStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("timed out");
    expect(s.draft).toBe("my own edit");
  });

  it("a failed redraft never pastes a partial answer", async () => {
    useReplyDraftStore.setState({ target: target(), status: "ready", draft: "" });
    invokeMock.mockRejectedValueOnce("Claude returned an empty draft.");

    await useReplyDraftStore.getState().redraft();
    await useReplyDraftStore.getState().insert();

    expect(writeStdinMock).not.toHaveBeenCalled();
  });
});
