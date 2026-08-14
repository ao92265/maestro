import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The persisted workflow store hydrates through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

import type { SamuraiWorkflowGraph } from "@/lib/samurai";
import { useSamuraiWorkflowStore } from "@/stores/useSamuraiWorkflowStore";
import {
  addWorkflowNode,
  connectWorkflow,
  removeWorkflowEdge,
  removeWorkflowNode,
  setWorkflowStart,
  WorkflowsView,
  workflowWalkOrder,
} from "../WorkflowsView";

const invokeMock = vi.mocked(invoke);

/**
 * React Flow measures its container and nodes through browser APIs happy-dom
 * doesn't implement. These are the stubs React Flow's own docs prescribe for
 * a jsdom/happy-dom test environment (same block as LandscapeView.test.tsx).
 */
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => {},
    }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
});

/** Test double of the backend's 7-step default (ids match the Rust chain). */
function defaultGraph(): SamuraiWorkflowGraph {
  const ids = ["implement", "review", "qa-report", "push", "batch-review", "batch-qa", "batch-pr"];
  return {
    nodes: ids.map((id) => ({ id, text: `Do the ${id} work.` })),
    edges: ids.slice(0, -1).map((id, i) => ({ from: id, to: ids[i + 1] })),
    start: "implement",
  };
}

/** A tiny 3-step chain for focused pure-function cases. */
function chain(): SamuraiWorkflowGraph {
  return {
    nodes: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
    start: "a",
  };
}

function storedGraph(): SamuraiWorkflowGraph {
  const graph = useSamuraiWorkflowStore.getState().graph;
  if (!graph) throw new Error("expected an edited graph in the store");
  return graph;
}

describe("WorkflowsView (issue #91 full-screen follow-up)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_default_workflow") return defaultGraph();
      return undefined;
    });
    useSamuraiWorkflowStore.setState({ graph: null });
  });

  it("renders the backend default template's boxes with compiled step numbers", async () => {
    render(<WorkflowsView onClose={() => {}} />);

    // The template comes from the backend command — the single source of
    // truth — never from a TS copy.
    expect(await screen.findByDisplayValue("Do the implement work.")).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "samurai_default_workflow")).toBe(true);
    for (const id of ["review", "qa-report", "push", "batch-review", "batch-qa", "batch-pr"]) {
      expect(screen.getByDisplayValue(`Do the ${id} work.`)).toBeInTheDocument();
    }
    // All seven boxes are on the walk, numbered in walk order.
    for (let step = 1; step <= 7; step++) {
      expect(screen.getByText(`Step ${step}`)).toBeInTheDocument();
    }
    expect(screen.queryByText("Not in run")).not.toBeInTheDocument();
    // Untouched: nothing lands in the store until the user edits.
    expect(useSamuraiWorkflowStore.getState().graph).toBeNull();
  });

  it("editing a box's text lands in the persisted store (what the launch sends)", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    const box = await screen.findByLabelText("Edit step implement");

    fireEvent.change(box, { target: { value: "Implement it MY way." } });

    const graph = storedGraph();
    expect(graph.nodes.find((n) => n.id === "implement")?.text).toBe("Implement it MY way.");
    // Everything else is carried over untouched from the default.
    expect(graph.nodes).toHaveLength(7);
    expect(screen.getByDisplayValue("Implement it MY way.")).toBeInTheDocument();
  });

  it("deleting a box auto-bridges prev → next, skipping the step instead of truncating", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByDisplayValue("Do the review work.");

    fireEvent.click(screen.getByRole("button", { name: "Remove step review" }));

    const graph = storedGraph();
    expect(graph.nodes.some((n) => n.id === "review")).toBe(false);
    // The bridge: implement now feeds qa-report directly…
    expect(graph.edges).toContainEqual({ from: "implement", to: "qa-report" });
    expect(graph.edges.some((e) => e.from === "review" || e.to === "review")).toBe(false);
    // …so the walk still reaches the end (6 steps, nothing orphaned).
    expect(workflowWalkOrder(graph)).toEqual([
      "implement",
      "qa-report",
      "push",
      "batch-review",
      "batch-qa",
      "batch-pr",
    ]);
    expect(screen.queryByDisplayValue("Do the review work.")).not.toBeInTheDocument();
    expect(screen.queryByText("Not in run")).not.toBeInTheDocument();
    expect(screen.getByText("Step 6")).toBeInTheDocument();
    expect(screen.queryByText("Step 7")).not.toBeInTheDocument();
  });

  it("deleting a connection truncates: downstream boxes stay visible but leave the run", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByDisplayValue("Do the push work.");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect push from batch-review" }));

    const graph = storedGraph();
    expect(graph.edges).not.toContainEqual({ from: "push", to: "batch-review" });
    // All seven boxes are still on the canvas…
    expect(graph.nodes).toHaveLength(7);
    expect(screen.getByDisplayValue("Do the batch-review work.")).toBeInTheDocument();
    // …but the three past the cut are visibly excluded from the run.
    expect(screen.getAllByText("Not in run")).toHaveLength(3);
    expect(screen.getByText("Step 4")).toBeInTheDocument();
    expect(screen.queryByText("Step 5")).not.toBeInTheDocument();
    expect(workflowWalkOrder(graph)).toEqual(["implement", "review", "qa-report", "push"]);
  });

  it("reset returns the store to null-means-default instead of pinning a copy", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    const box = await screen.findByLabelText("Edit step implement");
    fireEvent.change(box, { target: { value: "Edited away." } });
    fireEvent.click(screen.getByRole("button", { name: "Remove step review" }));
    expect(storedGraph().nodes).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    // The store returns to "never edited": the launch sends workflow: null
    // and the backend default GOVERNS — including future changes to it. A
    // materialized copy would silently pin today's default forever.
    await waitFor(() => expect(useSamuraiWorkflowStore.getState().graph).toBeNull());
    // The editor still renders the backend default for display.
    expect(await screen.findByDisplayValue("Do the implement work.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Do the review work.")).toBeInTheDocument();
  });

  it("adds an empty box wired from the end of the walk, skipped until it has text", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByDisplayValue("Do the batch-pr work.");

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));

    const graph = storedGraph();
    expect(graph.nodes).toHaveLength(8);
    expect(graph.edges).toContainEqual({ from: "batch-pr", to: "step-1" });
    // Reachable (it joined the walk) but empty — compile emits no step yet.
    expect(await screen.findByText("Empty — skipped")).toBeInTheDocument();
    expect(screen.queryByText("Not in run")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Edit step step-1")).toHaveValue("");
  });

  it("the close button and Escape both call onClose", async () => {
    const onClose = vi.fn();
    render(<WorkflowsView onClose={onClose} />);
    await screen.findByDisplayValue("Do the implement work.");

    fireEvent.click(screen.getByRole("button", { name: "Close workflow editor" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("workflow graph edits (pure rules)", () => {
  it("walk order follows the first outgoing edge and guards against cycles", () => {
    const graph: SamuraiWorkflowGraph = {
      ...chain(),
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" }, // branch: never followed (a→b is listed first)
        { from: "b", to: "a" }, // cycle: walk stops before revisiting a
      ],
    };
    expect(workflowWalkOrder(graph)).toEqual(["a", "b"]);
  });

  it("removing the start node hands start to its bridge target", () => {
    const next = removeWorkflowNode(chain(), "a");
    expect(next.start).toBe("b");
    expect(next.nodes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(next.edges).toEqual([{ from: "b", to: "c" }]);
  });

  it("removing a tail node drops its incoming edge (nothing to bridge to)", () => {
    const next = removeWorkflowNode(chain(), "c");
    expect(next.edges).toEqual([{ from: "a", to: "b" }]);
    expect(workflowWalkOrder(next)).toEqual(["a", "b"]);
  });

  it("a bridge that would self-loop or duplicate an existing edge is dropped", () => {
    // a→b, b→a: removing b would bridge a→a — dropped, not created.
    const loop: SamuraiWorkflowGraph = {
      nodes: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
      start: "a",
    };
    expect(removeWorkflowNode(loop, "b").edges).toEqual([]);

    // a→b, a→c, b→c: removing b bridges a→c, which already exists — kept once,
    // in the removed edge's slot so it stays a's FIRST outgoing edge.
    const diamond: SamuraiWorkflowGraph = {
      ...chain(),
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };
    expect(removeWorkflowNode(diamond, "b").edges).toEqual([{ from: "a", to: "c" }]);
  });

  it("connecting a box replaces its previous outgoing edge (rewire, not branch)", () => {
    const next = connectWorkflow(chain(), "a", "c");
    expect(next.edges).toEqual([
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ]);
    expect(workflowWalkOrder(next)).toEqual(["a", "c"]);
    // Self-connections are refused outright.
    expect(connectWorkflow(chain(), "a", "a")).toEqual(chain());
  });

  it("rewiring the START pill just repoints the walk's entry", () => {
    const next = setWorkflowStart(chain(), "b");
    expect(next.start).toBe("b");
    expect(workflowWalkOrder(next)).toEqual(["b", "c"]);
    expect(next.nodes).toEqual(chain().nodes);
  });

  it("added boxes get fresh step-N ids that never collide", () => {
    const once = addWorkflowNode(chain());
    const twice = addWorkflowNode(once);
    expect(once.nodes[once.nodes.length - 1]?.id).toBe("step-1");
    expect(twice.nodes[twice.nodes.length - 1]?.id).toBe("step-2");
    expect(workflowWalkOrder(twice)).toEqual(["a", "b", "c", "step-1", "step-2"]);
  });

  it("removing a missing edge is a no-op", () => {
    expect(removeWorkflowEdge(chain(), "a", "c")).toEqual(chain());
  });
});
