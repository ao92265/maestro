import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEcosystemStore } from "../useEcosystemStore";

const invokeMock = vi.mocked(invoke);

const HEALTH = {
  services: [
    { name: "ACT", port: 3847, up: false, detail: "Not running" },
    { name: "Codor bus", port: 8137, up: true, detail: "Answering" },
  ],
  jobs: { healthy: 6, total: 7, failing: [{ label: "com.nanoclaw", reason: "not loaded" }] },
};

describe("useEcosystemStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useEcosystemStore.setState({ health: null });
  });

  it("reads the health of the other systems", async () => {
    invokeMock.mockResolvedValue(HEALTH);

    await useEcosystemStore.getState().refresh();

    expect(invokeMock).toHaveBeenCalledWith("ecosystem_health");
    expect(useEcosystemStore.getState().health?.services).toHaveLength(2);
  });

  /* Keeping the last good reading would render a system that is not running
     as though it were, which is exactly how the previous dashboards lied. */
  it("drops the reading it cannot confirm rather than showing a stale one", async () => {
    useEcosystemStore.setState({ health: HEALTH });
    invokeMock.mockRejectedValue(new Error("probe failed"));

    await useEcosystemStore.getState().refresh();

    expect(useEcosystemStore.getState().health).toBeNull();
  });
});
