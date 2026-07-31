import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ActivityFeed } from "../ActivityFeed";
import { useActivityStore } from "@/stores/useActivityStore";
import type { ClaudeEvent } from "@/types/claude-events";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

function makeEvents(sessionId: number, count: number): ClaudeEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    event_type: "ToolUseStarted" as const,
    session_id: sessionId,
    tool_name: `Tool${i}`,
    tool_use_id: `tool-${i}`,
    input_summary: `input ${i}`,
    timestamp: new Date(2026, 0, 1, 12, 0, i).toISOString(),
  }));
}

describe("ActivityFeed auto-scroll", () => {
  beforeEach(() => {
    useActivityStore.setState({
      sessions: {
        1: {
          events: makeEvents(1, 5),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          filesModified: [],
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useActivityStore.setState({ sessions: {} });
  });

  it("renders the session's event rows", () => {
    render(<ActivityFeed sessionId={1} maxHeight="100%" />);

    expect(screen.getByText("Tool0")).toBeInTheDocument();
    expect(screen.getByText("Tool4")).toBeInTheDocument();
  });

  it("never calls scrollIntoView (which would scroll overflow-hidden ancestors)", () => {
    // Regression guard: scrollIntoView scrolls EVERY scrollable ancestor,
    // including the overflow-hidden terminal cell, shifting the layout up.
    // The feed must scroll only its own container via scrollTop.
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;

    render(<ActivityFeed sessionId={1} maxHeight="100%" />);

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("renders without looping for a session with no recorded activity", () => {
    // Regression guard: getSession must return a stable reference for unknown
    // sessions. A fresh object per call makes the zustand selector's snapshot
    // change on every read and React throws "Maximum update depth exceeded".
    useActivityStore.setState({ sessions: {} });

    render(<ActivityFeed sessionId={42} maxHeight="100%" />);

    expect(
      screen.getByText("Waiting for session activity...")
    ).toBeInTheDocument();
  });

  it("assigns scrollTop on the feed's own container when events change", () => {
    const setScrollTop = vi.fn();
    const originalScrollTop = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop"
    );
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: setScrollTop,
    });

    try {
      render(<ActivityFeed sessionId={1} maxHeight="100%" />);
      expect(setScrollTop).toHaveBeenCalled();
    } finally {
      if (originalScrollTop) {
        Object.defineProperty(Element.prototype, "scrollTop", originalScrollTop);
      } else {
        delete (Element.prototype as { scrollTop?: unknown }).scrollTop;
      }
    }
  });
});
