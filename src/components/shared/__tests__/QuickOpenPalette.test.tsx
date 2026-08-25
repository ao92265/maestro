import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QuickOpenItem } from "@/lib/quickOpen";
import { QuickOpenPalette } from "../QuickOpenPalette";

function buildItems(): QuickOpenItem[] {
  return [
    {
      id: "session:1",
      kind: "session",
      label: "alpha",
      sublabel: "main · repo",
      tabId: "t1",
      sessionId: 1,
    },
    {
      id: "session:2",
      kind: "session",
      label: "bravo",
      sublabel: "main · repo",
      tabId: "t1",
      sessionId: 2,
    },
    {
      id: "worktree:/wt/charlie",
      kind: "worktree",
      label: "charlie",
      sublabel: "/wt/charlie",
      tabId: "t1",
      sessionId: null,
    },
  ];
}

// act() flushes the selection state update (and the effect re-registration that
// captures it) before the next key arrives — mirrors real typing cadence.
function dispatchKey(key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

function type(value: string): void {
  const input = screen.getByRole("combobox");
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

function selectedLabel(): string | undefined {
  return (
    screen.getAllByRole("option").find((el) => el.getAttribute("aria-selected") === "true")
      ?.textContent ?? undefined
  );
}

function renderPalette(overrides: Partial<Parameters<typeof QuickOpenPalette>[0]> = {}) {
  const props = {
    items: buildItems(),
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<QuickOpenPalette {...props} />);
  return props;
}

describe("QuickOpenPalette", () => {
  it("lists every item before the user types", () => {
    renderPalette();

    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selects the first row by default", () => {
    renderPalette();

    expect(selectedLabel()).toContain("alpha");
  });

  it("filters the list as the user types", () => {
    renderPalette();

    type("bravo");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("bravo");
  });

  it("ArrowDown moves the selection down", () => {
    renderPalette();

    dispatchKey("ArrowDown");

    expect(selectedLabel()).toContain("bravo");
  });

  it("ArrowDown wraps around at the end of the list", () => {
    renderPalette();

    dispatchKey("ArrowDown");
    dispatchKey("ArrowDown");
    dispatchKey("ArrowDown");

    expect(selectedLabel()).toContain("alpha");
  });

  it("ArrowUp wraps backwards from the first row", () => {
    renderPalette();

    dispatchKey("ArrowUp");

    expect(selectedLabel()).toContain("charlie");
  });

  it("Enter picks the selected item", () => {
    const { onPick } = renderPalette();

    dispatchKey("ArrowDown");
    dispatchKey("Enter");

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "session:2" }));
  });

  it("Escape closes without picking", () => {
    const { onPick, onClose } = renderPalette();

    const ev = dispatchKey("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("clicking a row picks it", () => {
    const { onPick } = renderPalette();

    fireEvent.click(screen.getByRole("option", { name: /charlie/ }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "worktree:/wt/charlie" }));
  });

  it("re-selects the first row when the query narrows the list", () => {
    // Regression guard: a stale index left over from a longer list would either
    // highlight nothing or fire Enter on the wrong row.
    const { onPick } = renderPalette();

    dispatchKey("ArrowDown");
    dispatchKey("ArrowDown"); // selection now on "charlie" (index 2)
    type("alpha"); // list narrows to a single row
    dispatchKey("Enter");

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "session:1" }));
  });

  it("shows an empty state and ignores Enter when nothing matches", () => {
    const { onPick } = renderPalette();

    type("zzzz");
    dispatchKey("Enter");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("labels a worktree row that has no live session", () => {
    renderPalette();

    expect(screen.getByRole("option", { name: /charlie/ })).toHaveTextContent(/worktree/i);
  });
});
