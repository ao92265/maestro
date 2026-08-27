import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useActEngineStore } from "../useActEngineStore";

const invokeMock = vi.mocked(invoke);

const NOT_RUNNING = {
  state: "notRunning" as const,
  managed: false,
  directory: "/Users/a/Repos/act-full",
  detail: "Not running.",
};
const LIVE = {
  state: "live" as const,
  managed: true,
  directory: "/Users/a/Repos/act-full",
  detail: null,
};

describe("useActEngineStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useActEngineStore.setState({
      status: null,
      starting: false,
      error: null,
    });
  });

  it("reads the engine status", async () => {
    invokeMock.mockResolvedValue(NOT_RUNNING);

    await useActEngineStore.getState().refresh();

    expect(invokeMock).toHaveBeenCalledWith("act_engine_status");
    expect(useActEngineStore.getState().status?.state).toBe("notRunning");
  });

  /* An absent ACT is a normal state, not a failure: a rejected status probe
     must not paint an error banner over the lane. */
  it("treats an unreadable status as not running, without an error", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));

    await useActEngineStore.getState().refresh();

    expect(useActEngineStore.getState().status?.state).toBe("notRunning");
    expect(useActEngineStore.getState().error).toBeNull();
  });

  it("holds the starting flag for the whole spawn, then clears it", async () => {
    let resolveStart: (value: typeof LIVE) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve as (value: typeof LIVE) => void;
        }),
    );

    const pending = useActEngineStore.getState().start();
    expect(useActEngineStore.getState().starting).toBe(true);

    resolveStart(LIVE);
    await pending;

    expect(useActEngineStore.getState().starting).toBe(false);
    expect(useActEngineStore.getState().status?.state).toBe("live");
  });

  /* A failed start is the one case that DOES need words on screen: he pressed
     a button and nothing happened. Keep the reason ACT gave. */
  it("keeps the reason when a start fails", async () => {
    invokeMock.mockRejectedValue(new Error("ACT exited while starting."));

    await useActEngineStore.getState().start();

    expect(useActEngineStore.getState().error).toContain("exited while starting");
    expect(useActEngineStore.getState().starting).toBe(false);
  });

  it("clears a previous error when a later start works", async () => {
    useActEngineStore.setState({ error: "old failure" });
    invokeMock.mockResolvedValue(LIVE);

    await useActEngineStore.getState().start();

    expect(useActEngineStore.getState().error).toBeNull();
  });

  it("stops the engine and takes the returned status", async () => {
    invokeMock.mockResolvedValue(NOT_RUNNING);

    await useActEngineStore.getState().stop();

    expect(invokeMock).toHaveBeenCalledWith("act_engine_stop");
    expect(useActEngineStore.getState().status?.state).toBe("notRunning");
  });
});
