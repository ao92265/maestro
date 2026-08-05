import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Mirrors the Rust `ProjectCatalog` struct. */
export interface ProjectCatalog {
  project_path: string;
  date: string;
  markdown: string;
  generated_at: string;
}

export type CatalogStatus = "idle" | "scanning" | "ready" | "error";

interface CatalogEntry {
  status: CatalogStatus;
  catalog: ProjectCatalog | null;
  error: string | null;
}

interface CatalogState {
  /**
   * Per-project catalogue state, keyed by repo path. Entirely in memory and
   * never persisted: the catalogue itself lives on disk as an artifact, and
   * there is no schedule or setting to remember — scans are on demand only.
   */
  catalogs: Record<string, CatalogEntry>;
  /**
   * Load the newest saved catalogue for a project if none is in memory. There
   * is no daily rhythm here: the last scan stays the current one, however old,
   * until a rescan replaces it.
   */
  loadLatest: (repoPath: string) => Promise<void>;
  /** Scan (or rescan) one project. The only way a catalogue is ever built. */
  scan: (repoPath: string) => Promise<void>;
  /**
   * Stop the scan running for a project, killing the headless Claude process.
   * A scan can hold that process for up to 45 minutes, so leaving the panel
   * with no way out is not an option.
   */
  cancel: (repoPath: string) => Promise<void>;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  catalogs: {},

  loadLatest: async (repoPath) => {
    const existing = get().catalogs[repoPath];
    // Skip only what a read cannot improve: a scan in flight owns the slot,
    // and an entry that already holds a catalogue has the newest from disk.
    // A FAILED scan must not block the read — that entry has no catalogue.
    if (existing?.status === "scanning" || existing?.catalog) return;
    try {
      // `date: null` makes the backend serve the newest saved catalogue.
      const catalog = await invoke<ProjectCatalog | null>("load_project_catalog", {
        projectPath: repoPath,
        date: null,
      });
      // Re-check after the await: a scan may have taken the slot while we read
      // from disk — its state must win over this stale read.
      const current = get().catalogs[repoPath];
      if (current?.status === "scanning" || current?.catalog) return;
      set((state) => ({
        catalogs: {
          ...state.catalogs,
          [repoPath]: catalog
            ? { status: "ready", catalog, error: null }
            : { status: "idle", catalog: null, error: null },
        },
      }));
    } catch (err) {
      console.error("Failed to load project catalog:", err);
    }
  },

  scan: async (repoPath) => {
    if (get().catalogs[repoPath]?.status === "scanning") return;
    // Keep the previous catalogue on screen during the scan — it runs for
    // minutes, and a blank panel that whole time helps nobody.
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [repoPath]: {
          status: "scanning",
          catalog: state.catalogs[repoPath]?.catalog ?? null,
          error: null,
        },
      },
    }));
    try {
      const catalog = await invoke<ProjectCatalog>("scan_project_catalog", {
        projectPath: repoPath,
      });
      set((state) => ({
        catalogs: {
          ...state.catalogs,
          [repoPath]: { status: "ready", catalog, error: null },
        },
      }));
    } catch (err) {
      // A cancel already released the slot, so this rejection is the stop we
      // asked for — a deliberate stop must not paint the panel red.
      if (get().catalogs[repoPath]?.status !== "scanning") return;
      set((state) => ({
        catalogs: {
          ...state.catalogs,
          [repoPath]: {
            status: "error",
            catalog: state.catalogs[repoPath]?.catalog ?? null,
            error: String(err),
          },
        },
      }));
    }
  },

  cancel: async (repoPath) => {
    const entry = get().catalogs[repoPath];
    if (entry?.status !== "scanning") return;
    // Release the slot first so the in-flight scan's rejection stays quiet
    // (see the catch above), then kill the process behind it.
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [repoPath]: {
          status: entry.catalog ? "ready" : "idle",
          catalog: entry.catalog,
          error: null,
        },
      },
    }));
    try {
      await invoke("cancel_project_catalog", { projectPath: repoPath });
    } catch (err) {
      console.error("Failed to stop the catalog scan:", err);
    }
  },
}));
