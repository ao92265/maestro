import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// The absorbed AuditSection subscribes to samurai-audit-event on mount.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

/**
 * MarkdownBody defers its renderer behind `lazy()`, which dynamically imports
 * react-markdown and the rehype/remark plugins. Whichever test renders markdown
 * first otherwise pays that whole transform inside a `findByText`, and under
 * full-suite parallel load that reliably overruns its 1s default — a flake that
 * only ever hit the first of the two report tests, because the second reused
 * the warm module cache. Warm it once here instead of widening the timeouts.
 */
beforeAll(async () => {
  await Promise.all([
    import("react-markdown"),
    import("rehype-raw"),
    import("remark-gfm"),
    import("remark-gemoji"),
  ]);
});

import { SecondBrainSection } from "../SecondBrainSection";
import { SAMURAI_IN_USE_ERROR_PREFIX, type SamuraiFileEntry } from "@/lib/samurai";
import { useHealthStore } from "@/stores/useHealthStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function fileEntry(overrides: Partial<SamuraiFileEntry> = {}): SamuraiFileEntry {
  return {
    kind: "HANDOFF",
    path: "C:\\data\\worktrees\\maestro\\samurai-38\\.maestro\\handoffs\\38-gen2.md",
    size_bytes: 4096,
    modified_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    project_path: "C:\\git\\maestro",
    epic: "#38",
    in_use: false,
    has_live_session: false,
    fire_at: null,
    ...overrides,
  };
}

/**
 * Routes the global invoke mock. `deleteRejections` maps a path to the error
 * its non-forced `samurai_file_delete` calls reject with (the in-use
 * refusal); forced calls always succeed. `harvestMarkdown` overrides what
 * `samurai_harvest_read` returns. `fileReads` maps a path to what
 * `samurai_file_read` resolves with; an `{ error }` value makes it reject
 * with that string instead — the backend's refusals are plain strings, not
 * Error objects (issue #82).
 */
function mockInvoke(
  files: SamuraiFileEntry[],
  deleteRejections: Record<string, string> = {},
  harvestMarkdown = "## Harvest 2026-08-06\n\nYesterday's bottleneck was CI.",
  fileReads: Record<string, string | { error: string }> = {},
) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "samurai_files_list":
        return files;
      case "samurai_audit_read":
        return { events: [], file_size_bytes: 0 };
      case "samurai_journal_list":
        return { entries: [], file_size_bytes: 0 };
      case "samurai_harvest_read":
        return harvestMarkdown;
      case "samurai_file_read": {
        const { path } = args as { path: string };
        const result = fileReads[path];
        if (typeof result === "object") throw result.error;
        return result ?? "";
      }
      case "samurai_file_delete": {
        const { path, force } = args as { path: string; force: boolean };
        if (!force && deleteRejections[path]) throw deleteRejections[path];
        return undefined;
      }
      case "samurai_timer_cancel":
        return true;
      case "samurai_cleanup_epic":
        return {
          epic: "#38",
          branch: "samurai/38",
          timer_cancelled: false,
          config_archived: true,
          worktree_removed: true,
          worktree_path: "C:\\data\\worktrees\\maestro\\samurai-38",
          branch_deleted: true,
        };
      default:
        return undefined;
    }
  });
}

describe("SecondBrainSection (issue #66)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // Health flags live in a module-level zustand store — reset between tests.
    useHealthStore.setState({ flags: [] });
  });

  it("renders both sections: the audit stream on top and the files below", async () => {
    mockInvoke([fileEntry()]);
    render(<SecondBrainSection />);

    expect(screen.getByText("Samurai Audit")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();
  });

  it("groups files by kind with sizes, ages and human-readable timers", async () => {
    mockInvoke([
      fileEntry(), // HANDOFF, 4 KB, 2h old
      fileEntry({
        kind: "RUN_CONFIG",
        path: "C:\\appdata\\samurai\\runs\\maestro-38.json",
        size_bytes: 2.5 * 1024 * 1024,
        in_use: true,
      }),
      fileEntry({
        kind: "TIMER",
        path: "C:\\appdata\\samurai\\schedule.json",
        fire_at: new Date(Date.now() + 3600_000).toISOString(),
        in_use: true,
      }),
    ]);
    render(<SecondBrainSection />);

    // Group headers, in kind order; JOURNAL/HARVEST stay hidden (no files),
    // AUDIT_LOG shows its empty hint instead. The one "Journal" text is the
    // JournalSection card header (issue #71), not a files group.
    expect(await screen.findByText("Handoffs")).toBeInTheDocument();
    expect(screen.getByText("Run configs")).toBeInTheDocument();
    expect(screen.getByText("Timers")).toBeInTheDocument();
    expect(screen.getByText("Audit logs")).toBeInTheDocument();
    expect(screen.getAllByText("Journal")).toHaveLength(1);
    expect(screen.queryByText("Harvest reports")).toBeNull();
    expect(screen.getByText("None.")).toBeInTheDocument();

    // Row details: basename or epic, size + age, timer fire time, in-use.
    expect(screen.getByText("38-gen2.md")).toBeInTheDocument();
    expect(screen.getByText("4 KB · 2h ago")).toBeInTheDocument();
    expect(screen.getByText("2.5 MB · 2h ago")).toBeInTheDocument();
    expect(screen.getByText(/^resumes at /)).toBeInTheDocument();
    expect(screen.getAllByText("IN USE")).toHaveLength(2);
  });

  it("shows the Journal and Harvest reports groups once files exist", async () => {
    mockInvoke([
      fileEntry({ kind: "JOURNAL", path: "C:\\appdata\\samurai\\journal.jsonl", epic: null }),
      fileEntry({
        kind: "HARVEST_REPORT",
        path: "C:\\appdata\\samurai\\harvest-2026-08.md",
        epic: null,
      }),
    ]);
    render(<SecondBrainSection />);

    expect(await screen.findByText("Harvest reports")).toBeInTheDocument();
    // Files group header + JournalSection card header (issue #71).
    expect(screen.getAllByText("Journal")).toHaveLength(2);
  });

  it("deletes a file only after the user confirms", async () => {
    mockInvoke([fileEntry()]);
    askMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();

    // First click: declined — nothing deleted.
    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_file_delete", expect.anything());

    // Second click: confirmed — deleted without force.
    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_file_delete", {
        path: fileEntry().path,
        force: false,
      }),
    );
    expect(await screen.findByText("Deleted 38-gen2.md.")).toBeInTheDocument();
  });

  it("routes an in-use refusal to the harder confirm before force-deleting", async () => {
    const entry = fileEntry({ in_use: true });
    mockInvoke([entry], {
      [entry.path]: `${SAMURAI_IN_USE_ERROR_PREFIX} referenced by an active run`,
    });
    // First ask: normal delete confirm. Second ask: the harder in-use confirm.
    askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_file_delete", {
        path: entry.path,
        force: true,
      }),
    );
    expect(askMock).toHaveBeenCalledTimes(2);
    // The harder confirm names the danger explicitly and uses the error kind.
    expect(askMock.mock.calls[1][0]).toMatch(/ACTIVE run/);
    expect(askMock.mock.calls[1][1]).toMatchObject({
      title: "File In Use — Force Delete?",
      kind: "error",
    });
    expect(await screen.findByText("Force-deleted 38-gen2.md.")).toBeInTheDocument();
  });

  it("never force-deletes when the harder confirm is declined", async () => {
    const entry = fileEntry({ in_use: true });
    mockInvoke([entry], {
      [entry.path]: `${SAMURAI_IN_USE_ERROR_PREFIX} referenced by an active run`,
    });
    askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<SecondBrainSection />);
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_file_delete", {
      path: entry.path,
      force: true,
    });
  });

  it("offers clean-this-epic on run configs without a live session and confirms first", async () => {
    mockInvoke([
      // Completed-but-still-ACTIVE config (review F2): in_use (ACTIVE
      // status) but no live session → cleanable — nothing archives a config
      // at completion yet, so this is exactly when the button must show.
      fileEntry({
        kind: "RUN_CONFIG",
        path: "C:\\appdata\\samurai\\runs\\maestro-38.json",
        epic: "#38",
        in_use: true,
        has_live_session: false,
      }),
      // Config with a live supervised session → no cleanup button (the
      // backend would refuse anyway).
      fileEntry({
        kind: "RUN_CONFIG",
        path: "C:\\appdata\\samurai\\runs\\maestro-40.json",
        epic: "#40",
        in_use: true,
        has_live_session: true,
      }),
    ]);
    askMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    expect(await screen.findByText("#38")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Clean up run #40" })).toBeNull();
    const cleanButton = screen.getByRole("button", { name: "Clean up run #38" });

    // Declined — nothing cleaned.
    fireEvent.click(cleanButton);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_cleanup_epic", expect.anything());

    // Confirmed — cleanup runs and its report is summarized.
    fireEvent.click(cleanButton);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_cleanup_epic", {
        projectPath: "C:\\git\\maestro",
        epic: "#38",
      }),
    );
    expect(
      await screen.findByText(
        "Cleaned up run #38: removed worktree, branch samurai/38, run config.",
      ),
    ).toBeInTheDocument();
  });

  it("offers cancel-timer instead of delete on TIMER rows", async () => {
    mockInvoke([
      fileEntry({
        kind: "TIMER",
        path: "C:\\appdata\\samurai\\schedule.json",
        fire_at: new Date(Date.now() + 3600_000).toISOString(),
        in_use: true,
      }),
    ]);
    render(<SecondBrainSection />);
    expect(await screen.findByText(/^resumes at /)).toBeInTheDocument();

    // Review F1: no file-delete affordance on timer rows — deleting
    // schedule.json would neither stop the timer nor scope to one epic.
    expect(screen.getByRole("button", { name: "Cancel resume timer for #38" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("cancels a timer only after the no-self-resume consequence is confirmed", async () => {
    mockInvoke([
      fileEntry({
        kind: "TIMER",
        path: "C:\\appdata\\samurai\\schedule.json",
        fire_at: new Date(Date.now() + 3600_000).toISOString(),
        in_use: true,
      }),
    ]);
    askMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    const button = await screen.findByRole("button", { name: "Cancel resume timer for #38" });

    // Declined — nothing cancelled.
    fireEvent.click(button);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_timer_cancel", expect.anything());
    // The confirm names the real consequence: no self-resume afterwards.
    expect(askMock.mock.calls[0][0]).toMatch(/NOT resume on its own/);
    expect(askMock.mock.calls[0][1]).toMatchObject({
      title: "Cancel Resume Timer",
      kind: "warning",
    });

    // Confirmed — the wrapper is called with the row's project + epic.
    fireEvent.click(button);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_timer_cancel", {
        projectPath: "C:\\git\\maestro",
        epic: "#38",
      }),
    );
    expect(await screen.findByText("Cancelled the resume timer for #38.")).toBeInTheDocument();
  });

  it("renders a shared schedule.json health reason only under the first timer row", async () => {
    const schedulePath = "C:\\appdata\\samurai\\schedule.json";
    mockInvoke([
      fileEntry({
        kind: "TIMER",
        path: schedulePath,
        epic: "#38",
        fire_at: new Date(Date.now() + 3600_000).toISOString(),
        in_use: true,
      }),
      fileEntry({
        kind: "TIMER",
        path: schedulePath,
        epic: "#40",
        fire_at: new Date(Date.now() + 7200_000).toISOString(),
        in_use: true,
      }),
    ]);
    useHealthStore.setState({
      flags: [
        {
          key: `samurai:${schedulePath}:size`,
          area: "secondbrain",
          scope: schedulePath,
          target: "schedule.json",
          reason: "schedule 6.0 MB (warn at 5.0 MB)",
        },
      ],
    });
    render(<SecondBrainSection />);
    expect(await screen.findByText("#40")).toBeInTheDocument();

    // Review F4: both rows share schedule.json — the one flag renders once.
    expect(screen.getAllByText("schedule 6.0 MB (warn at 5.0 MB)")).toHaveLength(1);
  });

  it("offers the open action on every row, not just harvest reports", async () => {
    // Issue #82: the eye button used to be HARVEST_REPORT-only, so every
    // other kind could be deleted but never read.
    mockInvoke([
      fileEntry(), // HANDOFF
      fileEntry({
        kind: "AUDIT_LOG",
        path: "C:\\git\\maestro\\.maestro\\samurai-audit.jsonl",
        epic: null,
      }),
      fileEntry({
        kind: "HARVEST_REPORT",
        path: "C:\\appdata\\samurai\\harvest\\2026-08-06.md",
        epic: null,
      }),
    ]);
    render(<SecondBrainSection />);
    expect(await screen.findByText("2026-08-06.md")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Open 38-gen2.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open samurai-audit.jsonl" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open 2026-08-06.md" })).toBeInTheDocument();
  });

  it("reads a non-harvest file through the guarded general read command", async () => {
    const entry = fileEntry();
    mockInvoke([entry], {}, undefined, {
      [entry.path]: "## Handoff gen-2\n\nPick up the CI fix.",
    });
    render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open 38-gen2.md" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_file_read", { path: entry.path }),
    );
    // .md → markdown, same renderer the harvest report gets.
    expect(await screen.findByText("Pick up the CI fix.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close file viewer" }));
    expect(screen.queryByText("Pick up the CI fix.")).toBeNull();
  });

  it("pretty-prints a .json file", async () => {
    const configPath = "C:\\appdata\\samurai\\runs\\maestro-38.json";
    mockInvoke([fileEntry({ kind: "RUN_CONFIG", path: configPath })], {}, undefined, {
      [configPath]: '{"epic":"#38","status":"ACTIVE"}',
    });
    const { container } = render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open #38" }));
    await waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe(
        '{\n  "epic": "#38",\n  "status": "ACTIVE"\n}',
      ),
    );
  });

  it("falls back to the raw text when a .json file does not parse", async () => {
    const configPath = "C:\\appdata\\samurai\\runs\\maestro-38.json";
    const truncated = '{"epic":"#38","status":';
    mockInvoke([fileEntry({ kind: "RUN_CONFIG", path: configPath })], {}, undefined, {
      [configPath]: truncated,
    });
    const { container } = render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open #38" }));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(truncated));
  });

  it("shows .jsonl as plain text rather than parsing it", async () => {
    const journalPath = "C:\\appdata\\samurai\\journal.jsonl";
    // A single-line JSONL file is itself valid JSON — if the viewer picked
    // its renderer by content rather than extension this would come back
    // pretty-printed and the append-order reading would be lost.
    const raw = '{"ts":"2026-08-12T09:00:00Z","category":"ERROR","text":"CI flaked"}';
    mockInvoke([fileEntry({ kind: "JOURNAL", path: journalPath, epic: null })], {}, undefined, {
      [journalPath]: raw,
    });
    const { container } = render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open journal.jsonl" }));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(raw));
  });

  it("renders a read refusal inline in the viewer instead of crashing", async () => {
    const entry = fileEntry();
    // The backend's oversize refusal, verbatim — the viewer must not reword
    // or parse it.
    const refusal =
      `refusing to read ${entry.path}: the file is 2.4 MB, over the 2 MB viewer ` +
      "limit — open it in an external editor";
    mockInvoke([entry], {}, undefined, { [entry.path]: { error: refusal } });
    render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open 38-gen2.md" }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    // Still a live panel, not a blown-up tree.
    expect(screen.getByText("Files")).toBeInTheDocument();
  });

  it("opens a harvest report in the markdown overlay and closes it again", async () => {
    const reportPath = "C:\\appdata\\samurai\\harvest\\2026-08-06.md";
    mockInvoke([fileEntry({ kind: "HARVEST_REPORT", path: reportPath, epic: null })]);
    render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open 2026-08-06.md" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_harvest_read", { path: reportPath }),
    );
    // The fetched markdown renders through MarkdownBody (lazy-loaded).
    expect(await screen.findByText("Yesterday's bottleneck was CI.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close file viewer" }));
    expect(screen.queryByText("Yesterday's bottleneck was CI.")).toBeNull();
  });

  it("renders harvest report markdown without turning raw HTML into elements", async () => {
    // Fix M5: the report is model output derived from journal text any local
    // process can write — script-capable HTML must never become live
    // elements in the invoke-capable webview.
    const reportPath = "C:\\appdata\\samurai\\harvest\\2026-08-06.md";
    mockInvoke(
      [fileEntry({ kind: "HARVEST_REPORT", path: reportPath, epic: null })],
      {},
      '## Report heading\n\n<img src="x" onerror="window.__pwned = true">\n\n' +
        "<script>window.__pwned = true;</script>\n\nSafe closing line.",
    );
    const { container } = render(<SecondBrainSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open 2026-08-06.md" }));
    // The markdown itself renders …
    expect(await screen.findByText("Report heading")).toBeInTheDocument();
    expect(screen.getByText("Safe closing line.")).toBeInTheDocument();
    // … but the embedded raw HTML never becomes elements or runs.
    expect(container.querySelector(".markdown-body img")).toBeNull();
    expect(container.querySelector(".markdown-body script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
