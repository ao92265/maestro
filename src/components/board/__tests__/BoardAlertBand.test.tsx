import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardAlertBand } from "@/components/board/BoardAlertBand";
import type { BoardCardItem } from "@/lib/board";
import type { BackendSessionStatus, SessionConfig } from "@/stores/useSessionStore";

/* Synthetic fixtures only: this repo is public. */
function blocked(
  name: string,
  objective: string,
  minutesAgo: number,
  tabId: string | null = "tab-1",
): BoardCardItem {
  return {
    kind: "session",
    session: {
      id: 1,
      status: "NeedsInput" as BackendSessionStatus,
      project_path: `/tmp/${name}`,
    } as SessionConfig,
    tabId,
    projectName: name,
    objective,
    stageLabel: "NeedsInput",
    needsYou: true,
    since: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

function busy(name: string): BoardCardItem {
  return {
    kind: "session",
    session: {
      id: 2,
      status: "Working" as BackendSessionStatus,
      project_path: `/tmp/${name}`,
    } as SessionConfig,
    tabId: "tab-2",
    projectName: name,
    objective: "still going",
    stageLabel: "Working",
    needsYou: false,
    since: null,
  };
}

describe("BoardAlertBand", () => {
  it("renders nothing at all when nothing is waiting on you", () => {
    const { container } = render(<BoardAlertBand blocked={[]} onActivate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("leads with the question that has waited longest", () => {
    render(
      <BoardAlertBand
        blocked={[blocked("proj-a", "the oldest question", 9), blocked("proj-b", "a newer one", 2)]}
        onActivate={() => {}}
      />,
    );
    expect(screen.getByTestId("band-lead")).toHaveTextContent("the oldest question");
    expect(screen.getByTestId("band-lead")).toHaveTextContent("proj-a");
  });

  it("says how long it has been waiting, in the eyebrow", () => {
    render(<BoardAlertBand blocked={[blocked("proj-a", "q", 9)]} onActivate={() => {}} />);
    expect(screen.getByTestId("band-lead")).toHaveTextContent(/9m/);
  });

  it("counts every question, not just the one it is showing", () => {
    render(
      <BoardAlertBand
        blocked={[blocked("a", "one", 9), blocked("b", "two", 4), blocked("c", "three", 1)]}
        onActivate={() => {}}
      />,
    );
    expect(screen.getByTestId("band-count")).toHaveTextContent("3");
  });

  it("queues the rest behind the lead, newest last", () => {
    render(
      <BoardAlertBand
        blocked={[blocked("a", "one", 9), blocked("b", "two", 4), blocked("c", "three", 1)]}
        onActivate={() => {}}
      />,
    );
    const queue = screen.getByTestId("band-queue");
    expect(queue).toHaveTextContent("two");
    expect(queue).toHaveTextContent("three");
    expect(queue).not.toHaveTextContent("one");
  });

  /* No dead controls: the band offers the action the card actually has, and
     when a card has none it says why instead of drawing a button that does
     nothing. That rule is why the mockup's y/n keys are not here. */
  it("opens the leading question when its card can be opened", () => {
    const onActivate = vi.fn();
    const lead = blocked("proj-a", "the oldest question", 9);
    render(<BoardAlertBand blocked={[lead, blocked("b", "two", 2)]} onActivate={onActivate} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onActivate).toHaveBeenCalledWith(lead);
  });

  it("explains itself instead of offering a button that cannot act", () => {
    render(<BoardAlertBand blocked={[blocked("proj-a", "q", 9, null)]} onActivate={() => {}} />);
    expect(screen.queryByRole("button", { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("band-lead")).toHaveTextContent(/not open in a tab/i);
  });

  it("ignores work that is merely running", () => {
    const { container } = render(<BoardAlertBand blocked={[]} onActivate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(busy("proj-c").needsYou).toBe(false);
  });
});
