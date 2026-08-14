import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, rowsForUntracked } from "../diffParser";

/** A realistic single-file diff: one line changed, one added. */
const SIMPLE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 20;",
  "+const c = 3;",
  " export {};",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("skips file headers and emits a hunk separator row", () => {
    const rows = parseUnifiedDiff(SIMPLE_DIFF);
    expect(rows[0].left.kind).toBe("hunk");
    expect(rows[0].left.text).toContain("@@ -1,3 +1,4 @@");
    // No metadata lines leak into the rows.
    expect(rows.every((r) => !r.left.text.startsWith("diff --git"))).toBe(true);
  });

  it("pairs a removed run with an added run as modified, leftover as added", () => {
    const rows = parseUnifiedDiff(SIMPLE_DIFF);
    // rows: hunk, context, modified(b), added(c), context
    expect(rows).toHaveLength(5);

    expect(rows[1].left).toEqual({ lineNo: 1, text: "const a = 1;", kind: "context" });
    expect(rows[1].right).toEqual({ lineNo: 1, text: "const a = 1;", kind: "context" });

    expect(rows[2].left).toEqual({ lineNo: 2, text: "const b = 2;", kind: "modified" });
    expect(rows[2].right).toEqual({ lineNo: 2, text: "const b = 20;", kind: "modified" });

    expect(rows[3].left.kind).toBe("empty");
    expect(rows[3].right).toEqual({ lineNo: 3, text: "const c = 3;", kind: "added" });

    expect(rows[4].left).toEqual({ lineNo: 3, text: "export {};", kind: "context" });
    expect(rows[4].right).toEqual({ lineNo: 4, text: "export {};", kind: "context" });
  });

  it("renders pure deletions as removed rows with an empty right side", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,3 +1,1 @@",
      " keep",
      "-gone one",
      "-gone two",
      "",
    ].join("\n");
    const rows = parseUnifiedDiff(diff);
    expect(rows[2].left).toEqual({ lineNo: 2, text: "gone one", kind: "removed" });
    expect(rows[2].right.kind).toBe("empty");
    expect(rows[3].left).toEqual({ lineNo: 3, text: "gone two", kind: "removed" });
  });

  it("keeps -/+ pairing intact across a no-newline marker", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const rows = parseUnifiedDiff(diff);
    expect(rows).toHaveLength(2); // hunk + one modified row
    expect(rows[1].left).toEqual({ lineNo: 1, text: "old", kind: "modified" });
    expect(rows[1].right).toEqual({ lineNo: 1, text: "new", kind: "modified" });
  });

  it("tracks line numbers across multiple hunks", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -10,2 +10,3 @@",
      " ten",
      "+ten-and-a-half",
      " eleven",
      "",
    ].join("\n");
    const rows = parseUnifiedDiff(diff);
    const second = rows.filter((r) => r.left.kind === "hunk");
    expect(second).toHaveLength(2);
    // After the second hunk header, numbering restarts at 10.
    const ten = rows.find((r) => r.left.text === "ten");
    expect(ten?.left.lineNo).toBe(10);
    expect(ten?.right.lineNo).toBe(10);
    const added = rows.find((r) => r.right.text === "ten-and-a-half");
    expect(added?.right.lineNo).toBe(11);
    const eleven = rows.find((r) => r.left.text === "eleven");
    expect(eleven?.left.lineNo).toBe(11);
    expect(eleven?.right.lineNo).toBe(12);
  });

  it("returns no rows for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("skips rename metadata lines", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 95%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });
});

describe("rowsForUntracked", () => {
  it("marks every line added with an empty left column", () => {
    const rows = rowsForUntracked("hello\nworld\n");
    expect(rows).toHaveLength(2);
    expect(rows[0].left.kind).toBe("empty");
    expect(rows[0].right).toEqual({ lineNo: 1, text: "hello", kind: "added" });
    expect(rows[1].right).toEqual({ lineNo: 2, text: "world", kind: "added" });
  });

  it("handles content without a trailing newline", () => {
    const rows = rowsForUntracked("only line");
    expect(rows).toHaveLength(1);
    expect(rows[0].right.text).toBe("only line");
  });
});
