import { describe, expect, it } from "vitest";

import { describeSessionContext, userIntentFrom } from "../sessionContext";
import type { ClaudeEvent } from "@/types/claude-events";

function userMessage(text: string, uuid = "u1"): ClaudeEvent {
  return {
    event_type: "UserMessage",
    session_id: 1,
    uuid,
    text,
    timestamp: "2026-08-07T10:00:00Z",
  };
}

function toolUse(tool_name: string, input_summary: string): ClaudeEvent {
  return {
    event_type: "ToolUseStarted",
    session_id: 1,
    tool_name,
    tool_use_id: "t1",
    input_summary,
    timestamp: "2026-08-07T10:00:00Z",
  };
}

const EMPTY = { events: [], filesModified: [] };

describe("userIntentFrom", () => {
  it("returns plain prompts collapsed to one line", () => {
    expect(userIntentFrom("fix the login\n\nredirect loop")).toBe("fix the login redirect loop");
  });

  it("prefers slash-command arguments over the command name", () => {
    const text =
      "<command-message>review is running</command-message><command-name>/review</command-name><command-args>the auth module</command-args>";
    expect(userIntentFrom(text)).toBe("the auth module");
  });

  it("falls back to the command name when it has no arguments", () => {
    expect(userIntentFrom("<command-name>/compact</command-name>")).toBe("/compact");
  });

  it("ignores machine-injected entries", () => {
    expect(userIntentFrom("<system-reminder>context follows</system-reminder>")).toBeNull();
    expect(userIntentFrom("<bash-stdout>ok</bash-stdout>")).toBeNull();
    expect(userIntentFrom("   ")).toBeNull();
  });

  it("strips leading markdown punctuation", () => {
    expect(userIntentFrom("- ship the fix")).toBe("ship the fix");
  });
});

describe("describeSessionContext", () => {
  it("returns null when there is nothing to describe", () => {
    expect(describeSessionContext(EMPTY)).toBeNull();
  });

  it("leads with the question the agent is blocked on", () => {
    const line = describeSessionContext({
      ...EMPTY,
      needsInputPrompt: "Should I force-push?",
      statusMessage: "waiting",
      events: [userMessage("do the thing")],
    });
    expect(line).toBe("Asking: Should I force-push?");
  });

  it("uses the most recent real user prompt over the status line", () => {
    const line = describeSessionContext({
      ...EMPTY,
      statusMessage: "Running tests",
      events: [userMessage("first ask", "u1"), userMessage("second ask", "u2")],
    });
    expect(line).toBe("second ask");
  });

  it("skips injected user entries when picking the prompt", () => {
    const line = describeSessionContext({
      ...EMPTY,
      events: [userMessage("real ask", "u1"), userMessage("<system-reminder>noise</system-reminder>", "u2")],
    });
    expect(line).toBe("real ask");
  });

  it("falls back to the status line, then the tool in flight", () => {
    expect(describeSessionContext({ ...EMPTY, statusMessage: "Running the suite" })).toBe(
      "Running the suite"
    );
    expect(describeSessionContext({ ...EMPTY, events: [toolUse("Bash", "npm test")] })).toBe(
      "Bash: npm test"
    );
  });

  it("falls back to the files touched", () => {
    const line = describeSessionContext({
      events: [],
      filesModified: ["C:/git/maestro/src/a.ts", "C:/git/maestro/src/b.ts"],
    });
    expect(line).toBe("2 files touched — a.ts, b.ts");
  });

  it("truncates long prompts on a word boundary", () => {
    const line = describeSessionContext({
      ...EMPTY,
      events: [userMessage(`${"alpha ".repeat(40)}omega`)],
    });
    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(111);
    expect(line!.endsWith("…")).toBe(true);
    expect(line!).not.toContain("  ");
  });
});
