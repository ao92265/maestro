import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The session store subscribes to Tauri events at listener-init time; the
// global setup already mocks @tauri-apps/api/core, event needs its own stub.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { ParkedShelf } from "../ParkedShelf";
import { useSessionStore, type SessionConfig } from "@/stores/useSessionStore";

function session(id: number, projectPath: string, name: string | null = null): SessionConfig {
  return {
    id,
    mode: "Claude",
    name,
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: projectPath,
  };
}

describe("ParkedShelf", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], parkedSessionIds: [] });
  });

  it("renders nothing when no session is parked", () => {
    useSessionStore.setState({ sessions: [session(1, "C:/proj")] });

    const { container } = render(<ParkedShelf onUnpark={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders a chip per parked session and calls onUnpark on click", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", "My Agent"), session(2, "C:/proj")],
      parkedSessionIds: [1],
    });
    const onUnpark = vi.fn();

    render(<ParkedShelf onUnpark={onUnpark} />);

    expect(screen.getByText("Parked")).toBeInTheDocument();
    expect(screen.queryByText("Session #2")).not.toBeInTheDocument();
    const chip = screen.getByText("My Agent");
    fireEvent.click(chip);
    expect(onUnpark).toHaveBeenCalledWith(1);
  });

  it("falls back to a Session #id label when the session has no name", () => {
    useSessionStore.setState({
      sessions: [session(3, "C:/proj")],
      parkedSessionIds: [3],
    });

    render(<ParkedShelf onUnpark={vi.fn()} />);

    expect(screen.getByText("Session #3")).toBeInTheDocument();
  });

  it("filters chips to the given projectPath", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:\\git\\alpha", "Alpha"), session(2, "C:\\git\\beta", "Beta")],
      parkedSessionIds: [1, 2],
    });

    render(<ParkedShelf projectPath="C:/git/alpha" onUnpark={vi.fn()} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("shows project labels when showProjectLabels is set", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:\\git\\alpha", "Agent")],
      parkedSessionIds: [1],
    });

    render(<ParkedShelf showProjectLabels onUnpark={vi.fn()} />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
  });
});
