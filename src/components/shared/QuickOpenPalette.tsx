import { useEffect, useMemo, useRef, useState } from "react";

import { filterItems, type QuickOpenItem } from "@/lib/quickOpen";

interface QuickOpenPaletteProps {
  /** Every reachable destination, sessions first then worktrees. */
  items: QuickOpenItem[];
  /** Navigate to the chosen row. The palette does not close itself. */
  onPick: (item: QuickOpenItem) => void;
  onClose: () => void;
}

const KIND_LABEL: Record<QuickOpenItem["kind"], string> = {
  session: "session",
  worktree: "worktree",
};

/**
 * Quick-open palette, opened by Cmd/Ctrl+P. Type to fuzzy-filter across
 * sessions and worktrees, ArrowUp/ArrowDown to move, Enter to open, Escape to
 * cancel. Clicking a row works too.
 *
 * Cmd/Ctrl+K would be the cmdk convention, but it is already bound to "clear
 * terminal scrollback" (TerminalView), so this uses Cmd/Ctrl+P — which is also
 * the editor convention for quick-open.
 */
export function QuickOpenPalette({ items, onPick, onClose }: QuickOpenPaletteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const filtered = useMemo(() => filterItems(items, query), [items, query]);

  // The worktree rows arrive asynchronously, after a git call per project. That
  // re-sorts the list under the user, so anchor back to the top whenever the set
  // of rows actually changes — ids are status-independent, so a session status
  // tick does not disturb the selection.
  const idsKey = filtered.map((i) => i.id).join("|");
  const [prevIdsKey, setPrevIdsKey] = useState(idsKey);
  if (idsKey !== prevIdsKey) {
    setPrevIdsKey(idsKey);
    setSelected(0);
  }

  // A stale index from a longer list would highlight nothing and send Enter to
  // the wrong row, so clamp rather than trusting the stored value.
  const activeIndex = filtered.length === 0 ? -1 : Math.min(selected, filtered.length - 1);
  const activeItem = activeIndex === -1 ? undefined : filtered[activeIndex];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlight inside the scroll box, or arrowing past the tenth row
  // would open something the user never saw. Optional-called: happy-dom (tests)
  // does not implement scrollIntoView.
  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(`quick-open-${activeItem.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeItem]);

  // Close on click-away (same pattern as EagleProjectPickerModal).
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Capture phase: live xterm terminals stay mounted behind the palette and
  // would otherwise swallow the arrow keys before it sees them.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filtered.length === 0) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setSelected(
          (Math.min(selected, filtered.length - 1) + dir + filtered.length) % filtered.length,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (activeItem) onPick(activeItem);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [filtered.length, selected, activeItem, onPick, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh] backdrop-blur-sm">
      <div
        ref={panelRef}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="border-b border-maestro-border px-3 py-2.5">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-open-list"
            aria-activedescendant={activeItem ? `quick-open-${activeItem.id}` : undefined}
            aria-label="Quick open"
            placeholder="Jump to a session or worktree…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query means a new best match — start from the top.
              setSelected(0);
            }}
            className="w-full bg-transparent text-sm text-maestro-text outline-none placeholder:text-maestro-muted"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-maestro-muted">No matches</div>
        ) : (
          <div
            id="quick-open-list"
            role="listbox"
            aria-label="Quick open results"
            className="max-h-80 overflow-y-auto py-1"
          >
            {filtered.map((item, index) => (
              // Buttons, not <li role="option">: they are natively focusable and
              // keyboard-activatable, so the row needs no a11y suppressions.
              // tabIndex -1 keeps Tab out of a long list — the input owns focus
              // and points here with aria-activedescendant.
              <button
                key={item.id}
                id={`quick-open-${item.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                onClick={() => onPick(item)}
                onMouseEnter={() => setSelected(index)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  index === activeIndex
                    ? "bg-maestro-accent/15 text-maestro-text"
                    : "text-maestro-text hover:bg-maestro-card"
                }`}
              >
                <span className="truncate font-medium">{item.label}</span>
                <span className="truncate text-[11px] text-maestro-muted">{item.sublabel}</span>
                <span className="ml-auto shrink-0 rounded bg-maestro-card px-1.5 py-0.5 text-[10px] text-maestro-muted">
                  {KIND_LABEL[item.kind]}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="border-t border-maestro-border px-3 py-2 text-[10px] text-maestro-muted">
          ↑↓ select · Enter open · Esc cancel
        </div>
      </div>
    </div>
  );
}
