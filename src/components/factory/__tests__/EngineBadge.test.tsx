import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActEngineStore } from "@/stores/useActEngineStore";
import { EngineBadge } from "../EngineBadge";

function setEngine(partial: Partial<ReturnType<typeof useActEngineStore.getState>>) {
  useActEngineStore.setState(partial);
}

describe("EngineBadge", () => {
  beforeEach(() => {
    setEngine({
      status: null,
      starting: false,
      error: null,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    });
  });

  it("offers a way to start ACT when nothing is running", () => {
    setEngine({
      status: {
        state: "notRunning",
        managed: false,
        directory: "/repos/act",
        detail: "Not running.",
      },
    });

    render(<EngineBadge runsFetchedAt={0} stale={false} />);

    expect(screen.getByText("ACT OFFLINE")).toBeTruthy();
    expect(screen.getByRole("button", { name: /start act/i })).toBeTruthy();
  });

  it("starts the engine when the control is pressed", () => {
    const start = vi.fn(async () => {});
    setEngine({
      status: { state: "notRunning", managed: false, directory: "/repos/act", detail: null },
      start,
    });

    render(<EngineBadge runsFetchedAt={0} stale={false} />);
    fireEvent.click(screen.getByRole("button", { name: /start act/i }));

    expect(start).toHaveBeenCalledTimes(1);
  });

  /* The gap between spawning and the port answering is the whole reason this
     is three states: showing OFFLINE there is what made it look broken. */
  it("says it is starting, and does not offer Start twice", () => {
    setEngine({
      status: { state: "starting", managed: true, directory: "/repos/act", detail: null },
      starting: true,
    });

    render(<EngineBadge runsFetchedAt={0} stale={false} />);

    expect(screen.getByText("ACT STARTING")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start act/i })).toBeNull();
  });

  it("shows live once the engine answers, with no start control", () => {
    setEngine({
      status: { state: "live", managed: true, directory: "/repos/act", detail: null },
    });

    render(<EngineBadge runsFetchedAt={Date.now()} stale={false} />);

    expect(screen.getByText("ACT LIVE")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start act/i })).toBeNull();
  });

  /* A live engine whose runs list has gone quiet is a different fault from a
     dead engine, and flattening the two sent him to restart the wrong thing. */
  it("keeps stale distinct from offline while the engine is up", () => {
    setEngine({
      status: { state: "live", managed: true, directory: "/repos/act", detail: null },
    });

    render(<EngineBadge runsFetchedAt={Date.now()} stale={true} />);

    expect(screen.getByText("ACT STALE")).toBeTruthy();
  });

  it("shows why a start failed, in the words the engine used", () => {
    setEngine({
      status: { state: "notRunning", managed: false, directory: "/repos/act", detail: null },
      error: "ACT exited while starting. Run it by hand in /repos/act to see why.",
    });

    render(<EngineBadge runsFetchedAt={0} stale={false} />);

    expect(screen.getByText(/exited while starting/i)).toBeTruthy();
  });
});
