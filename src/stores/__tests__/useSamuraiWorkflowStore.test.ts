import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory double of the Tauri store plugin file, so the persist round-trip
 * (write on setGraph, read on rehydrate) is observable without a backend.
 * `vi.hoisted` because the vi.mock factory runs before module bodies.
 */
const backing = vi.hoisted(() => new Map<string, string>());

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get(key: string) {
      return backing.get(key);
    }
    async set(key: string, value: string) {
      backing.set(key, value);
    }
    async save() {}
    async delete(key: string) {
      backing.delete(key);
    }
  },
}));

import type { SamuraiWorkflowGraph } from "@/lib/samurai";
import { useSamuraiWorkflowStore, workflowGraphForLaunch } from "../useSamuraiWorkflowStore";

const STORAGE_KEY = "maestro-samurai-workflow";

function graph(): SamuraiWorkflowGraph {
  return {
    nodes: [
      { id: "a", text: "First step" },
      { id: "b", text: "Second step" },
    ],
    edges: [{ from: "a", to: "b" }],
    start: "a",
  };
}

describe("useSamuraiWorkflowStore (issue #91 persistence)", () => {
  beforeEach(() => {
    backing.clear();
    useSamuraiWorkflowStore.setState({ graph: null });
  });

  it("starts with no graph — the backend default governs untouched launches", () => {
    expect(useSamuraiWorkflowStore.getState().graph).toBeNull();
  });

  it("setGraph writes the graph through the Tauri store plugin", async () => {
    useSamuraiWorkflowStore.getState().setGraph(graph());

    // The persist middleware writes asynchronously — wait for the file image.
    await vi.waitFor(() => expect(backing.has(STORAGE_KEY)).toBe(true));
    const raw = backing.get(STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).state.graph).toEqual(graph());
  });

  it("rehydrate restores a previously persisted graph (app restart)", async () => {
    const edited = { ...graph(), start: "b" };
    backing.set(STORAGE_KEY, JSON.stringify({ state: { graph: edited }, version: 0 }));

    await useSamuraiWorkflowStore.persist.rehydrate();

    expect(useSamuraiWorkflowStore.getState().graph).toEqual(edited);
  });

  it("resetGraph returns to null-means-default and persists the reset", async () => {
    useSamuraiWorkflowStore.getState().setGraph(graph());
    await vi.waitFor(() => expect(backing.has(STORAGE_KEY)).toBe(true));

    useSamuraiWorkflowStore.getState().resetGraph();

    expect(useSamuraiWorkflowStore.getState().graph).toBeNull();
    await vi.waitFor(() => {
      const raw = backing.get(STORAGE_KEY);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw as string).state.graph).toBeNull();
    });
  });

  // --- hydration gate: the LazyStore read is async, so a startup window
  // exists where edits and launch reads race the rehydration ---------------

  it("an edit made during the rehydration window survives hydration", async () => {
    backing.set(STORAGE_KEY, JSON.stringify({ state: { graph: graph() }, version: 0 }));
    const edited = { ...graph(), start: "b" };

    // Kick a rehydrate but do NOT await it — then edit inside the window.
    const hydration = useSamuraiWorkflowStore.persist.rehydrate();
    expect(useSamuraiWorkflowStore.persist.hasHydrated()).toBe(false);
    useSamuraiWorkflowStore.getState().setGraph(edited);
    await hydration;

    // Rehydration merged the disk state over the store, then the gate
    // re-applied the edit on top — the edit is not clobbered.
    expect(useSamuraiWorkflowStore.getState().graph).toEqual(edited);
    await vi.waitFor(() => {
      const raw = backing.get(STORAGE_KEY);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw as string).state.graph).toEqual(edited);
    });
  });

  it("workflowGraphForLaunch waits for hydration before reporting the graph", async () => {
    const persisted = { ...graph(), start: "b" };
    backing.set(STORAGE_KEY, JSON.stringify({ state: { graph: persisted }, version: 0 }));

    // Read immediately after kicking a rehydrate — an ungated read here
    // raced to `null` and made the launch snapshot the wrong workflow.
    const hydration = useSamuraiWorkflowStore.persist.rehydrate();
    const read = workflowGraphForLaunch();

    expect(await read).toEqual(persisted);
    await hydration;
  });

  it("a corrupt persisted graph degrades to the default instead of hanging the launch", async () => {
    // zustand's persist marks only a SUCCESSFUL hydration as finished, so a
    // hydration that throws (an unparseable file) used to leave every
    // launch gated on `workflowGraphForLaunch` waiting forever — the Launch
    // button silently dead for the rest of the session.
    backing.set(STORAGE_KEY, "{ this is not json");

    await useSamuraiWorkflowStore.persist.rehydrate();

    const settled = await Promise.race([
      workflowGraphForLaunch().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
    ]);
    expect(settled).toBe("settled");
    expect(useSamuraiWorkflowStore.getState().graph).toBeNull();
  });

  it("workflowGraphForLaunch resolves the current graph once hydrated", async () => {
    expect(useSamuraiWorkflowStore.persist.hasHydrated()).toBe(true);
    expect(await workflowGraphForLaunch()).toBeNull();

    useSamuraiWorkflowStore.getState().setGraph(graph());
    expect(await workflowGraphForLaunch()).toEqual(graph());
  });
});
