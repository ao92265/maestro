import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock Tauri dependencies before importing the store
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  useWorkspaceStore,
  withWorkspaceRoot,
  type RepositoryInfo,
} from "../useWorkspaceStore";

const mockInvoke = vi.mocked(invoke);

function repo(path: string, isGitRepo = true): RepositoryInfo {
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    isGitRepo,
    currentBranch: isGitRepo ? "main" : null,
    remoteUrl: null,
  };
}

describe("withWorkspaceRoot", () => {
  it("prepends the parent folder as a non-git selectable entry", () => {
    const result = withWorkspaceRoot("C:\\git\\dreadnought", [
      repo("C:\\git\\dreadnought\\maestro"),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      path: "C:\\git\\dreadnought",
      name: "dreadnought",
      isGitRepo: false,
    });
    expect(result[1].path).toBe("C:\\git\\dreadnought\\maestro");
  });

  it("does not duplicate the root when the scan already includes it", () => {
    const result = withWorkspaceRoot("C:\\git\\dreadnought", [
      repo("C:\\git\\dreadnought"),
      repo("C:\\git\\dreadnought\\maestro"),
    ]);

    expect(result.filter((r) => r.path === "C:\\git\\dreadnought")).toHaveLength(1);
  });

  it("treats trailing separators as the same path", () => {
    const result = withWorkspaceRoot("C:\\git\\dreadnought\\", [
      repo("C:\\git\\dreadnought"),
    ]);

    expect(result).toHaveLength(1);
  });

  it("returns an empty list unchanged (non-git workspace stays non-git)", () => {
    expect(withWorkspaceRoot("C:\\git\\empty", [])).toEqual([]);
  });
});

describe("openProject with a non-git parent folder containing repos", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [] });
    mockInvoke.mockReset();
  });

  it("offers the parent folder as the default selected root", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "is_git_repository") return false;
      if (cmd === "detect_repositories") {
        return [repo("C:\\git\\dreadnought\\maestro")];
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await useWorkspaceStore.getState().openProject("C:\\git\\dreadnought");

    const tab = useWorkspaceStore.getState().tabs[0];
    expect(tab.workspaceType).toBe("multi-repo");
    expect(tab.selectedRepoPath).toBe("C:\\git\\dreadnought");
    expect(tab.repositories.map((r) => r.path)).toEqual([
      "C:\\git\\dreadnought",
      "C:\\git\\dreadnought\\maestro",
    ]);
  });
});

describe("updateRepositories keeps the workspace root", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [] });
  });

  it("re-adds the root after a rescan and preserves a root selection", () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          name: "dreadnought",
          projectPath: "C:\\git\\dreadnought",
          active: true,
          sessionIds: [],
          sessionsLaunched: false,
          workspaceType: "multi-repo",
          repositories: withWorkspaceRoot("C:\\git\\dreadnought", [
            repo("C:\\git\\dreadnought\\maestro"),
          ]),
          selectedRepoPath: "C:\\git\\dreadnought",
          worktreeBasePath: null,
        },
      ],
    });

    // Simulate a focus-refresh rescan, which returns only the nested repos
    useWorkspaceStore
      .getState()
      .updateRepositories("t1", [repo("C:\\git\\dreadnought\\maestro")]);

    const tab = useWorkspaceStore.getState().tabs[0];
    expect(tab.repositories[0].path).toBe("C:\\git\\dreadnought");
    expect(tab.selectedRepoPath).toBe("C:\\git\\dreadnought");
  });
});
