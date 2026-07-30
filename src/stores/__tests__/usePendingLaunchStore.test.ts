import { beforeEach, describe, expect, it } from "vitest";
import { usePendingLaunchStore, type PendingLaunch } from "../usePendingLaunchStore";

function launchFor(tabId: string): PendingLaunch {
  return {
    tabId,
    mode: "Claude",
    resumeSessionId: "11111111-2222-3333-4444-555555555555",
    workingDirOverride: null,
    branch: null,
  };
}

describe("usePendingLaunchStore", () => {
  beforeEach(() => {
    usePendingLaunchStore.setState({ pending: null });
  });

  it("consume returns and clears the pending launch for the matching tab", () => {
    const launch = launchFor("tab-1");
    usePendingLaunchStore.getState().request(launch);

    const consumed = usePendingLaunchStore.getState().consume("tab-1");

    expect(consumed).toEqual(launch);
    expect(usePendingLaunchStore.getState().pending).toBeNull();
  });

  it("consume for a different tab returns null and keeps the request queued", () => {
    const launch = launchFor("tab-1");
    usePendingLaunchStore.getState().request(launch);

    expect(usePendingLaunchStore.getState().consume("tab-2")).toBeNull();
    expect(usePendingLaunchStore.getState().pending).toEqual(launch);
  });

  it("consume with nothing queued returns null", () => {
    expect(usePendingLaunchStore.getState().consume("tab-1")).toBeNull();
  });

  it("a new request replaces the previous one", () => {
    usePendingLaunchStore.getState().request(launchFor("tab-1"));
    usePendingLaunchStore.getState().request(launchFor("tab-2"));

    expect(usePendingLaunchStore.getState().consume("tab-1")).toBeNull();
    expect(usePendingLaunchStore.getState().consume("tab-2")).toMatchObject({ tabId: "tab-2" });
  });
});
