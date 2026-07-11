/**
 * Per-project accent colors.
 *
 * Each open project tab is assigned a stable color from this palette so the
 * user can visually tell projects apart — most notably in the unified
 * "All Terminals" view, where terminals from every project are shown together
 * and only their border/label color distinguishes them.
 *
 * Colors are Tailwind 400-level hues: vivid enough to read on the dark theme,
 * yet not so light that they wash out on the light theme.
 */
export const PROJECT_COLORS: readonly string[] = [
  "#f87171", // red
  "#fb923c", // orange
  "#fbbf24", // amber
  "#a3e635", // lime
  "#34d399", // emerald
  "#22d3ee", // cyan
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f472b6", // pink
  "#e879f9", // fuchsia
];

/** Deterministic fallback color for a given index (wraps around the palette). */
export function colorForIndex(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length];
}

/**
 * Picks a color for a new project, preferring one not already in use so that
 * co-existing projects stay visually distinct. Once every palette entry is
 * taken, falls back to cycling by the number of projects already open.
 */
export function pickProjectColor(usedColors: readonly string[]): string {
  const unused = PROJECT_COLORS.find((c) => !usedColors.includes(c));
  return unused ?? colorForIndex(usedColors.length);
}
