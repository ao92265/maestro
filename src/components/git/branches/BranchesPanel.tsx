import { ask } from "@tauri-apps/plugin-dialog";
import { Check, Cloud, GitBranch, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useGitStore } from "../../../stores/useGitStore";

/**
 * Branches tab: full management of local and remote branches — checkout,
 * create, rename, delete local (with force fallback for unmerged branches),
 * and delete on the remote. Remote refs refresh via `git fetch --all --prune`.
 */
export function BranchesPanel({ repoPath }: { repoPath: string }) {
  const {
    branches,
    currentBranch,
    error,
    fetchBranches,
    fetchCurrentBranch,
    fetchAllRemoteRefs,
    checkoutBranch,
    createBranch,
    deleteBranch,
    renameBranch,
    deleteRemoteBranch,
  } = useGitStore();

  const [newBranchName, setNewBranchName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  /** Branch name currently being renamed, plus the draft value. */
  const [renaming, setRenaming] = useState<{ name: string; draft: string } | null>(null);
  /** Branch name with an action (checkout/delete/rename) in flight. */
  const [busyBranch, setBusyBranch] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchBranches(repoPath);
    fetchCurrentBranch(repoPath);
  }, [repoPath, fetchBranches, fetchCurrentBranch]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await fetchAllRemoteRefs(repoPath);
      refresh();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreate = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      await createBranch(repoPath, name);
      setNewBranchName("");
    } catch {
      // Error is surfaced via the store's error state.
    } finally {
      setIsCreating(false);
    }
  };

  const handleCheckout = async (name: string) => {
    setBusyBranch(name);
    try {
      await checkoutBranch(repoPath, name);
      refresh();
    } catch {
      // Store error state shows the failure.
    } finally {
      setBusyBranch(null);
    }
  };

  const handleDeleteLocal = async (name: string) => {
    const confirmed = await ask(`Delete local branch "${name}"?`, {
      title: "Delete Branch",
      kind: "warning",
    }).catch(() => false);
    if (!confirmed) return;
    setBusyBranch(name);
    try {
      await deleteBranch(repoPath, name);
    } catch (err) {
      // `git branch -d` refuses unmerged branches; offer the -D fallback.
      if (String(err).includes("not fully merged")) {
        const force = await ask(
          `"${name}" has commits that are not merged anywhere else. Delete it anyway and lose them?`,
          { title: "Branch Not Merged", kind: "warning" },
        ).catch(() => false);
        if (force) {
          await deleteBranch(repoPath, name, true).catch(() => {});
        }
      }
    } finally {
      setBusyBranch(null);
    }
  };

  const handleDeleteRemote = async (name: string) => {
    // Remote branch names look like "origin/feature-x".
    const slash = name.indexOf("/");
    if (slash <= 0) return;
    const remoteName = name.slice(0, slash);
    const branchName = name.slice(slash + 1);
    const confirmed = await ask(
      `Delete branch "${branchName}" on remote "${remoteName}"? This affects everyone using that remote.`,
      { title: "Delete Remote Branch", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setBusyBranch(name);
    try {
      await deleteRemoteBranch(repoPath, remoteName, branchName);
    } catch {
      // Store error state shows the failure.
    } finally {
      setBusyBranch(null);
    }
  };

  const handleRenameSubmit = async () => {
    if (!renaming) return;
    const newName = renaming.draft.trim();
    if (!newName || newName === renaming.name) {
      setRenaming(null);
      return;
    }
    setBusyBranch(renaming.name);
    try {
      await renameBranch(repoPath, renaming.name, newName);
      setRenaming(null);
    } catch {
      // Keep the input open so the user can adjust the name.
    } finally {
      setBusyBranch(null);
    }
  };

  const rowButtonClass =
    "shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-maestro-border/60";

  const renderBranchRow = (name: string, isRemote: boolean, isCurrent: boolean) => {
    const busy = busyBranch === name;

    if (!isRemote && renaming?.name === name) {
      return (
        <div key={name} className="flex items-center gap-1.5 rounded-md px-2 py-1">
          <GitBranch size={12} className="shrink-0 text-maestro-muted" />
          <input
            value={renaming.draft}
            onChange={(e) => setRenaming({ name, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameSubmit();
              if (e.key === "Escape") setRenaming(null);
            }}
            // biome-ignore lint/a11y/noAutofocus: Focus moves to the field the user just opened for renaming.
            autoFocus
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-maestro-accent bg-maestro-surface px-1.5 py-0.5 text-xs text-maestro-text focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleRenameSubmit()}
            className="shrink-0 rounded p-0.5 hover:bg-maestro-border/60"
            title="Rename"
          >
            <Check size={12} className="text-maestro-green" />
          </button>
          <button
            type="button"
            onClick={() => setRenaming(null)}
            className="shrink-0 rounded p-0.5 hover:bg-maestro-border/60"
            title="Cancel"
          >
            <X size={12} className="text-maestro-muted" />
          </button>
        </div>
      );
    }

    return (
      <div
        key={name}
        className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-maestro-border/40"
      >
        {isRemote ? (
          <Cloud size={12} className="shrink-0 text-maestro-muted" />
        ) : (
          <GitBranch
            size={12}
            className={`shrink-0 ${isCurrent ? "text-maestro-accent" : "text-maestro-muted"}`}
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-xs ${
            isCurrent ? "font-semibold text-maestro-accent" : "text-maestro-text"
          }`}
          title={name}
        >
          {name}
        </span>
        {isCurrent && (
          <span className="shrink-0 rounded bg-maestro-accent/20 px-1 text-[9px] font-bold text-maestro-accent">
            CURRENT
          </span>
        )}
        {busy ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-maestro-muted" />
        ) : (
          <>
            {!isCurrent && (
              <button
                type="button"
                onClick={() => void handleCheckout(name)}
                className={rowButtonClass}
                title={isRemote ? "Checkout (creates a local tracking branch)" : "Checkout"}
              >
                <Check size={12} className="text-maestro-green" />
              </button>
            )}
            {!isRemote && (
              <button
                type="button"
                onClick={() => setRenaming({ name, draft: name })}
                className={rowButtonClass}
                title="Rename branch"
              >
                <Pencil size={12} className="text-maestro-muted" />
              </button>
            )}
            {!isCurrent && (
              <button
                type="button"
                onClick={() => void (isRemote ? handleDeleteRemote(name) : handleDeleteLocal(name))}
                className={`${rowButtonClass} hover:bg-maestro-red/10`}
                title={isRemote ? "Delete branch on the remote" : "Delete local branch"}
              >
                <Trash2 size={12} className="text-maestro-red" />
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Create + sync toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-maestro-border/60 px-2 py-2">
        <input
          value={newBranchName}
          onChange={(e) => setNewBranchName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          placeholder="New branch from HEAD..."
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={isCreating || !newBranchName.trim()}
          className="flex shrink-0 items-center gap-1 rounded bg-maestro-accent px-2 py-1 text-xs text-white hover:bg-maestro-accent/80 disabled:opacity-50"
          title="Create branch from HEAD"
        >
          {isCreating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Create
        </button>
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={isSyncing}
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
          title="Fetch all remotes (with prune)"
        >
          <RefreshCw size={13} className={isSyncing ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="shrink-0 break-words border-b border-maestro-border/60 px-2 py-1 text-[10px] text-maestro-red">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {/* Local branches */}
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
          Local ({localBranches.length})
        </p>
        {localBranches.length === 0 ? (
          <p className="px-2 pb-2 text-[11px] italic text-maestro-muted">No local branches</p>
        ) : (
          localBranches.map((b) =>
            renderBranchRow(b.name, false, b.is_current || b.name === currentBranch),
          )
        )}

        {/* Remote branches */}
        <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
          Remote ({remoteBranches.length})
        </p>
        {remoteBranches.length === 0 ? (
          <p className="px-2 text-[11px] italic text-maestro-muted">
            No remote branches — try fetching
          </p>
        ) : (
          remoteBranches.map((b) => renderBranchRow(b.name, true, false))
        )}
      </div>
    </div>
  );
}
