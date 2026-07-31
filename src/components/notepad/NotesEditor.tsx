import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "tiptap-markdown";

import type { MarkdownStorage } from "tiptap-markdown";

interface NotesEditorProps {
  /**
   * Markdown loaded when the editor mounts. The parent remounts the editor
   * per note (React key), so this is deliberately not a controlled value —
   * the editor owns the text while it is mounted.
   */
  initialContent: string;
  /** Fires with the serialized markdown on every edit. */
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * In-place WYSIWYG markdown editor for the Notes panel: what you type is
 * formatted where you type it — no separate preview pane. Markdown stays the
 * storage format (tiptap-markdown parses it on load and serializes it back on
 * every change), so existing notes and their on-disk format are unchanged.
 *
 * Markdown input rules work live: `# `, `- `, `1. `, `> `, `**bold**`,
 * `` `code` ``, ``` for code blocks, `---` for a rule, etc.
 */
export function NotesEditor({
  initialContent,
  onChange,
  placeholder = "",
  className = "",
}: NotesEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        html: false,
        linkify: true,
        // Serialize soft line breaks as real breaks so plain jotted lines
        // don't collapse into one paragraph on reload.
        breaks: true,
      }),
    ],
    content: initialContent,
    onUpdate: ({ editor }) => {
      onChange((editor.storage.markdown as MarkdownStorage).getMarkdown());
    },
    editorProps: {
      attributes: {
        class: "focus:outline-none",
        "aria-label": "Note content",
      },
    },
  });

  return (
    <EditorContent
      editor={editor}
      className={`notes-editor ${className}`}
      // Clicking the empty area below the last line moves the caret there.
      onClick={() => editor?.chain().focus().run()}
    />
  );
}
