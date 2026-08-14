import { describe, expect, it } from "vitest";
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

/** Reads a resolved color, failing loudly if the name has none. */
function colorOf(colors: Map<string, string>, name: string): string {
  const color = colors.get(name);
  if (!color) throw new Error(`no resolved color for "${name}"`);
  return color;
}

/** Two generated names whose raw hash hues land within 30° of each other. */
function findClashingPair(): [string, string] {
  const names = Array.from({ length: 60 }, (_, i) => `project-${i}`);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = hueOf(projectColorFor(names[i]));
      const b = hueOf(projectColorFor(names[j]));
      if (circularDistance(a, b) < 30) return [names[i], names[j]];
    }
  }
  throw new Error("no clashing pair found among the sample names");
}

describe("projectColorFor", () => {
  it("is deterministic for the same name", () => {
    expect(projectColorFor("maestro")).toBe(projectColorFor("maestro"));
  });

  it("uses the whole hue circle, red included", () => {
    // Red used to be reserved for the needs-input border. Status now lives in
    // the thinking dots, so the red band is part of the palette again.
    const hues = Array.from({ length: 200 }, (_, i) => hueOf(projectColorFor(`project-${i}`)));
    expect(hues.some((h) => h < 30 || h >= 330)).toBe(true);
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("resolveProjectColors", () => {
  it("keeps the hash color when there is no clash", () => {
    // The alphabetically first name always claims first, so it never re-seats.
    const colors = resolveProjectColors(["maestro", "dreadnought"]);
    expect(colors.get("dreadnought")).toBe(projectColorFor("dreadnought"));
  });

  it("gives identical names the same color (intentional rule)", () => {
    const colors = resolveProjectColors(["web", "web", "api"]);
    expect(colors.size).toBe(2);
  });

  it("re-seats one of two different names whose hues clash", () => {
    const [first, second] = findClashingPair();
    const colors = resolveProjectColors([first, second]);
    const resolvedA = hueOf(colorOf(colors, first));
    const resolvedB = hueOf(colorOf(colors, second));
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
    const hues = names.map((n) => hueOf(colorOf(colors, n)));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        expect(circularDistance(hues[i], hues[j])).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("never gives two different projects the same color, even when crowded", () => {
    // 30 names cannot all sit 30° apart — but no two may collide outright,
    // which is what the old 24-probe bail-out allowed.
    const names = Array.from({ length: 30 }, (_, i) => `project-${i}`);
    const colors = resolveProjectColors(names);
    expect(colors.size).toBe(30);
    expect(new Set(colors.values()).size).toBe(30);
  });

  it("spreads a crowded set out instead of bunching it up", () => {
    const names = Array.from({ length: 24 }, (_, i) => `project-${i}`);
    const hues = [...resolveProjectColors(names).values()].map(hueOf).sort((a, b) => a - b);
    // 24 hues on a 360° circle average 15° apart; assert nothing is squeezed
    // to less than half of that fair share.
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i] - hues[i - 1]).toBeGreaterThanOrEqual(7);
    }
  });
});
