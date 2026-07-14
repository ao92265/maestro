import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContextDocEditorModal } from "@/components/claudemd";
import { MarkdownEditor } from "@/components/shared/MarkdownEditor";
import { listContextDocs, readContextDoc, type ContextDoc } from "@/lib/claudemd";
import {
  deleteMemoryFile,
  listMemoryFiles,
  listMemoryProjects,
  readMemoryFile,
  writeMemoryFile,
  type MemoryFile,
  type MemoryProject,
} from "@/lib/memory";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Badge styling per memory type (frontmatter `type:`). */
const TYPE_BADGES: Record<string, string> = {
  user: "bg-maestro-green/20 text-maestro-green",
  feedback: "bg-maestro-orange/20 text-maestro-orange",
  project: "bg-maestro-accent/20 text-maestro-accent",
  reference: "bg-maestro-purple/20 text-maestro-purple",
};

/**
 * Memory tab: total control over what Claude Code retains.
 *
 * - User level: `~/.claude/CLAUDE.md` — instructions applied in every project.
 * - Per project: the auto-memory folders (`~/.claude/projects/<x>/memory/`)
 *   where Claude saves facts on its own — a MEMORY.md index plus one small
 *   markdown file per fact. Any project's memory can be inspected, edited
 *   or deleted here, not just the one currently open.
 */
export function MemorySection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  /* ── User-level CLAUDE.md ── */
  const [userDoc, setUserDoc] = useState<ContextDoc | null>(null);
  const [editingUserDoc, setEditingUserDoc] = useState<{ doc: ContextDoc; content: string } | null>(
    null,
  );

  /* ── Per-project auto-memory ── */
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [filesByDir, setFilesByDir] = useState<Record<string, MemoryFile[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    dirName: string;
    file: MemoryFile;
    content: string;
  } | null>(null);

  const fetchFiles = useCallback(async (dirName: string) => {
    try {
      const files = await listMemoryFiles(dirName);
      setFilesByDir((prev) => ({ ...prev, [dirName]: files }));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // User tier docs are returned even without a project path.
      const docs = await listContextDocs(projectPath).catch(() => listContextDocs(""));
      setUserDoc(docs.find((d) => d.tier === "user" && d.kind === "claude") ?? null);

      const result = await listMemoryProjects(projectPath);
      setProjects(result);
      setFilesByDir({});
      // Auto-expand the project currently open in Maestro.
      const active = result.find((p) => p.isActive);
      setExpandedDirs(active ? new Set([active.dirName]) : new Set());
      if (active) await fetchFiles(active.dirName);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectPath, fetchFiles]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleProject = async (dirName: string) => {
    const next = new Set(expandedDirs);
    if (next.has(dirName)) {
      next.delete(dirName);
    } else {
      next.add(dirName);
      if (!filesByDir[dirName]) await fetchFiles(dirName);
    }
    setExpandedDirs(next);
  };

  const handleOpenUserDoc = async () => {
    if (!userDoc) return;
    try {
      const content = userDoc.exists ? await readContextDoc(userDoc.path) : "";
      setEditingUserDoc({ doc: userDoc, content });
    } catch (err) {
      setError(String(err));
    }
  };

  const handleOpenFile = async (dirName: string, file: MemoryFile) => {
    try {
      const content = await readMemoryFile(dirName, file.relPath);
      setEditing({ dirName, file, content });
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteFile = async (dirName: string, file: MemoryFile) => {
    const confirmed = await ask(
      `Delete "${file.relPath}"? Claude will no longer recall this${
        file.isIndex ? " project's memory index" : " fact"
      }.`,
      { title: "Delete Memory File", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    try {
      await deleteMemoryFile(dirName, file.relPath);
      await fetchFiles(dirName);
      // Keep the per-project counts honest without a full reload.
      setProjects((prev) =>
        prev
          .map((p) => (p.dirName === dirName ? { ...p, fileCount: p.fileCount - 1 } : p))
          .filter((p) => p.fileCount > 0),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  const totalFiles = projects.reduce((n, p) => n + p.fileCount, 0);

  return (
    <>
      {/* User level */}
      <div className={cardClass}>
        <SectionHeader
          icon={User}
          label="User Memory"
          iconColor={userDoc?.exists ? "text-maestro-green" : "text-maestro-muted"}
        />
        <p className="mb-1 px-1 text-[10px] text-maestro-muted/70">
          Instructions Claude applies in every project.
        </p>
        {userDoc ? (
          <button
            type="button"
            title={userDoc.path}
            onClick={handleOpenUserDoc}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-maestro-border/40"
          >
            {userDoc.exists ? (
              <Check size={13} className="shrink-0 text-maestro-green" />
            ) : (
              <AlertTriangle size={13} className="shrink-0 text-maestro-orange/70" />
            )}
            <span className="flex-1 truncate text-xs text-maestro-text">~/.claude/CLAUDE.md</span>
          </button>
        ) : (
          <p className="px-1 py-0.5 text-[11px] text-maestro-muted">Not available</p>
        )}
      </div>

      <div className="my-1 h-px bg-maestro-border/30" />

      {/* Per-project auto-memory */}
      <div className={cardClass}>
        <SectionHeader
          icon={Brain}
          label="Project Memory"
          iconColor={totalFiles > 0 ? "text-maestro-purple" : "text-maestro-muted"}
          badge={
            totalFiles > 0 ? (
              <span className="rounded-full bg-maestro-purple/20 px-1.5 text-[10px] font-bold text-maestro-purple">
                {totalFiles}
              </span>
            ) : undefined
          }
          right={
            <button
              type="button"
              onClick={refresh}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              disabled={isLoading}
              title="Refresh memory"
            >
              <RefreshCw
                size={12}
                className={`text-maestro-muted ${isLoading ? "animate-spin" : ""}`}
              />
            </button>
          }
        />
        <p className="mb-1 px-1 text-[10px] text-maestro-muted/70">
          Facts Claude saved on its own, per project.
        </p>

        {error && <p className="break-words px-1 py-0.5 text-[10px] text-maestro-red">{error}</p>}

        {isLoading && projects.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-1">
            <Loader2 size={13} className="shrink-0 animate-spin text-maestro-muted" />
            <span className="text-xs text-maestro-muted">Checking...</span>
          </div>
        ) : projects.length === 0 ? (
          <p className="px-1 py-0.5 text-[11px] text-maestro-muted">
            No saved memories on this machine
          </p>
        ) : (
          <div className="space-y-0.5">
            {projects.map((project) => {
              const expanded = expandedDirs.has(project.dirName);
              const files = filesByDir[project.dirName];
              return (
                <div key={project.dirName}>
                  <button
                    type="button"
                    onClick={() => toggleProject(project.dirName)}
                    title={project.memoryPath}
                    className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-maestro-border/40"
                  >
                    {expanded ? (
                      <ChevronDown size={11} className="shrink-0 text-maestro-muted" />
                    ) : (
                      <ChevronRight size={11} className="shrink-0 text-maestro-muted" />
                    )}
                    <span
                      className={`flex-1 truncate text-xs ${
                        project.isActive
                          ? "font-semibold text-maestro-text"
                          : "text-maestro-text/80"
                      }`}
                    >
                      {project.dirName}
                    </span>
                    {project.isActive && (
                      <span className="shrink-0 rounded bg-maestro-accent/20 px-1 text-[9px] font-bold text-maestro-accent">
                        CURRENT
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-maestro-muted">
                      {project.fileCount}
                    </span>
                  </button>

                  {expanded && (
                    <div className="ml-2 border-l border-maestro-border/40 pl-1.5">
                      {!files ? (
                        <div className="flex items-center gap-2 px-1 py-1">
                          <Loader2 size={11} className="shrink-0 animate-spin text-maestro-muted" />
                        </div>
                      ) : (
                        files.map((file) => {
                          const badgeCls = file.memType ? TYPE_BADGES[file.memType] : undefined;
                          return (
                            <div
                              key={file.relPath}
                              className="group flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-maestro-border/40"
                            >
                              <button
                                type="button"
                                onClick={() => handleOpenFile(project.dirName, file)}
                                title={file.description ?? file.path}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                              >
                                <FileText
                                  size={11}
                                  className={`shrink-0 ${
                                    file.isIndex ? "text-maestro-accent" : "text-maestro-muted"
                                  }`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-xs text-maestro-text">
                                    {file.relPath}
                                  </span>
                                  {file.description && (
                                    <span className="block truncate text-[10px] text-maestro-muted">
                                      {file.description}
                                    </span>
                                  )}
                                </span>
                              </button>
                              {file.isIndex ? (
                                <span className="shrink-0 rounded bg-maestro-accent/20 px-1 text-[9px] font-bold text-maestro-accent">
                                  INDEX
                                </span>
                              ) : (
                                badgeCls && (
                                  <span
                                    className={`shrink-0 rounded px-1 text-[9px] font-medium ${badgeCls}`}
                                  >
                                    {file.memType}
                                  </span>
                                )
                              )}
                              <button
                                type="button"
                                onClick={() => void handleDeleteFile(project.dirName, file)}
                                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-maestro-red/10 group-hover:opacity-100"
                                title="Delete this memory file"
                              >
                                <Trash2 size={10} className="text-maestro-red" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editingUserDoc && (
        <ContextDocEditorModal
          path={editingUserDoc.doc.path}
          label={editingUserDoc.doc.label}
          tier={editingUserDoc.doc.tier}
          kind={editingUserDoc.doc.kind}
          exists={editingUserDoc.doc.exists}
          initialContent={editingUserDoc.content}
          onClose={() => setEditingUserDoc(null)}
          onSaved={() => refresh()}
        />
      )}

      {editing && (
        <MemoryFileEditorModal
          dirName={editing.dirName}
          file={editing.file}
          initialContent={editing.content}
          onClose={() => setEditing(null)}
          onSaved={() => void fetchFiles(editing.dirName)}
        />
      )}
    </>
  );
}

/** Modal for editing one auto-memory markdown file. */
function MemoryFileEditorModal({
  dirName,
  file,
  initialContent,
  onClose,
  onSaved,
}: {
  dirName: string;
  file: MemoryFile;
  initialContent: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await writeMemoryFile(dirName, file.relPath, content);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-2xl rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-maestro-text">Edit {file.relPath}</h2>
            <span className="text-[10px] uppercase tracking-wider text-maestro-muted">
              {dirName}
            </span>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-maestro-border/40">
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        <div className="p-4">
          <p className="mb-1 truncate text-[11px] text-maestro-muted" title={file.path}>
            {file.path}
          </p>

          <MarkdownEditor value={content} onChange={setContent} placeholder="Memory content..." />

          <p className="mt-2 text-[10px] text-maestro-muted/70">
            Heads up: if a Claude session is running in this project, it may save new memories and
            overwrite edits made here.
          </p>

          {error && <p className="mt-2 text-xs text-maestro-red">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-maestro-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-2 text-xs text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded bg-maestro-accent px-4 py-2 text-xs text-white hover:bg-maestro-accent/80 disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
