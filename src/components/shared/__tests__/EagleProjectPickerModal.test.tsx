import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EagleProjectPickerModal } from "../EagleProjectPickerModal";
import type { EagleProjectOption } from "../TopBar";

function buildProjects(): EagleProjectOption[] {
  return [
    { tabId: "a", name: "alpha", color: "#f00", atMax: false },
    { tabId: "b", name: "bravo", color: "#0f0", atMax: true },
    { tabId: "c", name: "charlie", color: "#00f", atMax: false },
  ];
}

// act() flushes the selection state update (and the effect re-registration
// that captures it) before the next key arrives — mirrors real typing cadence.
function dispatchKey(key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

describe("EagleProjectPickerModal", () => {
  it("Enter picks the first selectable project by default", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    dispatchKey("Enter");

    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("ArrowDown skips projects at the session cap and wraps around", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    dispatchKey("ArrowDown"); // alpha → (skips bravo) → charlie
    dispatchKey("Enter");
    expect(onPick).toHaveBeenLastCalledWith("c");

    dispatchKey("ArrowDown"); // charlie → wraps → alpha
    dispatchKey("Enter");
    expect(onPick).toHaveBeenLastCalledWith("a");
  });

  it("ArrowUp wraps backwards, skipping projects at the cap", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    dispatchKey("ArrowUp"); // alpha → (skips bravo) → charlie
    dispatchKey("Enter");

    expect(onPick).toHaveBeenLastCalledWith("c");
  });

  it("Escape closes without picking", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={onClose} />,
    );

    const ev = dispatchKey("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Enter is a no-op when every project is at the cap", () => {
    const onPick = vi.fn();
    const projects = buildProjects().map((p) => ({ ...p, atMax: true }));
    render(<EagleProjectPickerModal projects={projects} onPick={onPick} onClose={vi.fn()} />);

    dispatchKey("ArrowDown");
    dispatchKey("Enter");

    expect(onPick).not.toHaveBeenCalled();
  });

  it("clicking a selectable row picks it; at-cap rows are disabled", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /charlie/ }));
    expect(onPick).toHaveBeenCalledWith("c");

    expect(screen.getByRole("button", { name: /bravo/ })).toBeDisabled();
  });
});
