import { describe, expect, it } from "vitest";
import { normalizeCheck } from "../prChecks";

describe("normalizeCheck", () => {
  describe("CheckRun shape (status/conclusion)", () => {
    it("maps a completed successful run to success", () => {
      const check = normalizeCheck({
        __typename: "CheckRun",
        name: "build",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/o/r/runs/1",
      });
      expect(check).toEqual({
        name: "CI / build",
        state: "success",
        url: "https://github.com/o/r/runs/1",
      });
    });

    it.each([
      "SUCCESS",
      "NEUTRAL",
      "SKIPPED",
    ])("maps completed conclusion %s to success", (conclusion) => {
      const check = normalizeCheck({ status: "COMPLETED", conclusion });
      expect(check.state).toBe("success");
    });

    it.each([
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ])("maps completed conclusion %s to failure", (conclusion) => {
      const check = normalizeCheck({ status: "COMPLETED", conclusion });
      expect(check.state).toBe("failure");
    });

    it("maps a non-completed status to pending regardless of conclusion", () => {
      expect(normalizeCheck({ status: "IN_PROGRESS" }).state).toBe("pending");
      expect(normalizeCheck({ status: "QUEUED", conclusion: "SUCCESS" }).state).toBe("pending");
    });

    it("maps a completed run with no conclusion to pending", () => {
      expect(normalizeCheck({ status: "COMPLETED" }).state).toBe("pending");
    });

    it("is case-insensitive on status and conclusion", () => {
      expect(normalizeCheck({ status: "completed", conclusion: "failure" }).state).toBe("failure");
    });

    it("prefers detailsUrl and falls back to name-only when no workflowName", () => {
      const check = normalizeCheck({
        name: "lint",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.com/lint",
      });
      expect(check.name).toBe("lint");
      expect(check.url).toBe("https://example.com/lint");
    });
  });

  describe("StatusContext shape (state/context)", () => {
    it("maps a success state", () => {
      const check = normalizeCheck({
        context: "ci/legacy",
        state: "SUCCESS",
        targetUrl: "https://example.com/legacy",
      });
      expect(check).toEqual({
        name: "ci/legacy",
        state: "success",
        url: "https://example.com/legacy",
      });
    });

    it("maps an error state to failure", () => {
      expect(normalizeCheck({ context: "ci/legacy", state: "ERROR" }).state).toBe("failure");
    });

    it("maps a pending state to pending", () => {
      expect(normalizeCheck({ context: "ci/legacy", state: "PENDING" }).state).toBe("pending");
    });
  });

  describe("defensive fallbacks", () => {
    it("returns unknown for non-object entries without throwing", () => {
      expect(normalizeCheck(null)).toEqual({ name: "Unknown check", state: "unknown", url: null });
      expect(normalizeCheck(undefined)).toEqual({
        name: "Unknown check",
        state: "unknown",
        url: null,
      });
      expect(normalizeCheck("oops")).toEqual({
        name: "Unknown check",
        state: "unknown",
        url: null,
      });
      expect(normalizeCheck(42)).toEqual({ name: "Unknown check", state: "unknown", url: null });
    });

    it("defaults to pending and a placeholder name when a plain object has no recognizable fields", () => {
      expect(normalizeCheck({})).toEqual({ name: "Unknown check", state: "pending", url: null });
    });

    it("ignores non-string values for known fields instead of throwing", () => {
      const check = normalizeCheck({
        name: 123,
        workflowName: {},
        context: null,
        status: "COMPLETED",
        conclusion: ["FAILURE"],
        detailsUrl: 7,
        targetUrl: false,
      });
      expect(check).toEqual({ name: "Unknown check", state: "pending", url: null });
    });
  });
});
