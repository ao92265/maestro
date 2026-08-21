import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardCard, boardCardKey, cardAction } from "@/components/board/BoardCard";
import type { ActRun } from "@/lib/act";
import type { HandoffInfo } from "@/lib/bands";
import type { BoardCardItem } from "@/lib/board";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/* Fixtures are fully synthetic: this repo is public, so no real handoff
   slugs, project paths or pull request URLs appear here. */

function sessionCard(
  status: BackendSessionStatus,
  tabId: string | null,
  extra: Partial<Extract<BoardCardItem, { kind: "session" }>> = {},
): BoardCardItem {
  return {
    kind: "session",
    session: { id: 1, status, project_path: "/tmp/proj-a" } as SessionConfig,
    tabId,
    projectName: "proj-a",
    objective: "wiring the parser",
    stageLabel: status,
    needsYou: status === "NeedsInput",
    since: null,
    ...extra,
  };
}

function handoffCard(): BoardCardItem {
  return {
    kind: "handoff",
    handoff: { slug: "hand-1", path: "/tmp/proj-b", repo: "proj-b" } as HandoffInfo,
    projectName: "proj-b",
    objective: "left the migration half applied",
    stageLabel: "On disk",
    needsYou: false,
    since: null,
  };
}

function runCard(stageLabel: string): BoardCardItem {
  return {
    kind: "run",
    run: { id: "run-1", title: "Ship the importer" } as ActRun,
    projectName: "Factory run",
    objective: "Ship the importer",
    stageLabel,
    needsYou: false,
    since: null,
  };
}

function prCard(stageLabel: string, mergedAt: string | null, needsYou: boolean): BoardCardItem {
  return {
    kind: "pr",
    pr: {
      number: 7,
      title: "Fix the importer",
      url: "https://example.test/pr/7",
      mergedAt,
    } as PullRequestInfo,
    repoPath: "/tmp/proj-a",
    projectName: "proj-a",
    objective: "#7 Fix the importer",
    stageLabel,
    needsYou,
    since: null,
  };
}

function externalCard(withHandoff = true): BoardCardItem {
  return {
    kind: "external",
    dir: "/tmp/proj-b",
    handoff: withHandoff
      ? ({ slug: "hand-1", path: "/tmp/proj-b", repo: "proj-b" } as HandoffInfo)
      : null,
    projectName: "proj-b",
    objective: withHandoff ? "left the migration half applied" : "Working outside Maestro",
    stageLabel: "Live outside Maestro",
    needsYou: false,
    since: null,
  };
}

describe("boardCardKey", () => {
  it("gives every card kind a distinct stable key", () => {
    const keys = [
      sessionCard("Working", "t1"),
      handoffCard(),
      runCard("build"),
      prCard("Merged", "2026-08-19T09:00:00Z", false),
      externalCard(),
    ].map(boardCardKey);
    expect(new Set(keys).size).toBe(5);
    expect(boardCardKey(sessionCard("Working", "t1"))).toBe(keys[0]);
  });
});

describe("cardAction", () => {
  it("disables a session card with no open tab and says why", () => {
    const action = cardAction(sessionCard("Working", null));
    expect(action.enabled).toBe(false);
    expect(action.title).toContain("not open in a tab");
  });

  it("enables an outside-Maestro card as a read-only peek", () => {
    const action = cardAction(externalCard());
    expect(action.enabled).toBe(true);
    expect(action.title).toContain("Peek");
  });

  it("enables every other card kind", () => {
    expect(cardAction(sessionCard("Working", "t1")).enabled).toBe(true);
    expect(cardAction(handoffCard()).enabled).toBe(true);
    expect(cardAction(runCard("build")).enabled).toBe(true);
    expect(cardAction(prCard("Merged", null, false)).enabled).toBe(true);
  });
});

describe("BoardCard", () => {
  it("shows the project, the objective and the stage", () => {
    render(<BoardCard item={sessionCard("Working", "t1")} selected={false} onActivate={vi.fn()} />);

    expect(screen.getByText("proj-a")).toBeInTheDocument();
    expect(screen.getByText("wiring the parser")).toBeInTheDocument();
    expect(screen.getByText("WORKING")).toBeInTheDocument();
  });

  it("shows elapsed time when the card knows when its work started", () => {
    const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    render(
      <BoardCard
        item={sessionCard("Working", "t1", { since })}
        selected={false}
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByText("1h ago")).toBeInTheDocument();
  });

  it("flags a card that needs you, and only that card", () => {
    const { unmount } = render(
      <BoardCard item={sessionCard("NeedsInput", "t1")} selected={false} onActivate={vi.fn()} />,
    );
    expect(screen.getByText("NEEDS YOU")).toBeInTheDocument();
    unmount();

    render(<BoardCard item={sessionCard("Working", "t1")} selected={false} onActivate={vi.fn()} />);
    expect(screen.queryByText("NEEDS YOU")).not.toBeInTheDocument();
  });

  it("keeps an unrecognised ACT stage name verbatim", () => {
    render(<BoardCard item={runCard("triage-the-inbox")} selected={false} onActivate={vi.fn()} />);

    expect(screen.getByText("triage-the-inbox")).toBeInTheDocument();
  });

  it("labels a merged pull request as merged", () => {
    render(
      <BoardCard
        item={prCard("Merged", "2026-08-19T09:00:00Z", false)}
        selected={false}
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByText("MERGED")).toBeInTheDocument();
  });

  it("activates on click", () => {
    const onActivate = vi.fn();
    render(<BoardCard item={handoffCard()} selected={false} onActivate={onActivate} />);

    fireEvent.click(screen.getByRole("button"));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("renders a session with no open tab as plain text, not a button", () => {
    render(<BoardCard item={sessionCard("Working", null)} selected={false} onActivate={vi.fn()} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByTitle(/not open in a tab/)).toBeInTheDocument();
  });

  it("renders an outside-Maestro card as a button that offers the peek", () => {
    const onActivate = vi.fn();
    render(<BoardCard item={externalCard()} selected={false} onActivate={onActivate} />);

    expect(screen.getByText("left the migration half applied")).toBeInTheDocument();
    expect(screen.getByText("OUTSIDE MAESTRO")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("renders a live cwd with no handoff carrying only the directory truth", () => {
    render(<BoardCard item={externalCard(false)} selected={false} onActivate={vi.fn()} />);

    expect(screen.getByText("proj-b")).toBeInTheDocument();
    expect(screen.getByText("Working outside Maestro")).toBeInTheDocument();
  });

  it("marks the selected card and leaves an unselected one unmarked", () => {
    const { unmount } = render(
      <BoardCard item={handoffCard()} selected={true} onActivate={vi.fn()} />,
    );
    expect(document.querySelector('[data-selected="true"]')).toBeInTheDocument();
    unmount();

    render(<BoardCard item={handoffCard()} selected={false} onActivate={vi.fn()} />);
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument();
  });
});
