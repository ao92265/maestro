/**
 * Deterministic per-project accent color.
 *
 * The color is derived purely from the project name, so the same project
 * always gets the same color — across sessions, restarts and machines.
 * Used by the eagle view to color-code terminal tiles by project.
 */

/**
 * Two hues closer than this (circular distance in degrees) are considered a
 * clash — at the fixed saturation/lightness they are too similar to tell
 * apart at a glance. 30° still allows up to 12 clearly distinct projects.
 */
const HUE_CLASH_DISTANCE = 30;

/**
 * Probe step used to re-seat a clashing hue. 137° ≈ the golden angle, which
 * spreads successive probes evenly around the hue wheel, and is coprime with
 * 360 so repeated probing eventually visits every hue.
 */
const HUE_PROBE_STEP = 137;

/** Bounded so pathological sets (many near-identical names) can't loop long. */
const MAX_PROBES = 24;

function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

function hslFor(hue: number): string {
  return `hsl(${hue} 70% 55%)`;
}

/** Circular distance between two hues, in degrees (0..180). */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Maps a project name to a stable HSL color.
 *
 * Hash → hue; saturation/lightness are fixed to values that read well as
 * borders and bold text on the dark theme.
 *
 * Prefer {@link resolveProjectColors} when the full set of open projects is
 * known — it keeps this mapping but re-seats colors that would clash.
 */
export function projectColorFor(name: string): string {
  return hslFor(hueFor(name));
}

/**
 * Assigns a color to every project name, keeping the deterministic
 * name → color rule but resolving clashes between *different* names.
 *
 * Names are processed in sorted order (independent of tab order), each
 * claiming its hash hue. When a name's hue lands within
 * {@link HUE_CLASH_DISTANCE} of an already-claimed hue, it is re-seated by
 * deterministic golden-angle probing until a free hue is found. The result is
 * therefore stable for a given set of open projects — no per-render
 * randomness — while identical names still intentionally share one color.
 */
export function resolveProjectColors(names: Iterable<string>): Map<string, string> {
  const unique = Array.from(new Set(names)).sort();
  const claimed: number[] = [];
  const colors = new Map<string, string>();

  for (const name of unique) {
    let hue = hueFor(name);
    let probes = 0;
    while (
      probes < MAX_PROBES &&
      claimed.some((taken) => hueDistance(taken, hue) < HUE_CLASH_DISTANCE)
    ) {
      hue = (hue + HUE_PROBE_STEP) % 360;
      probes++;
    }
    claimed.push(hue);
    colors.set(name, hslFor(hue));
  }

  return colors;
}
