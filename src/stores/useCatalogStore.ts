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
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  catalogs: {},

  loadLatest: async (repoPath) => {
    const existing = get().catalogs[repoPath];
    if (existing && existing.status !== "idle") return;
    try {
      // `date: null` makes the backend serve the newest saved catalogue.
      const catalog = await invoke<ProjectCatalog | null>("load_project_catalog", {
        projectPath: repoPath,
        date: null,
      });
      // Re-check after the await: a scan may have taken the slot while we read
      // from disk — its state must win over this stale read.
      const current = get().catalogs[repoPath];
      if (current && current.status !== "idle") return;
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
}));
