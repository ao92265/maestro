import { invoke } from "@tauri-apps/api/core";

/**
 * Claude Code auto-memory: per-project fact files Claude saves under
 * `~/.claude/projects/<encoded-path>/memory/` (a MEMORY.md index plus one
 * markdown file per remembered fact). Commands address files by encoded
 * project dir name + path relative to the memory dir, never absolute paths.
 */

/** One project that has an auto-memory directory. */
export interface MemoryProject {
  /** Encoded directory name under ~/.claude/projects (e.g. "C--git-maestro"). */
  dirName: string;
  /** Absolute path to the memory directory (display only). */
  memoryPath: string;
  fileCount: number;
  /** True when this is the memory of the project currently open in Maestro. */
  isActive: boolean;
}

/** One markdown file inside a project's memory directory. */
export interface MemoryFile {
  /** Path relative to the memory dir, forward-slash separated. */
  relPath: string;
  /** Absolute path (display only). */
  path: string;
  /** `description:` from the file's frontmatter, if present. */
  description: string | null;
  /** `type:` from the frontmatter (user/feedback/project/reference). */
  memType: string | null;
  /** True for the MEMORY.md index Claude loads every session. */
  isIndex: boolean;
  sizeBytes: number;
  modified: string | null;
}

/** List every project with saved memory; the active project sorts first. */
export async function listMemoryProjects(activeProjectPath: string): Promise<MemoryProject[]> {
  return invoke<MemoryProject[]>("list_memory_projects", { activeProjectPath });
}

/** List the memory files of one project (MEMORY.md index first). */
export async function listMemoryFiles(dirName: string): Promise<MemoryFile[]> {
  return invoke<MemoryFile[]>("list_memory_files", { dirName });
}

/** Read one memory file. Returns "" if it doesn't exist. */
export async function readMemoryFile(dirName: string, relPath: string): Promise<string> {
  return invoke<string>("read_memory_file", { dirName, relPath });
}

/** Write one memory file (creates parent dirs as needed). */
export async function writeMemoryFile(
  dirName: string,
  relPath: string,
  content: string,
): Promise<void> {
  return invoke<void>("write_memory_file", { dirName, relPath, content });
}

/** Delete one memory file. */
export async function deleteMemoryFile(dirName: string, relPath: string): Promise<void> {
  return invoke<void>("delete_memory_file", { dirName, relPath });
}

/** Delete a project's entire memory directory (all facts + the index). */
export async function deleteMemoryProject(dirName: string): Promise<void> {
  return invoke<void>("delete_memory_project", { dirName });
}
