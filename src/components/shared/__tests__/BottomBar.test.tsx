import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BottomBar } from "../BottomBar";

// The bar's neighbours (system metrics, usage, account) all poll on mount.
// The shared mock returns undefined, and useSystemMetrics chains `.then` on
// the result unguarded, which would poison the React root for every case here.
beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
});

function renderBottomBar(overrides: Partial<ComponentProps<typeof BottomBar>> = {}) {
  const handlers = {
    onLaunchAll: vi.fn(),
    onNavigateToSession: vi.fn(),
  };
  render(<BottomBar slotCount={0} launchedCount={0} {...handlers} {...overrides} />);
  return handlers;
}

describe("BottomBar launch button", () => {
  it("renders no button when there is nothing left to launch", () => {
    // The pivot's trigger case: a permanently disabled "Launch Sessions" was
    // the only state wearing that label. Hide until launchable.
    renderBottomBar({ slotCount: 0, launchedCount: 0 });
    expect(screen.queryByRole("button", { name: /launch/i })).not.toBeInTheDocument();
  });

  it("renders no button when every slot is already running", () => {
    renderBottomBar({ slotCount: 3, launchedCount: 3 });
    expect(screen.queryByRole("button", { name: /launch/i })).not.toBeInTheDocument();
  });

  it("labels a single unlaunched slot in the singular", () => {
    renderBottomBar({ slotCount: 1, launchedCount: 0 });
    expect(screen.getByRole("button", { name: "Launch Session" })).toBeEnabled();
  });

  it("counts the unlaunched slots when there is more than one", () => {
    renderBottomBar({ slotCount: 4, launchedCount: 1 });
    expect(screen.getByRole("button", { name: "Launch All (3)" })).toBeEnabled();
  });

  it("fires onLaunchAll on click", () => {
    const { onLaunchAll } = renderBottomBar({ slotCount: 2, launchedCount: 0 });

    fireEvent.click(screen.getByRole("button", { name: "Launch All (2)" }));

    expect(onLaunchAll).toHaveBeenCalledTimes(1);
  });
});
