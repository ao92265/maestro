import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// TopBar reads the real Tauri window unconditionally on mount (the
// minimize/maximize/close handlers close over it even though
// hideWindowControls keeps those buttons out of these tests).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

import { useHealthStore } from "@/stores/useHealthStore";
import { TopBar } from "../TopBar";

function renderTopBar(overrides: Partial<ComponentProps<typeof TopBar>> = {}) {
  const handlers = {
    onToggleSidebar: vi.fn(),
    onToggleLandscapeView: vi.fn(),
    onToggleMemoryPanel: vi.fn(),
    onOpenWorkflows: vi.fn(),
    onOpenExtensions: vi.fn(),
  };
  render(<TopBar sidebarOpen hideWindowControls {...handlers} {...overrides} />);
  return handlers;
}

describe("TopBar", () => {
  beforeEach(() => {
    useHealthStore.setState({ flags: [] });
  });

  it("does not render the buttons cut by the declutter (Notes, Second Brain, Launch)", () => {
    renderTopBar();
    for (const label of ["Notes", "Second Brain", "Launch"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    // Landscape and Memory also lose their standalone buttons — only the
    // "Landscape view" aria-label is unique to the old button, so check that.
    expect(screen.queryByRole("button", { name: "Landscape view" })).not.toBeInTheDocument();
  });

  it("renders the More menu closed by default and opens it on click", () => {
    renderTopBar();
    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByRole("button", { name: "Landscape" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extensions" })).toBeInTheDocument();
  });

  it("dispatches onToggleLandscapeView and closes the menu", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Landscape" }));

    expect(handlers.onToggleLandscapeView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
  });

  it("dispatches onToggleMemoryPanel", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));

    expect(handlers.onToggleMemoryPanel).toHaveBeenCalledTimes(1);
  });

  it("dispatches onOpenWorkflows", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));

    expect(handlers.onOpenWorkflows).toHaveBeenCalledTimes(1);
  });

  it("dispatches onOpenExtensions", () => {
    const handlers = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));

    expect(handlers.onOpenExtensions).toHaveBeenCalledTimes(1);
  });

  it("closes the More menu on an outside click", () => {
    renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Landscape" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("button", { name: "Landscape" })).not.toBeInTheDocument();
  });

  it("shows an aggregated dot on the More button when Memory has a health flag", () => {
    useHealthStore.setState({
      flags: [
        {
          key: "memory:maestro",
          area: "memory",
          scope: "maestro",
          target: "maestro",
          reason: "12 stale files",
        },
      ],
    });
    renderTopBar();

    const moreButton = screen.getByRole("button", { name: "More" });
    expect(moreButton.querySelector("span[aria-hidden]")).toBeInTheDocument();
  });

  it("shows the per-item health badge on the Memory row inside the menu", () => {
    useHealthStore.setState({
      flags: [
        {
          key: "memory:maestro",
          area: "memory",
          scope: "maestro",
          target: "maestro",
          reason: "12 stale files",
        },
      ],
    });
    renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByLabelText("1 health item need a look")).toBeInTheDocument();
  });
});
