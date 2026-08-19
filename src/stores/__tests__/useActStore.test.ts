import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useActStore } from "../useActStore";

const invokeMock = vi.mocked(invoke);

describe("useActStore action errors", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useActStore.setState({ detail: null, detailGates: [], detailError: null });
  });

  /* Regression guard for the error-wipe bug (fixed twice, in c014b82 review
     and e379aee): a failed action must return before the openDetail/refresh
     fall-through, whose success path resets detailError and erased the
     message one frame after it was set. */
  it.each([
    ["cancelRun", () => useActStore.getState().cancelRun("run-1")],
    ["unblockTask", () => useActStore.getState().unblockTask("task-1", true)],
    ["resolveGate", () => useActStore.getState().resolveGate("gate-1", "approve")],
  ])("%s keeps detailError set when the invoke rejects", async (_name, action) => {
    invokeMock.mockRejectedValue(new Error("ACT unreachable"));

    await action();

    expect(useActStore.getState().detailError).toContain("ACT unreachable");
    // Early return: no follow-up openDetail/refresh invokes that would
    // overwrite the error.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("unblockTask still refreshes and reopens the detail on success", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "act_set_task_status") return 1;
      if (cmd === "act_get_run") return { id: "run-1", task: null };
      return [];
    });
    useActStore.setState({
      detail: { id: "run-1" } as ReturnType<typeof useActStore.getState>["detail"],
    });

    await useActStore.getState().unblockTask("task-1", true);

    const commands = invokeMock.mock.calls.map((call) => call[0]);
    expect(commands).toContain("act_set_task_status");
    expect(commands).toContain("act_get_run"); // openDetail ran
    expect(commands).toContain("act_list_runs"); // refresh ran
    expect(useActStore.getState().detailError).toBeNull();
  });
});
