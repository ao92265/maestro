import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { useCatalogStore, type ProjectCatalog } from "../useCatalogStore";

const invokeMock = vi.mocked(invoke);

const PROJECT = "C:/git/proj";
const OTHER = "C:/git/other";

function catalog(
  date = "2026-08-05",
  project_path = PROJECT,
  markdown = "## Terminals"
): ProjectCatalog {
  return { project_path, date, markdown, generated_at: `${date}T10:00:00Z` };
}

describe("useCatalogStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "scan_project_catalog") return catalog();
      return null;
    });
    useCatalogStore.setState({ catalogs: {} });
  });

  it("scan sends the project path and stores the result", async () => {
    await useCatalogStore.getState().scan(PROJECT);
    expect(invokeMock).toHaveBeenCalledWith("scan_project_catalog", {
      projectPath: PROJECT,
    });
    const entry = useCatalogStore.getState().catalogs[PROJECT];
    expect(entry.status).toBe("ready");
    expect(entry.catalog?.markdown).toBe("## Terminals");
    expect(entry.error).toBeNull();
  });

  it("scan shows a scanning state while the run is in flight", async () => {
    let release: (c: ProjectCatalog) => void = () => {};
    invokeMock.mockImplementationOnce(
      () => new Promise<ProjectCatalog>((resolve) => (release = resolve))
    );
    const pending = useCatalogStore.getState().scan(PROJECT);
    expect(useCatalogStore.getState().catalogs[PROJECT].status).toBe("scanning");
    release(catalog());
    await pending;
    expect(useCatalogStore.getState().catalogs[PROJECT].status).toBe("ready");
  });

  it("scan keeps the previous catalog on screen while rescanning", async () => {
    // A scan runs for minutes; blanking the panel for that long helps nobody.
    const old = catalog("2026-07-01");
    useCatalogStore.setState({
      catalogs: { [PROJECT]: { status: "ready", catalog: old, error: null } },
    });
    invokeMock.mockImplementationOnce(() => new Promise<ProjectCatalog>(() => {}));
    void useCatalogStore.getState().scan(PROJECT);
    const entry = useCatalogStore.getState().catalogs[PROJECT];
    expect(entry.status).toBe("scanning");
    expect(entry.catalog).toEqual(old);
  });

  it("scan records the error and keeps the old catalog readable", async () => {
    const old = catalog("2026-07-01");
    useCatalogStore.setState({
      catalogs: { [PROJECT]: { status: "ready", catalog: old, error: null } },
    });
    invokeMock.mockRejectedValueOnce("Claude CLI not found on PATH");
    await useCatalogStore.getState().scan(PROJECT);
    const entry = useCatalogStore.getState().catalogs[PROJECT];
    expect(entry.status).toBe("error");
    expect(entry.error).toContain("Claude CLI not found");
    expect(entry.catalog).toEqual(old);
  });

  it("a second scan is ignored while one is already running", async () => {
    invokeMock.mockImplementationOnce(() => new Promise<ProjectCatalog>(() => {}));
    void useCatalogStore.getState().scan(PROJECT);
    await useCatalogStore.getState().scan(PROJECT);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("scans are tracked per project", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== "scan_project_catalog") return null;
      const path = (args as { projectPath: string }).projectPath;
      return catalog("2026-08-05", path, `## ${path}`);
    });
    await useCatalogStore.getState().scan(PROJECT);
    await useCatalogStore.getState().scan(OTHER);
    const { catalogs } = useCatalogStore.getState();
    expect(catalogs[PROJECT].catalog?.markdown).toBe(`## ${PROJECT}`);
    expect(catalogs[OTHER].catalog?.markdown).toBe(`## ${OTHER}`);
  });

  it("loadLatest adopts the newest saved catalog, however old (retention)", async () => {
    // No daily rhythm here: the last scan stays current until a rescan.
    invokeMock.mockResolvedValueOnce(catalog("2026-06-12"));
    await useCatalogStore.getState().loadLatest(PROJECT);
    expect(invokeMock).toHaveBeenCalledWith("load_project_catalog", {
      projectPath: PROJECT,
      date: null,
    });
    const entry = useCatalogStore.getState().catalogs[PROJECT];
    expect(entry.status).toBe("ready");
    expect(entry.catalog?.date).toBe("2026-06-12");
  });

  it("loadLatest leaves a never-scanned project idle and empty", async () => {
    await useCatalogStore.getState().loadLatest(PROJECT);
    const entry = useCatalogStore.getState().catalogs[PROJECT];
    expect(entry.status).toBe("idle");
    expect(entry.catalog).toBeNull();
  });

  it("loadLatest does not re-read a project that already has a catalog", async () => {
    useCatalogStore.setState({
      catalogs: { [PROJECT]: { status: "ready", catalog: catalog(), error: null } },
    });
    await useCatalogStore.getState().loadLatest(PROJECT);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("loadLatest never clobbers a scan that started while it was reading", async () => {
    let releaseLoad: (c: ProjectCatalog | null) => void = () => {};
    invokeMock.mockImplementationOnce(
      () => new Promise<ProjectCatalog | null>((resolve) => (releaseLoad = resolve))
    );
    const loading = useCatalogStore.getState().loadLatest(PROJECT);
    // A scan takes the slot mid-read.
    invokeMock.mockImplementationOnce(() => new Promise<ProjectCatalog>(() => {}));
    void useCatalogStore.getState().scan(PROJECT);
    releaseLoad(catalog("2026-01-01"));
    await loading;
    const entry = useCatalogStore.getState().catalogs[PROJECT];
    expect(entry.status).toBe("scanning");
    expect(entry.catalog).toBeNull();
  });

  it("loadLatest swallows a read failure rather than showing an error", async () => {
    // Nothing was asked for yet — a failed background read must not paint the
    // panel red before the user has pressed anything.
    invokeMock.mockRejectedValueOnce("disk error");
    await useCatalogStore.getState().loadLatest(PROJECT);
    expect(useCatalogStore.getState().catalogs[PROJECT]).toBeUndefined();
  });
});
