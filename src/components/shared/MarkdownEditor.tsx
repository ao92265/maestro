import { Eye, Pencil } from "lucide-react";
import { forwardRef, useDeferredValue, useState } from "react";
import { MarkdownBody } from "@/components/git/shared/MarkdownBody";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Extra classes for the flex-column wrapper (e.g. "min-h-0 flex-1"). */
  className?: string;
  /**
   * Height classes applied to both the textarea and the preview pane.
   * Pass "min-h-0 flex-1" to fill a flex parent instead of a fixed height.
   */
  heightClassName?: string;
  /** Extra classes for the textarea (e.g. rounded/border variants). */
  textareaClassName?: string;
  spellCheck?: boolean;
  /**
   * Which tab is active when the editor mounts. Use "preview" when the user
   * opened an existing document to read it (rendered markdown first, one
   * click away from editing); "edit" (default) when they came to write.
   */
  defaultMode?: "edit" | "preview";
  /**
   * Render a stacked editor + always-visible preview that re-renders on
   * every keystroke; the Edit/Preview toggle is hidden. Pass
   * heightClassName="min-h-0 flex-1" so both panes split the available
   * height.
   */
  live?: boolean;
}

/**
 * Markdown textarea with an Edit/Preview toggle. Preview renders GitHub
 * Flavored Markdown (headings, tables, task lists, code blocks) via the
 * shared MarkdownBody renderer, so edited docs never read as a wall of
 * raw text. Use this for any user-editable markdown in the app.
 *
 * With `live`, the toggle is replaced by a stacked layout — textarea on top,
 * live-updating preview below — for places (like the Notes panel) where
 * formatting should appear as the user types.
 */
export const MarkdownEditor = forwardRef<HTMLTextAreaElement, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      placeholder,
      className = "",
      heightClassName = "h-80",
      textareaClassName = "",
      spellCheck = false,
      defaultMode = "edit",
      live = false,
    },
    ref,
  ) {
    const [mode, setMode] = useState<"edit" | "preview">(defaultMode);
    // Deferring the previewed text keeps typing responsive if the document
    // grows large — the textarea updates immediately, the preview lags a tick.
    const deferredValue = useDeferredValue(value);

    const textareaEl = (
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={spellCheck}
        className={`w-full resize-none rounded border border-maestro-border bg-maestro-surface p-3 font-mono text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none ${heightClassName} ${textareaClassName}`}
      />
    );

    if (live) {
      return (
        <div className={`flex flex-col gap-2 ${className}`}>
          {textareaEl}
          <div
            className={`w-full overflow-y-auto rounded border border-maestro-border bg-maestro-surface p-3 ${heightClassName}`}
          >
            {value.trim() ? (
              <MarkdownBody content={deferredValue} />
            ) : (
              <p className="text-xs italic text-maestro-muted">Nothing to preview.</p>
            )}
          </div>
        </div>
      );
    }

    const tabClass = (active: boolean) =>
      `flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "bg-maestro-accent/15 font-medium text-maestro-accent"
          : "text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
      }`;

    return (
      <div className={`flex flex-col ${className}`}>
        <div className="mb-1.5 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMode("edit")}
            className={tabClass(mode === "edit")}
          >
            <Pencil size={11} />
            Edit
          </button>
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={tabClass(mode === "preview")}
          >
            <Eye size={11} />
            Preview
          </button>
        </div>

        {mode === "edit" ? (
          textareaEl
        ) : (
          <div
            className={`w-full overflow-y-auto rounded border border-maestro-border bg-maestro-surface p-3 ${heightClassName}`}
          >
            {value.trim() ? (
              <MarkdownBody content={value} />
            ) : (
              <p className="text-xs italic text-maestro-muted">Nothing to preview.</p>
            )}
          </div>
        )}
      </div>
    );
  },
);
