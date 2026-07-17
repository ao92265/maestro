import { describe, expect, it } from "vitest";
import { assessStaleness, isUnderAnyPath, normalizePath } from "../staleProcess";

describe("normalizePath", () => {
  it("lowercases, forward-slashes and trims trailing slashes", () => {
    expect(normalizePath("C:\\Git\\Maestro\\")).toBe("c:/git/maestro");
    expect(normalizePath("/home/me/app/")).toBe("/home/me/app");
  });
});

describe("isUnderAnyPath", () => {
  const open = ["C:\\git\\maestro", "C:\\git\\other"];

  it("matches an exact project path (case/slash-insensitive)", () => {
    expect(isUnderAnyPath("c:/git/maestro", open)).toBe(true);
  });

  it("matches a subfolder of an open project", () => {
    expect(isUnderAnyPath("C:\\git\\maestro\\src-tauri", open)).toBe(true);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(isUnderAnyPath("C:\\git\\maestro-fork", open)).toBe(false);
  });

  it("is false for null cwd or no open projects", () => {
    expect(isUnderAnyPath(null, open)).toBe(false);
    expect(isUnderAnyPath("C:\\git\\maestro", [])).toBe(false);
  });
});

describe("assessStaleness", () => {
  const open = ["C:\\git\\maestro"];

  it("never flags a process with no listening ports", () => {
    expect(
      assessStaleness({ anyMaestro: false, cwd: "C:\\tmp", ports: [], openProjectPaths: open })
        .level,
    ).toBeNull();
  });

  it("flags a port-holder that no open project owns", () => {
    const a = assessStaleness({
      anyMaestro: false,
      cwd: "C:\\git\\closed-project",
      ports: [3000],
      openProjectPaths: open,
    });
    expect(a.level).toBe("stale");
    expect(a.reason).toContain(":3000");
  });

  it("does not flag a server Maestro launched", () => {
    expect(
      assessStaleness({
        anyMaestro: true,
        cwd: "C:\\git\\closed-project",
        ports: [3000],
        openProjectPaths: open,
      }).level,
    ).toBeNull();
  });

  it("does not flag a server living under a still-open project", () => {
    expect(
      assessStaleness({
        anyMaestro: false,
        cwd: "C:\\git\\maestro\\src",
        ports: [5173],
        openProjectPaths: open,
      }).level,
    ).toBeNull();
  });
});
