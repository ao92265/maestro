import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrappers around the Rust process/container commands
 * (`src-tauri/src/commands/processes.rs`). Each function maps 1:1 to a Rust
 * `#[tauri::command]`.
 */

/** One OS process matched by the watchlist. Mirrors Rust `DevProcess`. */
export interface DevProcess {
  pid: number;
  parentPid: number | null;
  /** Executable name, lowercased, without `.exe` (e.g. "node"). */
  name: string;
  /** Full command line (truncated backend-side). */
  cmd: string;
  cwd: string | null;
  memoryBytes: number;
  /** CPU usage normalized to the whole machine (0-100). 0 on first poll. */
  cpuPercent: number;
  runTimeSecs: number;
  /** True when this process descends from a Maestro-spawned terminal. */
  isMaestro: boolean;
  /** The watchlist entry that matched (drives grouping). */
  matched: string;
  /** TCP ports this process is LISTENING on, sorted ascending. Empty when it
   *  holds none or the OS port tool was unavailable. */
  ports: number[];
}

/** One running Docker container. Mirrors Rust `DockerContainer`. */
export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
}

/** Mirrors Rust `DockerPs`. `available: false` = no docker CLI / daemon down. */
export interface DockerPs {
  available: boolean;
  containers: DockerContainer[];
}

/**
 * True when a watchlist-matched process is an actual claude CLI session.
 *
 * The Rust matcher also hits on command-line substrings, so MCP helpers
 * under node, npm running one, and shells sourcing a ~/.claude snapshot all
 * come back matched. The OS-reported name cannot carry the decision either:
 * the CLI's executable image lives at ~/.local/share/claude/versions/<x.y.z>,
 * so `name` is a bare version number (observed live, 2026-08-21). What does
 * identify it is argv[0]: "claude" bare from a PATH launch or as the
 * basename of a full-path launch (launchd jobs). A .app bundle path is the
 * desktop app, not a coding session in a directory.
 */
export function isClaudeSession(p: DevProcess): boolean {
  const argv0 = p.cmd.split(" ")[0] ?? "";
  if (argv0.includes(".app/")) return false;
  const base = argv0.split("/").filter(Boolean).pop() ?? "";
  return base.toLowerCase() === "claude";
}

/** Scan all OS processes and return those matching the watchlist. */
export function listDevProcesses(watchlist: string[]): Promise<DevProcess[]> {
  return invoke("list_dev_processes", { watchlist });
}

/** Kill a process and its whole descendant tree. */
export function killProcessTree(pid: number): Promise<void> {
  return invoke("kill_process_tree", { pid });
}

/** List running Docker containers via the docker CLI. */
export function listDockerContainers(): Promise<DockerPs> {
  return invoke("list_docker_containers");
}

/** Stop a running Docker container by id. */
export function stopDockerContainer(id: string): Promise<void> {
  return invoke("stop_docker_container", { id });
}
