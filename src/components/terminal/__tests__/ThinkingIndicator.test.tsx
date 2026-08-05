import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { ThinkingIndicator } from "../ThinkingIndicator";
import { useSessionStore, type BackendSessionStatus, type SessionConfig } from "@/stores/useSessionStore";

function session(status: BackendSessionStatus): SessionConfig {
  return {
    id: 1,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: "C:/proj",
  };
}

/** The three dot spans inside the indicator. */
function dots(): HTMLElement[] {
  return Array.from(screen.getByRole("status").querySelectorAll("span")) as HTMLElement[];
}

describe("ThinkingIndicator", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
  });

  it("ripples in blue while the agent is working", () => {
    useSessionStore.setState({ sessions: [session("Working")] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Model is thinking");
    for (const dot of dots()) {
      expect(dot).toHaveClass("bg-maestro-blue");
      expect(dot).toHaveClass("animate-thinking-dot");
    }
  });

  it("ripples in the accent colour while the agent waits for the user", () => {
    useSessionStore.setState({ sessions: [session("NeedsInput")] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Awaiting user input");
    for (const dot of dots()) {
      expect(dot).toHaveClass("bg-maestro-accent");
      // Needs-input used to render static, which read the same as a stale dot.
      expect(dot).toHaveClass("animate-thinking-dot");
    }
  });

  it("stands still when there is nothing to report", () => {
    useSessionStore.setState({ sessions: [session("Idle")] });
    render(<ThinkingIndicator sessionId={1} />);

    for (const dot of dots()) {
      expect(dot).not.toHaveClass("animate-thinking-dot");
      expect(dot).toHaveClass("opacity-60");
    }
  });

  it("staggers the three dots so they ripple rather than blink together", () => {
    useSessionStore.setState({ sessions: [session("Working")] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(dots().map((d) => d.style.animationDelay)).toEqual(["0ms", "180ms", "360ms"]);
  });

  /**
   * Regression guard. The dots were previously given
   * `motion-safe:animate-thinking-dot`, but `animate-thinking-dot` is
   * hand-written in globals.css rather than a Tailwind theme animation, so
   * Tailwind never emitted a `motion-safe:` variant and the animation silently
   * never ran. Reduced motion is handled by the media query instead.
   */
  it("applies the animation class plainly, and globals.css defines it", () => {
    useSessionStore.setState({ sessions: [session("Working")] });
    render(<ThinkingIndicator sessionId={1} />);

    for (const dot of dots()) {
      expect(dot.className).not.toContain("motion-safe");
    }

    const css = readFileSync(resolve(__dirname, "../../../styles/globals.css"), "utf8");
    expect(css).toContain(".animate-thinking-dot {");
    expect(css).toContain("@keyframes thinking-dot");
    // …and reduced motion still switches it off.
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.animate-thinking-dot/);
  });
});
