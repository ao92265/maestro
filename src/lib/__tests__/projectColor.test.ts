import { describe, it, expect } from "vitest";
import { projectColorFor, resolveProjectColors } from "../projectColor";

/** Extracts the hue from an `hsl(H 70% 55%)` string. */
function hueOf(color: string): number {
  const match = /^hsl\((\d+) /.exec(color);
  if (!match) throw new Error(`unexpected color format: ${color}`);
  return Number(match[1]);
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("projectColorFor", () => {
  it("is deterministic for the same name", () => {
    expect(projectColorFor("maestro")).toBe(projectColorFor("maestro"));
  });
});

describe("resolveProjectColors", () => {
  it("keeps the hash color when there is no clash", () => {
    const colors = resolveProjectColors(["maestro", "dreadnought"]);
    // Sanity: these two names don't clash, so both keep their base color.
    for (const name of ["maestro", "dreadnought"]) {
      expect(colors.get(name)).toBe(projectColorFor(name));
    }
  });

  it("gives identical names the same color (intentional rule)", () => {
    const colors = resolveProjectColors(["web", "web", "api"]);
    expect(colors.size).toBe(2);
    expect(colors.get("web")).toBe(projectColorFor("web"));
  });

  it("re-seats one of two different names whose hues clash", () => {
    // "maestro" and "core" hash to the identical hue (335) — without
    // resolution their borders would be indistinguishable.
    const a = hueOf(projectColorFor("maestro"));
    const b = hueOf(projectColorFor("core"));
    expect(circularDistance(a, b)).toBeLessThan(30);

    const colors = resolveProjectColors(["maestro", "core"]);
    const resolvedA = hueOf(colors.get("maestro")!);
    const resolvedB = hueOf(colors.get("core")!);
    expect(circularDistance(resolvedA, resolvedB)).toBeGreaterThanOrEqual(30);
  });

  it("is stable regardless of input order", () => {
    const forward = resolveProjectColors(["core", "maestro", "web"]);
    const backward = resolveProjectColors(["web", "maestro", "core"]);
    for (const name of ["core", "maestro", "web"]) {
      expect(forward.get(name)).toBe(backward.get(name));
    }
  });

  it("keeps every pair of a realistic project set distinguishable", () => {
    const names = ["maestro", "dreadnought", "web", "api", "docs", "infra"];
    const colors = resolveProjectColors(names);
    const hues = names.map((n) => hueOf(colors.get(n)!));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        expect(circularDistance(hues[i], hues[j])).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("terminates on pathologically large clashing sets", () => {
    // 30 names cannot all be 30° apart (max 12) — must still return quickly
    // with a color for every name.
    const names = Array.from({ length: 30 }, (_, i) => `project-${i}`);
    const colors = resolveProjectColors(names);
    expect(colors.size).toBe(30);
  });
});
