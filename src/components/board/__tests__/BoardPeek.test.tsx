import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardPeek } from "@/components/board/BoardPeek";
import type { ClaudeSessionInfo, ClaudeSessionListing } from "@/lib/terminal";

/* Fixtures are fully synthetic: this repo is public, so no real project
   paths or transcript content appear here. */

function sessionInfo(extra: Partial<ClaudeSessionInfo> = {}): ClaudeSessionInfo {
  return {
    session_id: "01234567-89ab-cdef-0123-456789abcdef",
    summary: null,
    first_prompt: "start the migration",
    last_prompt: "keep going",
    last_activity: "rewired the exporter and reran the tests",
    started_at: "2026-08-21T10:00:00Z",
    last_active: "2026-08-21T12:00:00Z",
    message_count: 42,
    git_branch: "feat/exporter",
    cwd: "/tmp/proj-b",
    cwd_exists: true,
    resumable: true,
    resume_blocked_reason: null,
    ...extra,
  } as ClaudeSessionInfo;
}

function listing(sessions: ClaudeSessionInfo[]): ClaudeSessionListing {
  return { sessions, total_found: sessions.length, truncated: false, unreadable: 0 };
}

function renderPeek(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenProject: vi.fn(),
  };
  render(
    <BoardPeek
      dir="/tmp/proj-b"
      cwds={["/tmp/proj-b"]}
      projectName="proj-b"
      loadSessions={vi.fn().mockResolvedValue(listing([sessionInfo()]))}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("BoardPeek", () => {
  it("shows the newest session's trail: last activity, branch and age", async () => {
    renderPeek();

    expect(await screen.findByText("rewired the exporter and reran the tests")).toBeInTheDocument();
    expect(screen.getByText("feat/exporter")).toBeInTheDocument();
    expect(screen.getByText(/42 messages/)).toBeInTheDocument();
  });

  it("orders sessions newest first and caps the list at three", async () => {
    const sessions = [
      sessionInfo({ session_id: "a1", last_active: "2026-08-21T09:00:00Z", last_activity: "one" }),
      sessionInfo({ session_id: "b2", last_active: "2026-08-21T12:00:00Z", last_activity: "two" }),
      sessionInfo({
        session_id: "c3",
        last_active: "2026-08-21T10:00:00Z",
        last_activity: "three",
      }),
      sessionInfo({ session_id: "d4", last_active: "2026-08-21T08:00:00Z", last_activity: "four" }),
    ];
    renderPeek({ loadSessions: vi.fn().mockResolvedValue(listing(sessions)) });

    await screen.findByText("two");
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain("two");
    expect(screen.queryByText("four")).not.toBeInTheDocument();
  });

  it("says honestly when no transcript exists for the directory", async () => {
    renderPeek({ loadSessions: vi.fn().mockResolvedValue(listing([])) });

    expect(await screen.findByText(/No transcript found for this directory/)).toBeInTheDocument();
  });

  it("shows the read failure rather than an empty state that lies", async () => {
    renderPeek({ loadSessions: vi.fn().mockRejectedValue(new Error("no home dir")) });

    expect(await screen.findByText(/no home dir/)).toBeInTheDocument();
  });

  it("opens the project from the footer and closes itself", async () => {
    const handlers = renderPeek();
    await screen.findByText("rewired the exporter and reran the tests");

    fireEvent.click(screen.getByRole("button", { name: "Open project in Maestro" }));

    expect(handlers.onOpenProject).toHaveBeenCalledWith("/tmp/proj-b");
  });

  it("closes from the header button", async () => {
    const handlers = renderPeek();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows only conversations from the live cwds, not the whole repo's", async () => {
    /* The listing sweeps the subtree, so an ancestor repo's own Maestro
       transcripts come back too; under the header "working outside Maestro"
       they would be a lie. */
    const sessions = [
      sessionInfo({ session_id: "a1", cwd: "/tmp/proj-b", last_activity: "outside work" }),
      sessionInfo({ session_id: "b2", cwd: "/tmp/proj-b/wt", last_activity: "someone else" }),
      sessionInfo({ session_id: "c3", cwd: null, last_activity: "no cwd recorded" }),
    ];
    renderPeek({ loadSessions: vi.fn().mockResolvedValue(listing(sessions)) });

    expect(await screen.findByText("outside work")).toBeInTheDocument();
    expect(screen.queryByText("someone else")).not.toBeInTheDocument();
    expect(screen.queryByText("no cwd recorded")).not.toBeInTheDocument();
  });

  it("counts what it is not showing instead of hiding it", async () => {
    const sessions = ["a1", "b2", "c3", "d4", "e5"].map((id, i) =>
      sessionInfo({ session_id: id, last_active: `2026-08-2${i}T10:00:00Z` }),
    );
    renderPeek({ loadSessions: vi.fn().mockResolvedValue(listing(sessions)) });

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));
    expect(screen.getByText(/2 more conversations on disk/)).toBeInTheDocument();
  });

  it("says transcripts could not be read rather than claiming none exist", async () => {
    renderPeek({
      loadSessions: vi
        .fn()
        .mockResolvedValue({ sessions: [], total_found: 0, truncated: false, unreadable: 2 }),
    });

    expect(await screen.findByText(/2 transcripts .*could not be read/)).toBeInTheDocument();
    expect(screen.queryByText(/No transcript found/)).not.toBeInTheDocument();
  });

  it("takes focus on open and pulls a Tab that escaped back inside", async () => {
    renderPeek();
    const dialog = await screen.findByRole("dialog");

    expect(document.activeElement).toBe(dialog);

    (document.body as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape from its own listener", async () => {
    const handlers = renderPeek();
    await screen.findByRole("dialog");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
