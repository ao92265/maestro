import { invoke } from "@tauri-apps/api/core";
import { normalizePath } from "@/lib/staleProcess";

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

/** Basename of a command path, OS-normalized, without a trailing .exe. */
function commandStem(s: string): string {
  const base = normalizePath(s).split("/").filter(Boolean).pop() ?? "";
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/**
 * True when a watchlist-matched process is an actual claude CLI session.
 *
 * The Rust matcher also hits on command-line substrings, so MCP helpers
 * under node, npm running one, and shells sourcing a ~/.claude snapshot all
 * come back matched. The OS-reported name cannot carry the decision either:
 * the CLI's executable image lives at ~/.local/share/claude/versions/<x.y.z>,
 * so `name` is a bare version number (observed live, 2026-08-21). What does
 * identify it is argv[0]: "claude", bare from a PATH launch or as the
 * basename of a full-path launch (launchd jobs), backslashed and .exe'd on
 * Windows, or as argv[1] behind an npm shim's env node hop. A .app bundle
 * path is the desktop app, not a coding session in a directory, and
 * `claude mcp` is plumbing that happens to live in the project.
 *
 * Known limit: `cmd` is space-joined argv, so an install path containing a
 * space parses wrong and that process is missed. Additive-only feature, so
 * a miss degrades to the pre-scan behaviour, never to a false card.
 */
export function isClaudeSession(p: DevProcess): boolean {
  const argv = p.cmd.split(" ").filter(Boolean);
  const argv0 = argv[0] ?? "";
  if (normalizePath(argv0).includes(".app/")) return false;
  let hit = commandStem(argv0) === "claude";
  let subcommand = argv[1];
  if (!hit && (commandStem(argv0) === "node" || commandStem(argv0) === "bun") && argv[1]) {
    hit = commandStem(argv[1]) === "claude";
    subcommand = argv[2];
  }
  return hit && subcommand !== "mcp";
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
