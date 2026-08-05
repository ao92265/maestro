import { create } from "zustand";
import type { XY } from "@/components/landscape/layout";

/**
 * Where the user dragged landscape nodes to.
 *
 * Only nodes the user actually moved appear here; everything else falls back to
 * the deterministic layout. "Reorganize" empties the map, which is what makes
 * that button an exact undo of every drag.
 *
 * A store (not component state) so the arrangement survives closing and
 * reopening the landscape within an app session.
 *
 * Persistence is deliberately limited to project nodes. Project tab ids are
 * stable UUIDs across restarts, but session ids are handed out fresh each run
 * (the app kills every session on startup), so a persisted terminal position
 * would be re-applied to whatever unrelated terminal next claimed that id.
 * Subagent ids are transcript tool-use ids and equally short-lived.
 */

const STORAGE_KEY = "maestro-landscape-positions";

function isProjectNode(id: string): boolean {
  return id.startsWith("project:");
}

function loadPersisted(): Record<string, XY> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, XY> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isProjectNode(id) || !value || typeof value !== "object") continue;
      const { x, y } = value as Partial<XY>;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        out[id] = { x, y };
      }
    }
    return out;
  } catch (err) {
    console.error("Failed to load landscape positions:", err);
    return {};
  }
}

function savePersisted(positions: Record<string, XY>): void {
  try {
    const projectsOnly = Object.fromEntries(
      Object.entries(positions).filter(([id]) => isProjectNode(id)),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projectsOnly));
  } catch (err) {
    console.error("Failed to save landscape positions:", err);
  }
}

interface LandscapeLayoutState {
  /** Node id -> the position the user dropped it at. */
  positions: Record<string, XY>;
  setPosition: (id: string, position: XY) => void;
  /** Drop every manual position, so the deterministic layout takes over again. */
  reset: () => void;
}

export const useLandscapeLayoutStore = create<LandscapeLayoutState>((set) => ({
  positions: loadPersisted(),

  setPosition: (id, position) =>
    set((state) => {
      const next = { ...state.positions, [id]: position };
      savePersisted(next);
      return { positions: next };
    }),

  reset: () => {
    savePersisted({});
    return set({ positions: {} });
  },
}));
