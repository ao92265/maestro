import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardColdStart } from "@/components/board/BoardColdStart";
import type { HandoffInfo } from "@/lib/bands";
import type { BoardCardItem } from "@/lib/board";

function handoff(name: string): BoardCardItem {
  return {
    kind: "handoff",
    handoff: { slug: name, path: `/tmp/${name}`, repo: name } as HandoffInfo,
    projectName: name,
    objective: `${name} left half done`,
    stageLabel: "On disk",
    needsYou: false,
    since: null,
  };
}

describe("BoardColdStart", () => {
  it("says plainly that nothing is running", () => {
    render(<BoardColdStart handoffs={[]} moreHandoffs={0} onActivate={() => {}} />);
    expect(screen.getByText(/nothing is running/i)).toBeInTheDocument();
  });

  /* The whole reason this panel exists. "10 sessions parked" was counting
     files on disk, one of which was a directory Alex was typing in. */
  it("calls handoffs files on disk, never parked sessions", () => {
    render(
      <BoardColdStart
        handoffs={[handoff("a"), handoff("b")]}
        moreHandoffs={8}
        onActivate={() => {}}
      />,
    );
    const panel = screen.getByTestId("cold-start");
    expect(panel).toHaveTextContent("10 handoffs");
    expect(panel.textContent).not.toMatch(/parked/i);
  });

  it("counts the ones it is not showing as well as the ones it is", () => {
    render(<BoardColdStart handoffs={[handoff("a")]} moreHandoffs={4} onActivate={() => {}} />);
    expect(screen.getByTestId("cold-start")).toHaveTextContent("5 handoffs");
  });

  it("uses the singular when there is only one", () => {
    render(<BoardColdStart handoffs={[handoff("a")]} moreHandoffs={0} onActivate={() => {}} />);
    expect(screen.getByTestId("cold-start")).toHaveTextContent("1 handoff on disk");
  });

  it("shows at most three, and says how many it left out", () => {
    render(
      <BoardColdStart
        handoffs={[handoff("a"), handoff("b"), handoff("c"), handoff("d"), handoff("e")]}
        moreHandoffs={0}
        onActivate={() => {}}
      />,
    );
    expect(screen.getAllByTestId("board-card")).toHaveLength(3);
    expect(screen.getByTestId("cold-start")).toHaveTextContent("2 more");
  });

  it("opens a handoff when its card is clicked", () => {
    const onActivate = vi.fn();
    const first = handoff("a");
    render(<BoardColdStart handoffs={[first]} moreHandoffs={0} onActivate={onActivate} />);
    fireEvent.click(screen.getAllByTestId("board-card")[0]);
    expect(onActivate).toHaveBeenCalledWith(first);
  });

  it("says there is nothing to pick up rather than showing an empty frame", () => {
    render(<BoardColdStart handoffs={[]} moreHandoffs={0} onActivate={() => {}} />);
    expect(screen.getByTestId("cold-start")).toHaveTextContent(/no handoffs/i);
    expect(screen.queryAllByTestId("board-card")).toHaveLength(0);
  });
});
