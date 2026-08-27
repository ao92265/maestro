import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useExternalSessionsStore } from "../useExternalSessionsStore";

const invokeMock = vi.mocked(invoke);

const pane = (id: string, repoName: string | null, title = "work") => ({
  id,
  tty: "/dev/ttys001",
  cwd: repoName ? `/Users/a/Repos/${repoName}` : "/Users/a",
  title,
  repo: repoName ? `/Users/a/Repos/${repoName}` : null,
  repoName,
});

describe("useExternalSessionsStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useExternalSessionsStore.setState({ sessions: [], loading: false, error: null });
  });

  it("lists the terminals Maestro did not start", async () => {
    invokeMock.mockResolvedValue([pane("a", "maestro"), pane("b", "act")]);

    await useExternalSessionsStore.getState().refresh();

    expect(invokeMock).toHaveBeenCalledWith("list_external_sessions");
    expect(useExternalSessionsStore.getState().sessions).toHaveLength(2);
    expect(useExternalSessionsStore.getState().error).toBeNull();
  });

  /* iTerm closed, or automation permission not granted, is an empty list and
     not a failure: this section must never shout at him about a terminal app
     he simply is not running. */
  it("treats an unreadable terminal app as an empty list", async () => {
    invokeMock.mockRejectedValue(new Error("osascript died"));

    await useExternalSessionsStore.getState().refresh();

    expect(useExternalSessionsStore.getState().sessions).toEqual([]);
    expect(useExternalSessionsStore.getState().error).toBeNull();
    expect(useExternalSessionsStore.getState().loading).toBe(false);
  });

  it("drops a closed terminal from the list straight away", async () => {
    useExternalSessionsStore.setState({ sessions: [pane("a", "maestro"), pane("b", "act")] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "close_external_session") return null;
      return [pane("b", "act")];
    });

    await useExternalSessionsStore.getState().close("a");

    expect(invokeMock).toHaveBeenCalledWith("close_external_session", { id: "a" });
    expect(useExternalSessionsStore.getState().sessions.map((s) => s.id)).toEqual(["b"]);
  });

  /* Acting on a pane that has gone IS worth saying: he pressed a button and
     nothing happened, which is the case the silent path gets wrong. */
  it("says so when the terminal has already gone", async () => {
    invokeMock.mockRejectedValue(new Error("That terminal has gone."));

    await useExternalSessionsStore.getState().focus("a");

    expect(useExternalSessionsStore.getState().error).toContain("has gone");
  });

  it("clears an old error once an action works", async () => {
    useExternalSessionsStore.setState({ error: "That terminal has gone." });
    invokeMock.mockResolvedValue(null);

    await useExternalSessionsStore.getState().focus("b");

    expect(useExternalSessionsStore.getState().error).toBeNull();
  });
});

/* Regression guard: an answer that is not a list used to reach the section as
   `undefined` and take the whole panel down when it tried to group it. */
describe("useExternalSessionsStore robustness", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useExternalSessionsStore.setState({ sessions: [], loading: false, error: null });
  });

  it("keeps an empty list when the backend answers with nothing", async () => {
    invokeMock.mockResolvedValue(undefined);

    await useExternalSessionsStore.getState().refresh();

    expect(useExternalSessionsStore.getState().sessions).toEqual([]);
  });
});
