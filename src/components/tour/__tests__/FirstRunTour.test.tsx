import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { hasSeenTour, initialTourOpen, TOUR_STEP_COUNT, useTourStore } from "@/stores/useTourStore";
import { FirstRunTour, TOUR_STEPS } from "../FirstRunTour";

describe("FirstRunTour", () => {
  beforeEach(() => {
    localStorage.clear();
    useTourStore.setState({ isOpen: true, step: 0 });
  });

  it("walks forward through every step and closes on Done", () => {
    render(<FirstRunTour />);

    for (const step of TOUR_STEPS.slice(0, -1)) {
      expect(screen.getByText(step.title)).toBeInTheDocument();
      fireEvent.click(screen.getByText("Next"));
    }
    expect(screen.getByText(TOUR_STEPS[TOUR_STEPS.length - 1].title)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Done"));
    expect(useTourStore.getState().isOpen).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("marks the tour seen on ANY close, including skip on step one", () => {
    render(<FirstRunTour />);
    expect(hasSeenTour()).toBe(false);

    fireEvent.click(screen.getByLabelText("Skip tour"));

    // A skipped tour must never reopen on its own next launch.
    expect(hasSeenTour()).toBe(true);
    expect(useTourStore.getState().isOpen).toBe(false);
  });

  it("goes back without dropping below the first step", () => {
    render(<FirstRunTour />);
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText(TOUR_STEPS[1].title)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
    // Back is hidden on the first step, so the floor cannot be crossed.
    expect(screen.queryByText("Back")).not.toBeInTheDocument();
  });

  it("reopening after a close starts from the first step", () => {
    render(<FirstRunTour />);
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(screen.getByLabelText("Skip tour"));

    act(() => useTourStore.getState().open());
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    useTourStore.setState({ isOpen: false });
    render(<FirstRunTour />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("auto-opens on a fresh install only", () => {
    // The store initializer runs at module load, so the rule is guarded via
    // the pure function it delegates to: open with no marker, closed after
    // any close (which writes the marker).
    expect(initialTourOpen()).toBe(true);
    useTourStore.getState().close();
    expect(initialTourOpen()).toBe(false);
  });

  it("closes on Escape and counts that as seen", () => {
    render(<FirstRunTour />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTourStore.getState().isOpen).toBe(false);
    expect(hasSeenTour()).toBe(true);
  });

  it("next clamps at the last step instead of walking past it", () => {
    for (let i = 0; i < TOUR_STEPS.length + 3; i++) {
      useTourStore.getState().next();
    }
    expect(useTourStore.getState().step).toBe(TOUR_STEPS.length - 1);
  });

  it("keeps Tab cycling inside the dialog", () => {
    render(<FirstRunTour />);
    const skip = screen.getByLabelText("Skip tour");
    const next = screen.getByText("Next");

    // Forward from the last button wraps to the first.
    next.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(skip);

    // Backward from the first button wraps to the last.
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(next);

    // Focus that escaped behind the backdrop gets pulled back in.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(skip);
  });

  it("hands focus back to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    useTourStore.setState({ isOpen: false });

    const { unmount } = render(<FirstRunTour />);
    act(() => useTourStore.getState().open());
    expect(document.activeElement).not.toBe(opener);

    act(() => useTourStore.getState().close());
    expect(document.activeElement).toBe(opener);

    unmount();
    opener.remove();
  });

  it("keeps the store's step count in sync with the cards", () => {
    // The clamp lives in the store, the cards in the component; this is the
    // tripwire for whoever adds a card without bumping the count.
    expect(TOUR_STEPS.length).toBe(TOUR_STEP_COUNT);
  });
});
