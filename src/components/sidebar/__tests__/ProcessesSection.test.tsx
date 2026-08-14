import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import type { DevProcess } from "@/lib/processes";
import { ProcessesSection } from "../ProcessesSection";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

function buildProc(overrides: Partial<DevProcess> = {}): DevProcess {
  return {
    pid: 100,
    parentPid: 1,
    name: "node",
    cmd: "node /repo/node_modules/vite/bin/vite.js",
    cwd: "C:\\git\\my-app",
    memoryBytes: 256 * 1024 * 1024,
    cpuPercent: 1.5,
    runTimeSecs: 3700,
    isMaestro: false,
    matched: "vite",
    ports: [],
    ...overrides,
  };
}

function mockInvoke({
  processes = [] as DevProcess[],
  docker = { available: false, containers: [] as unknown[] },
} = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "list_dev_processes":
        return processes;
      case "list_docker_containers":
        return docker;
      case "kill_process_tree":
      case "stop_docker_container":
        return undefined;
      default:
        return undefined;
    }
  });
}

describe("ProcessesSection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    // The poll skips when the window is unfocused; happy-dom is headless.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("groups duplicate command+cwd pairs into one row with a count", async () => {
    mockInvoke({
      processes: [
        buildProc({ pid: 100 }),
        buildProc({ pid: 101 }),
        buildProc({ pid: 102 }),
        buildProc({
          pid: 200,
          matched: "uvicorn",
          cmd: "python -m uvicorn app:app",
          cwd: "C:\\git\\api",
        }),
      ],
    });
    render(<ProcessesSection />);

    expect(await screen.findByText("vite")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.getByText("uvicorn")).toBeInTheDocument();
    // Header badge counts individual processes, not groups.
    expect(screen.getByTitle("4 watched processes running")).toBeInTheDocument();

    // Expanding the group reveals the individual PIDs.
    fireEvent.click(screen.getByTitle("Show each process"));
    expect(screen.getByText("PID 100")).toBeInTheDocument();
    expect(screen.getByText("PID 102")).toBeInTheDocument();
  });

  it("badges processes spawned by Maestro", async () => {
    mockInvoke({ processes: [buildProc({ isMaestro: true, matched: "claude", cmd: "claude" })] });
    render(<ProcessesSection />);
    expect(await screen.findByText("MAESTRO")).toBeInTheDocument();
  });

  it("kills a process tree after confirmation", async () => {
    mockInvoke({ processes: [buildProc()] });
    askMock.mockResolvedValue(true);
    render(<ProcessesSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Kill vite" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("kill_process_tree", { pid: 100 });
    });
    expect(askMock).toHaveBeenCalledOnce();
  });

  it("does not kill when the confirm dialog is declined", async () => {
    mockInvoke({ processes: [buildProc()] });
    askMock.mockResolvedValue(false);
    render(<ProcessesSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Kill vite" }));

    await waitFor(() => expect(askMock).toHaveBeenCalledOnce());
    expect(invokeMock).not.toHaveBeenCalledWith("kill_process_tree", expect.anything());
  });

  it("flags a port-holding server that no open project owns, and shows its port", async () => {
    // No projects are open (persisted store is stubbed empty), so a vite server
    // listening on :5173 that Maestro didn't launch is a likely leftover.
    mockInvoke({
      processes: [
        buildProc({
          pid: 300,
          cwd: "C:\\git\\some-closed-project",
          isMaestro: false,
          ports: [5173],
        }),
      ],
    });
    render(<ProcessesSection />);

    expect(await screen.findByText("STALE")).toBeInTheDocument();
    expect(screen.getByText(":5173")).toBeInTheDocument();
  });

  it("shows Docker containers when the daemon is reachable, hides them otherwise", async () => {
    mockInvoke({
      processes: [],
      docker: {
        available: true,
        containers: [
          { id: "abc123", name: "postgres-dev", image: "postgres:16", status: "Up 2 hours" },
        ],
      },
    });
    const { unmount } = render(<ProcessesSection />);
    expect(await screen.findByText("Containers")).toBeInTheDocument();
    expect(screen.getByText("postgres-dev")).toBeInTheDocument();
    unmount();

    mockInvoke({ processes: [], docker: { available: false, containers: [] } });
    render(<ProcessesSection />);
    expect(await screen.findByText("No watched processes running")).toBeInTheDocument();
    expect(screen.queryByText("Containers")).not.toBeInTheDocument();
  });
});
