import type { ActivityKind, FlowTier } from "@/lib/pulse";

/**
 * Shared presentation of a flow tier and a timeline row.
 *
 * Rohcna shipped raw hexes in its payload (`#ff5230` for a deep day). Maestro
 * is themed through `maestro-*` tokens and a `data-theme` switch, so the
 * scoring returns a {@link FlowTier} and this module is the one place that
 * decides what a tier looks like.
 */

/** Text colour per tier — the score, its word, and each factor's sign. */
export const TIER_TEXT: Record<FlowTier, string> = {
  deep: "text-maestro-accent",
  flow: "text-maestro-green",
  steady: "text-maestro-yellow",
  scattered: "text-maestro-muted",
};

/** Fill per tier — factor bars, trend bars and heatmap cells. */
export const TIER_FILL: Record<FlowTier, string> = {
  deep: "bg-maestro-accent",
  flow: "bg-maestro-green",
  steady: "bg-maestro-yellow",
  scattered: "bg-maestro-muted",
};

/** A day with no score at all: an empty cell, not a bad one. Reads as a well
 *  against the card it sits on, rather than a dimmed version of a real score. */
export const EMPTY_CELL_FILL = "bg-maestro-bg";

/** Glyph and colour per timeline row, matching rohcna's icon vocabulary. */
export const ACTIVITY_MARK: Record<ActivityKind, { glyph: string; cls: string; label: string }> = {
  commit: { glyph: "⎇", cls: "text-maestro-muted", label: "Commit" },
  question: { glyph: "◆", cls: "text-maestro-accent", label: "Waiting on you" },
  stopHook: { glyph: "✓", cls: "text-maestro-green", label: "Hook" },
  autopilot: { glyph: "✦", cls: "text-maestro-yellow", label: "Autopilot" },
};
