import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useEffect } from "react";

import { SplitPaneView } from "../SplitPaneView";
import type { TreeNode } from "../splitTree";

function vsplit(slotA: string, slotB: string, ratio = 0.5): TreeNode {
  return {
    type: "split",
    id: "split-1",
    direction: "vertical",
    ratio,
    children: [
      { type: "leaf", id: "leaf-1", slotId: slotA },
      { type: "leaf", id: "leaf-2", slotId: slotB },
    ],
  };
}

let probeMounts = 0;
function Probe({ id }: { id: string }) {
  useEffect(() => {
    probeMounts++;
  }, []);
  return <div data-testid={`probe-${id}`} />;
}

describe("SplitPaneView", () => {
  it("renders both leaves with positioned hosts and a divider", () => {
    const { container } = render(
      <SplitPaneView
        node={vsplit("A", "B", 0.5)}
        renderLeaf={(slotId) => <Probe id={slotId} />}
        onRatioChange={vi.fn()}
        onDragStateChange={vi.fn()}
      />,
    );

    const hostA = container.querySelector('[data-slot-id="A"]') as HTMLElement;
    const hostB = container.querySelector('[data-slot-id="B"]') as HTMLElement;
    expect(hostA).not.toBeNull();
    expect(hostB).not.toBeNull();
    expect(hostA.style.left).toBe("0%");
    expect(hostB.style.left).toBe("calc(50% + 2px)");
    expect(container.querySelector(".split-divider-vertical")).not.toBeNull();
  });

  it("keeps leaf content mounted when two slots swap (regression: swap wiped both xterms)", () => {
    probeMounts = 0;
    const renderLeaf = (slotId: string) => <Probe id={slotId} />;
    const common = {
      renderLeaf,
      onRatioChange: vi.fn(),
      onDragStateChange: vi.fn(),
    };

    const { container, rerender, getByTestId } = render(
      <SplitPaneView node={vsplit("A", "B", 0.3)} {...common} />,
    );
    expect(probeMounts).toBe(2);

    const hostA = container.querySelector('[data-slot-id="A"]') as HTMLElement;
    const probeA = getByTestId("probe-A");
    expect(hostA.style.left).toBe("0%");

    // Swap the two slots (what drag-to-swap does to the tree).
    rerender(<SplitPaneView node={vsplit("B", "A", 0.3)} {...common} />);

    // Hosts and content are the SAME DOM/React instances — nothing remounted.
    expect(container.querySelector('[data-slot-id="A"]')).toBe(hostA);
    expect(getByTestId("probe-A")).toBe(probeA);
    expect(probeMounts).toBe(2);

    // ...but slot A now occupies the second pane's rectangle.
    expect(hostA.style.left).toBe("calc(30% + 2px)");
  });

  it("hides parked leaves and gives the visible sibling the full rect, without remounting", () => {
    probeMounts = 0;
    const renderLeaf = (slotId: string) => <Probe id={slotId} />;
    const common = {
      renderLeaf,
      onRatioChange: vi.fn(),
      onDragStateChange: vi.fn(),
    };

    const { container, rerender } = render(
      <SplitPaneView node={vsplit("A", "B")} {...common} hiddenSlotIds={new Set<string>()} />,
    );
    expect(probeMounts).toBe(2);

    rerender(
      <SplitPaneView node={vsplit("A", "B")} {...common} hiddenSlotIds={new Set(["A"])} />,
    );

    const hostA = container.querySelector('[data-slot-id="A"]') as HTMLElement;
    const hostB = container.querySelector('[data-slot-id="B"]') as HTMLElement;
    expect(hostA.className).toBe("hidden");
    expect(hostB.style.left).toBe("0%");
    expect(hostB.style.width).toBe("100%");
    // No divider against a hidden side, and nothing remounted.
    expect(container.querySelector(".split-divider")).toBeNull();
    expect(probeMounts).toBe(2);
  });

  it("renders leaf hosts as display:contents in eagle mode (no dividers)", () => {
    const { container } = render(
      <SplitPaneView
        node={vsplit("A", "B")}
        renderLeaf={(slotId) => <Probe id={slotId} />}
        onRatioChange={vi.fn()}
        onDragStateChange={vi.fn()}
        eagleMode
      />,
    );

    const hostA = container.querySelector('[data-slot-id="A"]') as HTMLElement;
    expect(hostA.className).toBe("contents");
    expect(hostA.style.left).toBe("");
    expect(container.querySelector(".split-divider")).toBeNull();
  });
});
