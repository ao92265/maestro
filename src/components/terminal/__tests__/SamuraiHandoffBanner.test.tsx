import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  type SamuraiSessionInfo,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { SamuraiHandoffBanner } from "../SamuraiHandoffBanner";

function session(id: number, projectPath = "C:/proj"): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: projectPath,
  };
}

function supervised(overrides: Partial<SamuraiSessionInfo> = {}): SamuraiSessionInfo {
  return {
    project: "C:/proj",
    epic: "#36",
    generation: 2,
    state: "WORKING",
    ...overrides,
  };
}

describe("SamuraiHandoffBanner", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {} });
  });

  it("shows the handoff banner for HANDOFF_REQUESTED", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "HANDOFF_REQUESTED" }) },
    });
    render(<SamuraiHandoffBanner sessionId={1} />);

    expect(screen.getByText(/Maestro is handing off gen-2/)).toBeInTheDocument();
  });

  it("shows the handoff banner for HANDOFF_WRITTEN", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "HANDOFF_WRITTEN" }) },
    });
    render(<SamuraiHandoffBanner sessionId={1} />);

    expect(screen.getByText(/Maestro is handing off gen-2/)).toBeInTheDocument();
  });

  it("shows the park banner for PARK_REQUESTED", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "PARK_REQUESTED", generation: 3 }) },
    });
    render(<SamuraiHandoffBanner sessionId={1} />);

    expect(screen.getByText("Maestro is about to park this agent (gen-3)")).toBeInTheDocument();
  });

  it("renders nothing for WORKING", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "WORKING" }) },
    });
    const { container } = render(<SamuraiHandoffBanner sessionId={1} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a non-supervised session", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    const { container } = render(<SamuraiHandoffBanner sessionId={1} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the supervised project does not match the session's", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/other")],
      samuraiBySessionId: { 1: supervised({ project: "C:/proj", state: "HANDOFF_REQUESTED" }) },
    });
    const { container } = render(<SamuraiHandoffBanner sessionId={1} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("updates live when a supervisor event advances the state", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "WORKING" }) },
    });
    const { container } = render(<SamuraiHandoffBanner sessionId={1} />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      useSessionStore.setState({
        samuraiBySessionId: { 1: supervised({ state: "HANDOFF_REQUESTED" }) },
      });
    });
    expect(screen.getByText(/Maestro is handing off/)).toBeInTheDocument();
  });
});
