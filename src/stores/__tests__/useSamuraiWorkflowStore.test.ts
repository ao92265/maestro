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
import { useSamuraiWorkflowStore } from "../useSamuraiWorkflowStore";

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
});
