import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { hasSeenTour, useTourStore } from "@/stores/useTourStore";
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
});
