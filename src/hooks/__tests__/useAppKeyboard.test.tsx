import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTourStore } from "@/stores/useTourStore";
import { useAppKeyboard } from "../useAppKeyboard";

// A fresh environment has no tour-seen marker, so the tour store starts
// open and (correctly) mutes every app shortcut. Close it for the
// shortcut tests; the mute itself is asserted in its own describe below.
beforeEach(() => {
  useTourStore.setState({ isOpen: false });
});

function dispatch(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(ev);
  return ev;
}

function renderAppKeyboard(overrides: Partial<Parameters<typeof useAppKeyboard>[0]> = {}) {
  const handlers = {
    onAddSession: vi.fn(),
    onSidebarTab: vi.fn(),
    onToggleGitPanel: vi.fn(),
    onToggleUtilityPanel: vi.fn(),
    onToggleEagleView: vi.fn(),
    onToggleBoardView: vi.fn(),
    onNextProject: vi.fn(),
    onPrevProject: vi.fn(),
  };
  renderHook(() =>
    useAppKeyboard({
      canAddSession: true,
      ...handlers,
      ...overrides,
    }),
  );
  return handlers;
}

// ctrlKey AND metaKey both set on mod-based shortcuts so tests pass
// regardless of what isMac() reports for the test environment.
const MOD = { ctrlKey: true, metaKey: true };

describe("useAppKeyboard sidebar tabs (Alt+1-3)", () => {
  it("fires onSidebarTab with the pressed tab index", () => {
    const { onSidebarTab } = renderAppKeyboard();

    for (const digit of [1, 2, 3]) {
      const ev = dispatch({ key: String(digit), code: `Digit${digit}`, altKey: true });
      expect(ev.defaultPrevented).toBe(true);
    }

    expect(onSidebarTab.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("ignores numpad digits so Windows Alt-code entry keeps working", () => {
    const { onSidebarTab } = renderAppKeyboard();
    dispatch({ key: "2", code: "Numpad2", altKey: true });
    expect(onSidebarTab).not.toHaveBeenCalled();
  });

  it("ignores Alt+4 (Infra tab cut from the strip), Alt+5, and Alt+digit with extra modifiers", () => {
    const { onSidebarTab } = renderAppKeyboard();

    dispatch({ key: "4", code: "Digit4", altKey: true });
    dispatch({ key: "5", code: "Digit5", altKey: true });
    dispatch({ key: "1", code: "Digit1", altKey: true, ctrlKey: true });
    dispatch({ key: "1", code: "Digit1", altKey: true, shiftKey: true });

    expect(onSidebarTab).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard right panels (Cmd/Ctrl+2, 3, 4, 6)", () => {
  it("fires onToggleGitPanel on Cmd/Ctrl+2", () => {
    const { onToggleGitPanel, onToggleUtilityPanel } = renderAppKeyboard();

    dispatch({ key: "2", code: "Digit2", ...MOD });

    expect(onToggleGitPanel).toHaveBeenCalledTimes(1);
    expect(onToggleUtilityPanel).not.toHaveBeenCalled();
  });

  it("maps Cmd/Ctrl+3, 4, 6 to the utility panels", () => {
    const { onToggleUtilityPanel } = renderAppKeyboard();

    for (const digit of [3, 4, 6]) {
      dispatch({ key: String(digit), code: `Digit${digit}`, ...MOD });
    }

    expect(onToggleUtilityPanel.mock.calls.map((c) => c[0])).toEqual(["memory", "processes", "ai"]);
  });

  it("Cmd/Ctrl+5 is dead — Notes is cut from nav", () => {
    const { onToggleUtilityPanel } = renderAppKeyboard();

    const ev = dispatch({ key: "5", code: "Digit5", ...MOD });

    expect(onToggleUtilityPanel).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("ignores digits with Alt or Shift held", () => {
    const { onToggleUtilityPanel } = renderAppKeyboard();

    dispatch({ key: "3", code: "Digit3", ...MOD, altKey: true });
    dispatch({ key: "3", code: "Digit3", ...MOD, shiftKey: true });

    expect(onToggleUtilityPanel).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard new terminal (Cmd/Ctrl+T)", () => {
  it("fires onAddSession when allowed", () => {
    const { onAddSession } = renderAppKeyboard();
    dispatch({ key: "t", code: "KeyT", ...MOD });
    expect(onAddSession).toHaveBeenCalledTimes(1);
  });

  it("still prevents the WebView default when not allowed", () => {
    const { onAddSession } = renderAppKeyboard({ canAddSession: false });
    const ev = dispatch({ key: "t", code: "KeyT", ...MOD });
    expect(onAddSession).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("useAppKeyboard eagle view (Cmd/Ctrl+G)", () => {
  it("fires onToggleEagleView", () => {
    const { onToggleEagleView } = renderAppKeyboard();
    dispatch({ key: "g", code: "KeyG", ...MOD });
    expect(onToggleEagleView).toHaveBeenCalledTimes(1);
  });
});

describe("useAppKeyboard board layer (Cmd/Ctrl+E)", () => {
  it("fires onToggleBoardView", () => {
    const { onToggleBoardView } = renderAppKeyboard();

    const ev = dispatch({ key: "e", code: "KeyE", ...MOD });

    expect(onToggleBoardView).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores KeyE with Alt or Shift held", () => {
    const { onToggleBoardView } = renderAppKeyboard();

    dispatch({ key: "e", code: "KeyE", ...MOD, altKey: true });
    dispatch({ key: "e", code: "KeyE", ...MOD, shiftKey: true });

    expect(onToggleBoardView).not.toHaveBeenCalled();
  });

  it("leaves a bare E alone so it still types into a terminal", () => {
    const { onToggleBoardView } = renderAppKeyboard();

    const ev = dispatch({ key: "e", code: "KeyE" });

    expect(onToggleBoardView).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("useAppKeyboard project cycling (Ctrl+Tab on all platforms)", () => {
  it("fires onNextProject on Ctrl+Tab", () => {
    const { onNextProject, onPrevProject } = renderAppKeyboard();

    const ev = dispatch({ key: "Tab", code: "Tab", ctrlKey: true });

    expect(onNextProject).toHaveBeenCalledTimes(1);
    expect(onPrevProject).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("fires onPrevProject on Ctrl+Shift+Tab", () => {
    const { onNextProject, onPrevProject } = renderAppKeyboard();

    dispatch({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });

    expect(onPrevProject).toHaveBeenCalledTimes(1);
    expect(onNextProject).not.toHaveBeenCalled();
  });

  it("ignores Tab without Ctrl and Cmd+Tab (macOS app switcher owns it)", () => {
    const { onNextProject } = renderAppKeyboard();
    dispatch({ key: "Tab", code: "Tab" });
    dispatch({ key: "Tab", code: "Tab", metaKey: true });
    expect(onNextProject).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard while the first-run tour is open", () => {
  it("mutes every app shortcut so the tour's own hints cannot fire behind its modal", () => {
    useTourStore.setState({ isOpen: true });
    const handlers = renderAppKeyboard();

    dispatch({ key: "1", code: "Digit1", altKey: true });
    dispatch({ key: "2", code: "Digit2", ...MOD });
    dispatch({ key: "t", code: "KeyT", ...MOD });
    dispatch({ key: "g", code: "KeyG", ...MOD });
    dispatch({ key: "e", code: "KeyE", ...MOD });
    dispatch({ key: "Tab", code: "Tab", ctrlKey: true });

    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });
});
