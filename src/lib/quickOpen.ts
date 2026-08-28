/**
 * Quick-open palette data model and matching.
 *
 * Pure functions only — the palette component and the App wiring stay thin so
 * the ranking rules can be tested without rendering anything.
 */

import type { SessionConfig } from "@/stores/useSessionStore";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";
import { samePath } from "./path";
import type { WorktreeInfo } from "./worktreeManager";

/** Which list a row came from. Drives the badge and the grouping order. */
export type QuickOpenKind = "session" | "worktree";

/**
 * One selectable row.
 *
 * @property id - Stable key, unique across kinds (`session:7`, `worktree:/path`).
 * @property tabId - Project tab to activate before navigating.
 * @property sessionId - Session to focus, or null for a worktree with no live
 *   session — those can only select the owning project tab.
 */
export interface QuickOpenItem {
  id: string;
  kind: QuickOpenKind;
  label: string;
  sublabel: string;
  tabId: string;
  sessionId: number | null;
}

/** Trailing path segment, tolerating both separators. */
function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 6;
/** Chars that make the next character read as the start of a word. */
const WORD_SEPARATOR = /[\s/\\\-_.:]/;

/**
 * Score `query` as a subsequence of `text`, or null when it isn't one.
 *
 * Greedy left-to-right: each query char takes the earliest remaining match.
 * That is not a globally optimal alignment, but it is what fuzzy finders do
 * and it keeps this O(n) on every keystroke. Contiguous runs and word starts
 * score highest, so a literal prefix beats a scattered match.
 */
function subsequenceScore(query: string, text: string): number | null {
  if (query === "") return 0;

  let score = 0;
  let cursor = 0;
  let prevMatch = -2;

  for (const ch of query) {
    let found = -1;
    while (cursor < text.length) {
      if (text[cursor] === ch) {
        found = cursor;
        break;
      }
      cursor++;
    }
    if (found === -1) return null;

    score += 1;
    if (found === prevMatch + 1) score += CONSECUTIVE_BONUS;
    if (found === 0 || WORD_SEPARATOR.test(text[found - 1])) score += WORD_START_BONUS;

    prevMatch = found;
    cursor = found + 1;
  }

  // Mild preference for tighter haystacks, so a short exact-ish hit outranks a
  // long string that happens to contain the same letters. Capped so a very long
  // path can never be pushed below a genuine non-match.
  return score - Math.min(text.length - query.length, 20) * 0.1;
}

/** Best score across label and sublabel; the label is worth slightly more. */
function itemScore(item: QuickOpenItem, query: string): number | null {
  const label = subsequenceScore(query, item.label.toLowerCase());
  const sublabel = subsequenceScore(query, item.sublabel.toLowerCase());
  if (label === null && sublabel === null) return null;
  return Math.max(label ?? Number.NEGATIVE_INFINITY, (sublabel ?? Number.NEGATIVE_INFINITY) - 2);
}

/**
 * Rows matching `query`, best first. An empty query returns everything in the
 * order it was built (sessions before worktrees).
 */
export function filterItems(items: QuickOpenItem[], query: string): QuickOpenItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];

  const scored: { item: QuickOpenItem; score: number }[] = [];
  for (const item of items) {
    const score = itemScore(item, needle);
    if (score !== null) scored.push({ item, score });
  }

  // Sort is stable in every engine we ship on, so equal scores keep build order.
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/**
 * One row per session that belongs to an open project tab.
 *
 * Sessions whose project is not open are dropped: there is no tab to activate,
 * so the row would have nowhere to navigate.
 */
export function buildSessionItems(
  sessions: SessionConfig[],
  tabs: WorkspaceTab[],
): QuickOpenItem[] {
  const items: QuickOpenItem[] = [];

  for (const session of sessions) {
    // samePath, not ===: project_path comes back canonicalized from Rust
    // (\\?\C:\... on Windows) while the tab holds the path the user opened.
    const tab = tabs.find((t) => samePath(t.projectPath, session.project_path));
    if (!tab) continue;

    items.push({
      id: `session:${session.id}`,
      kind: "session",
      label: session.name?.trim() || session.mode,
      sublabel: session.branch ? `${session.branch} · ${tab.name}` : tab.name,
      tabId: tab.id,
      sessionId: session.id,
    });
  }

  return items;
}

/**
 * One row per checked-out worktree of `tab`'s repo, linked to the session
 * running in it when there is one.
 *
 * Bare worktrees are dropped — they have no working copy to open.
 */
export function buildWorktreeItems(
  worktrees: WorktreeInfo[],
  sessions: SessionConfig[],
  tab: WorkspaceTab,
): QuickOpenItem[] {
  const items: QuickOpenItem[] = [];

  for (const worktree of worktrees) {
    if (worktree.is_bare) continue;

    const owner = sessions.find((s) => s.worktree_path && samePath(s.worktree_path, worktree.path));

    items.push({
      // Tab-scoped: one repo can be open as two projects (the main checkout and
      // a linked worktree), which would otherwise collide on React keys and on
      // the DOM ids the palette points at with aria-activedescendant.
      id: `worktree:${tab.id}:${worktree.path}`,
      kind: "worktree",
      label: worktree.branch?.trim() || basename(worktree.path),
      sublabel: worktree.path,
      tabId: tab.id,
      sessionId: owner?.id ?? null,
    });
  }

  return items;
}
