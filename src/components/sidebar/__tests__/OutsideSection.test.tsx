import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useExternalSessionsStore } from "@/stores/useExternalSessionsStore";
import { OutsideSection } from "../OutsideSection";

const pane = (id: string, repoName: string | null, title: string) => ({
  id,
  tty: "/dev/ttys001",
  cwd: repoName ? `/Users/a/Repos/${repoName}` : "/Users/a",
  title,
  repo: repoName ? `/Users/a/Repos/${repoName}` : null,
  repoName,
});

function setStore(partial: Partial<ReturnType<typeof useExternalSessionsStore.getState>>) {
  useExternalSessionsStore.setState(partial);
}

describe("OutsideSection", () => {
  beforeEach(() => {
    setStore({
      sessions: [],
      loading: false,
      error: null,
      refresh: vi.fn(async () => {}),
      focus: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
  });

  it("groups terminals under the repo they are in", () => {
    setStore({
      sessions: [
        pane("a", "maestro", "act"),
        pane("b", "maestro", "palette"),
        pane("c", "scheduler", "timezone fix"),
      ],
    });

    render(<OutsideSection />);

    expect(screen.getByText("maestro")).toBeTruthy();
    expect(screen.getByText("scheduler")).toBeTruthy();
    expect(screen.getByText("act")).toBeTruthy();
    expect(screen.getByText("timezone fix")).toBeTruthy();
  });

  /* A terminal sitting outside any repo still has to appear: those are often
     the ones he has forgotten about, which is the whole point of the list. */
  it("still lists a terminal that is not in a repo", () => {
    setStore({ sessions: [pane("a", null, "somewhere else")] });

    render(<OutsideSection />);

    expect(screen.getByText("somewhere else")).toBeTruthy();
    expect(screen.getByText(/no repo/i)).toBeTruthy();
  });

  it("falls back to the folder when a terminal has no title", () => {
    setStore({ sessions: [pane("a", "maestro", "")] });

    render(<OutsideSection />);

    expect(screen.getByText("/Users/a/Repos/maestro")).toBeTruthy();
  });

  it("focuses the terminal you pick", () => {
    const focus = vi.fn(async () => {});
    setStore({ sessions: [pane("a", "maestro", "act")], focus });

    render(<OutsideSection />);
    fireEvent.click(screen.getByRole("button", { name: /focus act/i }));

    expect(focus).toHaveBeenCalledWith("a");
  });

  it("closes the terminal you pick", () => {
    const close = vi.fn(async () => {});
    setStore({ sessions: [pane("a", "maestro", "act")], close });

    render(<OutsideSection />);
    fireEvent.click(screen.getByRole("button", { name: /close act/i }));

    expect(close).toHaveBeenCalledWith("a");
  });

  it("says plainly when there is nothing running outside", () => {
    render(<OutsideSection />);

    expect(screen.getByText(/no terminals running outside vanguard/i)).toBeTruthy();
  });

  it("shows what went wrong when an action fails", () => {
    setStore({ sessions: [pane("a", "maestro", "act")], error: "That terminal has gone." });

    render(<OutsideSection />);

    expect(screen.getByText(/that terminal has gone/i)).toBeTruthy();
  });

  it("reads the list when it first appears", async () => {
    const refresh = vi.fn(async () => {});
    setStore({ refresh });

    render(<OutsideSection />);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
