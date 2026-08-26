import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

/* The workspace store persists through the Tauri plugin-store, which has no
   window internals under vitest (same stub as BoardView.test.tsx). */
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { buildSnapshot } from "@/hooks/useVanguardSnapshot";
import type { HandoffInfo } from "@/lib/bands";
import { useBandStore } from "@/stores/useBandStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/* Fixtures are fully synthetic: this repo is public, so no real handoff
   slugs or project paths appear here. */

/* Parked now means recent AND carrying an open ask, so the fixture has to be
   both for this test to be about the live-directory rule rather than about
   the freshness filter. `lastActive` is relative to real time because
   buildSnapshot reads the clock itself; a fixed date would rot into a
   vacuous pass. */
function handoff(slug: string, path: string): HandoffInfo {
  return {
    slug,
    path,
    repo: path.split("/").pop() ?? path,
    branch: "main",
    uncommitted: 0,
    lastCommit: null,
    asks: ["do the thing"],
    lastAction: "did a step",
    waiting: false,
    lastActive: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    stale: false,
    orphan: false,
  };
}

describe("buildSnapshot", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    useWorkspaceStore.setState({ tabs: [] });
    useBandStore.setState({
      handoffs: [],
      repoPrs: [],
      watermarkMs: 0,
      externallyActiveDirs: new Set<string>(),
    });
  });

  it("does not report a handoff as parked while a claude runs in its directory outside Maestro", () => {
    useBandStore.setState({
      handoffs: [handoff("live", "/tmp/proj-live"), handoff("idle", "/tmp/proj-idle")],
      externallyActiveDirs: new Set(["/tmp/proj-live"]),
    });

    const snapshot = buildSnapshot();
    const labels = (snapshot.blocked as { label: string }[]).map((b) => b.label);

    expect(labels).toContain("Parked: proj-idle");
    expect(labels).not.toContain("Parked: proj-live");
  });
});
