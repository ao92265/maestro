import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EagleProjectSwitcher } from "../EagleProjectSwitcher";

const projects = [
  { tabId: "t1", name: "alpha", color: "#ff0000" },
  { tabId: "t2", name: "beta", color: "#00ff00" },
  { tabId: "t3", name: "gamma", color: "#0000ff" },
];

/** Position dots are the only 1.5x1.5 rounded spans in the strip. */
function positionDots(container: HTMLElement) {
  return Array.from(container.querySelectorAll("span.h-1\\.5.w-1\\.5"));
}

describe("EagleProjectSwitcher", () => {
  it("shows the current project's name", () => {
    render(
      <EagleProjectSwitcher projects={projects} index={1} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("renders one position dot per project with the current one highlighted", () => {
    const { container } = render(
      <EagleProjectSwitcher projects={projects} index={1} onPrev={() => {}} onNext={() => {}} />,
    );
    const dots = positionDots(container);
    expect(dots).toHaveLength(3);
    expect(dots[1]?.className).toContain("bg-maestro-accent");
    expect(dots[0]?.className).toContain("bg-maestro-muted/40");
    expect(dots[2]?.className).toContain("bg-maestro-muted/40");
  });

  it("fires onPrev/onNext from the arrow buttons", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<EagleProjectSwitcher projects={projects} index={0} onPrev={onPrev} onNext={onNext} />);
    fireEvent.click(screen.getByRole("button", { name: "Next project" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous project" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("disables both arrows and hides the dots with a single project", () => {
    const { container } = render(
      <EagleProjectSwitcher
        projects={[projects[0]!]}
        index={0}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next project" })).toBeDisabled();
    expect(positionDots(container)).toHaveLength(0);
  });

  it("swipes with a horizontal wheel: deltaX > 0 fires onNext once per gesture", () => {
    const onNext = vi.fn();
    const { container } = render(
      <EagleProjectSwitcher projects={projects} index={0} onPrev={() => {}} onNext={onNext} />,
    );
    const strip = container.firstElementChild!;
    fireEvent.wheel(strip, { deltaX: 40, deltaY: 0 });
    // Burst of momentum events within the cooldown must not re-fire.
    fireEvent.wheel(strip, { deltaX: 40, deltaY: 0 });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("swipes with a horizontal wheel: deltaX < 0 fires onPrev", () => {
    const onPrev = vi.fn();
    const { container } = render(
      <EagleProjectSwitcher projects={projects} index={1} onPrev={onPrev} onNext={() => {}} />,
    );
    fireEvent.wheel(container.firstElementChild!, { deltaX: -40, deltaY: 0 });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("ignores vertical-dominant wheel events", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { container } = render(
      <EagleProjectSwitcher projects={projects} index={0} onPrev={onPrev} onNext={onNext} />,
    );
    fireEvent.wheel(container.firstElementChild!, { deltaX: 10, deltaY: 40 });
    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });
});
