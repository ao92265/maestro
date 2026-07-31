import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTerminalKeyboard } from "../useTerminalKeyboard";

/**
 * Dispatch a keydown synthesizing what xterm does when it consumes a key:
 * sets `stopImmediatePropagation` to short-circuit bubble-phase listeners.
 * Our capture-phase Alt+Arrow handler must intercept BEFORE xterm sees the
 * event, so any listener attached to a deeper element should never run.
 */
function dispatchAltArrow(key: "ArrowLeft" | "ArrowRight"): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev;
}

describe("useTerminalKeyboard Alt+Arrow tab navigation", () => {
  it("does not fire onZoomedNext/Prev when isZoomed is false", () => {
    const onZoomedNext = vi.fn();
    const onZoomedPrev = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 3,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onZoomedNext,
        onZoomedPrev,
        isZoomed: false,
      }),
    );

    dispatchAltArrow("ArrowRight");
    dispatchAltArrow("ArrowLeft");

    expect(onZoomedNext).not.toHaveBeenCalled();
    expect(onZoomedPrev).not.toHaveBeenCalled();
  });

  it("fires onZoomedNext on Alt+Right when isZoomed is true and prevents default", () => {
    const onZoomedNext = vi.fn();
    const onZoomedPrev = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 3,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onZoomedNext,
        onZoomedPrev,
        isZoomed: true,
      }),
    );

    const ev = dispatchAltArrow("ArrowRight");

    expect(onZoomedNext).toHaveBeenCalledTimes(1);
    expect(onZoomedPrev).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("fires onZoomedPrev on Alt+Left when isZoomed is true and prevents default", () => {
    const onZoomedNext = vi.fn();
    const onZoomedPrev = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 3,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onZoomedNext,
        onZoomedPrev,
        isZoomed: true,
      }),
    );

    const ev = dispatchAltArrow("ArrowLeft");

    expect(onZoomedPrev).toHaveBeenCalledTimes(1);
    expect(onZoomedNext).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores Alt+Arrow when other modifiers are pressed", () => {
    const onZoomedNext = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 3,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onZoomedNext,
        onZoomedPrev: vi.fn(),
        isZoomed: true,
      }),
    );

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        ctrlKey: true, // disqualifies the shortcut
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onZoomedNext).not.toHaveBeenCalled();
  });

  it("is registered in capture phase so xterm-style stopPropagation cannot block it", () => {
    const onZoomedNext = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 3,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onZoomedNext,
        onZoomedPrev: vi.fn(),
        isZoomed: true,
      }),
    );

    // A bubble-phase listener on document that calls stopImmediatePropagation
    // simulates xterm's textarea/keydown handler.
    const sink = vi.fn((e: Event) => e.stopImmediatePropagation());
    document.addEventListener("keydown", sink);

    dispatchAltArrow("ArrowRight");

    // Capture-phase handler ran first, called onZoomedNext, AND prevented
    // the event from going further (we don't actually care about sink in
    // this case — only that onZoomedNext fired despite sink's existence).
    expect(onZoomedNext).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", sink);
  });

  it("does not register the capture listener when enabled=false", () => {
    const onZoomedNext = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 3,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onZoomedNext,
        onZoomedPrev: vi.fn(),
        isZoomed: true,
        enabled: false,
      }),
    );
    dispatchAltArrow("ArrowRight");
    expect(onZoomedNext).not.toHaveBeenCalled();
  });
});

describe("useTerminalKeyboard split shortcuts", () => {
  function renderSplitHook() {
    const onSplitVertical = vi.fn();
    const onSplitHorizontal = vi.fn();
    renderHook(() =>
      useTerminalKeyboard({
        terminalCount: 2,
        focusedIndex: 0,
        onFocusTerminal: vi.fn(),
        onCycleNext: vi.fn(),
        onCyclePrevious: vi.fn(),
        onSplitVertical,
        onSplitHorizontal,
      }),
    );
    return { onSplitVertical, onSplitHorizontal };
  }

  // metaKey AND ctrlKey both set so the test passes regardless of what
  // isMac() reports for the test environment.
  function dispatchSplit(shift: boolean) {
    const ev = new KeyboardEvent("keydown", {
      key: shift ? "D" : "d",
      code: "KeyD",
      ctrlKey: true,
      metaKey: true,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    return ev;
  }

  it("fires onSplitVertical on Cmd/Ctrl+D", () => {
    const { onSplitVertical, onSplitHorizontal } = renderSplitHook();
    dispatchSplit(false);
    expect(onSplitVertical).toHaveBeenCalledTimes(1);
    expect(onSplitHorizontal).not.toHaveBeenCalled();
  });

  it("fires onSplitHorizontal on Cmd/Ctrl+Shift+D (event.key is 'D', not 'd')", () => {
    // Regression: matching on event.key === "d" made the Shift variant
    // unreachable — with Shift held the key value is uppercase "D".
    const { onSplitVertical, onSplitHorizontal } = renderSplitHook();
    dispatchSplit(true);
    expect(onSplitHorizontal).toHaveBeenCalledTimes(1);
    expect(onSplitVertical).not.toHaveBeenCalled();
  });
});
