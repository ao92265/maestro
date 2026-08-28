import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEcosystemStore } from "@/stores/useEcosystemStore";
import { EcosystemStrip } from "../EcosystemStrip";

const service = (name: string, port: number, up: boolean) => ({
  name,
  port,
  up,
  detail: up ? "Answering" : "Not running",
});

function setHealth(health: ReturnType<typeof useEcosystemStore.getState>["health"]) {
  useEcosystemStore.setState({ health, refresh: vi.fn(async () => {}) });
}

describe("EcosystemStrip", () => {
  beforeEach(() => {
    setHealth(null);
  });

  it("says how many systems are up at a glance", () => {
    setHealth({
      services: [service("ACT", 3847, true), service("Codor bus", 8137, false)],
      jobs: { healthy: 7, total: 7, failing: [] },
    });

    render(<EcosystemStrip />);

    expect(screen.getByText("1/2")).toBeTruthy();
  });

  /* The rule the old boards broke: a down tile has to say what the state
     MEANS. A truncated socket error defeats the glance it exists for. */
  it("names what is down in words, not in error codes", () => {
    setHealth({
      services: [service("ACT", 3847, false)],
      jobs: { healthy: 7, total: 7, failing: [] },
    });

    render(<EcosystemStrip />);
    fireEvent.click(screen.getByRole("button", { name: /systems/i }));

    expect(screen.getByText("ACT")).toBeTruthy();
    expect(screen.getByText("Not running")).toBeTruthy();
  });

  it("names a failing background job and why", () => {
    setHealth({
      services: [service("ACT", 3847, true)],
      jobs: { healthy: 6, total: 7, failing: [{ label: "com.nanoclaw", reason: "not loaded" }] },
    });

    render(<EcosystemStrip />);
    fireEvent.click(screen.getByRole("button", { name: /systems/i }));

    expect(screen.getByText("com.nanoclaw")).toBeTruthy();
    expect(screen.getByText("not loaded")).toBeTruthy();
  });

  /* Nothing at all is honest about being nothing: no reading is not the same
     as everything being fine, and must never render as a green count. */
  it("shows no count when it has no reading it can trust", () => {
    render(<EcosystemStrip />);

    expect(screen.queryByText(/\d+\/\d+/)).toBeNull();
  });
});
