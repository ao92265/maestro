/**
 * Parses unified diff text (`git diff` output) into aligned side-by-side
 * rows for the two-column diff viewer.
 *
 * Within a hunk, a run of `-` lines immediately followed by a run of `+`
 * lines is paired line-by-line: paired lines are "modified" (shown on both
 * sides), leftover `-` lines are "removed" (left side only) and leftover `+`
 * lines are "added" (right side only). Context lines appear on both sides.
 */

export type CellKind = "context" | "added" | "removed" | "modified" | "empty" | "hunk";

export interface DiffCell {
  /** 1-based line number in that side's file; null for empty/hunk cells. */
  lineNo: number | null;
  text: string;
  kind: CellKind;
}

/** One aligned row of the side-by-side view. */
export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
}

const EMPTY_CELL: DiffCell = { lineNo: null, text: "", kind: "empty" };

/** Matches a hunk header like `@@ -12,4 +12,6 @@ optional context`. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * File-level metadata lines emitted by `git diff` before/inside a patch that
 * carry no line content and are skipped entirely.
 */
const METADATA_PREFIXES = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "old mode",
  "new mode",
  "new file mode",
  "deleted file mode",
  "similarity index",
  "dissimilarity index",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "Binary files",
];

/** Converts raw unified diff text into aligned side-by-side rows. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let pendingRemoved: string[] = [];
  let pendingAdded: string[] = [];

  const flushPending = () => {
    const paired = Math.min(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < paired; i++) {
      rows.push({
        left: { lineNo: oldLine++, text: pendingRemoved[i], kind: "modified" },
        right: { lineNo: newLine++, text: pendingAdded[i], kind: "modified" },
      });
    }
    for (let i = paired; i < pendingRemoved.length; i++) {
      rows.push({
        left: { lineNo: oldLine++, text: pendingRemoved[i], kind: "removed" },
        right: EMPTY_CELL,
      });
    }
    for (let i = paired; i < pendingAdded.length; i++) {
      rows.push({
        left: EMPTY_CELL,
        right: { lineNo: newLine++, text: pendingAdded[i], kind: "added" },
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };

  const lines = diff.split("\n");
  // A trailing "" element from the final newline is not a diff line.
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      flushPending();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({
        left: { lineNo: null, text: line, kind: "hunk" },
        right: { lineNo: null, text: line, kind: "hunk" },
      });
      continue;
    }

    // "\ No newline at end of file" appears between -/+ runs; skipping it
    // WITHOUT flushing keeps the removed/added pairing intact.
    if (line.startsWith("\\")) continue;

    if (inHunk && line.startsWith("-")) {
      pendingRemoved.push(line.slice(1));
      continue;
    }
    if (inHunk && line.startsWith("+")) {
      pendingAdded.push(line.slice(1));
      continue;
    }
    if (inHunk && (line.startsWith(" ") || line === "")) {
      flushPending();
      const text = line.slice(1);
      rows.push({
        left: { lineNo: oldLine++, text, kind: "context" },
        right: { lineNo: newLine++, text, kind: "context" },
      });
      continue;
    }

    // Anything else is file-level metadata; it also terminates the hunk.
    flushPending();
    inHunk = false;
    if (!METADATA_PREFIXES.some((p) => line.startsWith(p))) {
    }
  }

  flushPending();
  return rows;
}

/**
 * Builds all-added rows for an untracked file (no old version): the left
 * column stays empty and every content line shows green on the right.
 */
export function rowsForUntracked(content: string): DiffRow[] {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, i) => ({
    left: EMPTY_CELL,
    right: { lineNo: i + 1, text, kind: "added" as CellKind },
  }));
}
