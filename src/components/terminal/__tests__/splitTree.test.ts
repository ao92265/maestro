import { describe, it, expect } from "vitest";
import {
  MAX_SESSIONS,
  buildGridTree,
  collectSlotIds,
  createLeaf,
  gridDimensions,
  removeLeaf,
  splitLeaf,
  swapSlots,
  updateRatio,
} from "../splitTree";

describe("gridDimensions", () => {
  it("keeps the classic layouts for 1-6 panes", () => {
    expect(gridDimensions(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridDimensions(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridDimensions(3)).toEqual({ cols: 3, rows: 1 });
    expect(gridDimensions(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridDimensions(5)).toEqual({ cols: 3, rows: 2 });
    expect(gridDimensions(6)).toEqual({ cols: 3, rows: 2 });
  });

  it("always provides enough cells for every pane (no silently dropped panes)", () => {
    for (let count = 1; count <= 16; count++) {
      const { cols, rows } = gridDimensions(count);
      expect(cols * rows).toBeGreaterThanOrEqual(count);
    }
  });

  it("uses square-ish grids beyond 6 panes", () => {
    expect(gridDimensions(9)).toEqual({ cols: 3, rows: 3 });
    expect(gridDimensions(12)).toEqual({ cols: 4, rows: 3 });
  });
});

describe("buildGridTree", () => {
  it("places every slot in the tree up to MAX_SESSIONS", () => {
    for (let count = 1; count <= MAX_SESSIONS; count++) {
      const ids = Array.from({ length: count }, (_, i) => `s${i}`);
      expect(collectSlotIds(buildGridTree(ids))).toEqual(ids);
    }
  });
});

describe("swapSlots", () => {
  it("swaps two leaves in a 2-pane horizontal split", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    const swapped = swapSlots(tree, "a", "b");

    expect(collectSlotIds(swapped)).toEqual(["b", "a"]);
  });

  it("preserves split ratio when swapping (does not rebuild layout)", () => {
    let tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    if (tree.type !== "split") throw new Error("expected split node");
    tree = updateRatio(tree, tree.id, 0.7);

    const swapped = swapSlots(tree, "a", "b");
    if (swapped.type !== "split") throw new Error("expected split node");

    expect(swapped.ratio).toBe(0.7);
  });

  it("returns the original tree when swapping a slot with itself", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    const result = swapSlots(tree, "a", "a");
    expect(result).toBe(tree);
  });

  it("returns the original tree if either slot is not present", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    expect(swapSlots(tree, "a", "missing")).toBe(tree);
    expect(swapSlots(tree, "missing", "b")).toBe(tree);
  });

  it("swaps correctly inside a deep tree without disturbing ordering elsewhere", () => {
    // Build a 4-pane grid: [a, b], [c, d]
    const tree = buildGridTree(["a", "b", "c", "d"]);
    expect(collectSlotIds(tree)).toEqual(["a", "b", "c", "d"]);

    const swapped = swapSlots(tree, "b", "c");
    expect(collectSlotIds(swapped)).toEqual(["a", "c", "b", "d"]);
  });

  it("does not mutate the input tree", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    const before = collectSlotIds(tree).join(",");
    swapSlots(tree, "a", "b");
    expect(collectSlotIds(tree).join(",")).toBe(before);
  });

  it("survives sibling removal afterwards", () => {
    let tree = buildGridTree(["a", "b", "c"]);
    tree = swapSlots(tree, "a", "c");
    expect(collectSlotIds(tree)).toEqual(["c", "b", "a"]);

    const after = removeLeaf(tree, "b");
    expect(after).not.toBeNull();
    expect(collectSlotIds(after!)).toEqual(["c", "a"]);
  });
});
