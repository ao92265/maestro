import { useEffect, useMemo, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import type { SessionSlot } from "@/components/terminal/PreLaunchCard";

interface UseTerminalDragDropOptions {
  slots: SessionSlot[];
  onDrop: (sessionId: number, paths: string[], slotId: string) => void;
  /**
   * Whether this grid is the active project tab. `MultiProjectView` keeps
   * every project's grid mounted (ZStack pattern), so each grid registers
   * its own window-level listener — only the active one may handle events,
   * otherwise drops land in whichever project mounted first.
   */
  enabled: boolean;
}

interface UseTerminalDragDropResult {
  /** Which pane slot is being hovered during a file drag */
  dropTargetSlotId: string | null;
  /** Whether an external file drag is active over the window */
  isDraggingFiles: boolean;
}

/**
 * Window-level drag-drop handler for files dragged from Finder/Explorer
 * onto terminal panes.
 *
 * Uses Tauri's native `onDragDropEvent` which provides physical coordinates
 * and file paths. Hit-tests against `[data-slot-id]` DOM elements to
 * determine which pane the files are being dragged over.
 */
export function useTerminalDragDrop({
  slots,
  onDrop,
  enabled,
}: UseTerminalDragDropOptions): UseTerminalDragDropResult {
  const [dropTargetSlotId, setDropTargetSlotId] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  // Build a lookup from slotId → sessionId for quick access
  const slotSessionMap = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const slot of slots) {
      map.set(slot.id, slot.sessionId);
    }
    return map;
  }, [slots]);

  useEffect(() => {
    if (!enabled) {
      // Clear any stale highlight if the tab is switched mid-drag.
      setDropTargetSlotId(null);
      setIsDraggingFiles(false);
      return;
    }

    const appWindow = getCurrentWindow();

    /**
     * Geometry of every visible slot, captured once per drag. `over` fires on
     * every pointer tick while files hover the window, and both
     * `getComputedStyle` and `getBoundingClientRect` force a synchronous
     * style-recalc + layout flush — per element, document-wide, and once per
     * mounted grid (every project's grid registers this hook in eagle view).
     * Nothing re-lays-out mid-drag (the drop overlay is an absolute overlay
     * inside the pane), so one snapshot on `enter` serves the whole drag.
     * Null means "not captured yet".
     */
    let slotRects:
      | { slotId: string; left: number; top: number; right: number; bottom: number }[]
      | null = null;

    /**
     * Skips invisible elements two ways, because hidden grids hide two ways:
     * - inactive project stacks are `display:none` (see MultiProjectView), so
     *   their slots report an all-zero rect — a zero-area box must never win a
     *   hit test, hence the width/height check;
     * - eagle-obscured tiles are `visibility:hidden` (see TerminalGrid) and DO
     *   report a full-size rect at the same coordinates, hence the style check.
     */
    function snapshotSlots() {
      const rects: NonNullable<typeof slotRects> = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-slot-id]")) {
        const slotId = el.dataset.slotId;
        if (!slotId) continue;
        if (getComputedStyle(el).visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        rects.push({
          slotId,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
      }
      return rects;
    }

    /**
     * Hit-test physical coordinates against the snapshot.
     * Tauri provides PhysicalPosition — divide by devicePixelRatio to get CSS pixels.
     */
    function findSlotAtPosition(physX: number, physY: number): string | null {
      // `enter` normally seeds the snapshot; fall back in case a drag starts
      // with an `over`/`drop` (e.g. the tab was switched mid-drag).
      const rects = slotRects ?? (slotRects = snapshotSlots());
      const scale = window.devicePixelRatio || 1;
      const cssX = physX / scale;
      const cssY = physY / scale;

      for (const r of rects) {
        if (cssX >= r.left && cssX <= r.right && cssY >= r.top && cssY <= r.bottom) {
          return r.slotId;
        }
      }
      return null;
    }

    const unlisten = appWindow.onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        // Re-measure once per drag, on the way in.
        if (event.payload.type === "enter") slotRects = snapshotSlots();
        setIsDraggingFiles(true);
        const pos = event.payload.position;
        const slotId = findSlotAtPosition(pos.x, pos.y);
        // Only highlight slots that have a launched session
        if (slotId && slotSessionMap.get(slotId) !== null) {
          setDropTargetSlotId(slotId);
        } else {
          setDropTargetSlotId(null);
        }
      } else if (event.payload.type === "drop") {
        const pos = event.payload.position;
        const slotId = findSlotAtPosition(pos.x, pos.y);
        if (slotId) {
          const sessionId = slotSessionMap.get(slotId);
          if (sessionId !== null && sessionId !== undefined) {
            onDrop(sessionId, event.payload.paths, slotId);
          }
        }
        slotRects = null;
        setDropTargetSlotId(null);
        setIsDraggingFiles(false);
      } else if (event.payload.type === "leave") {
        slotRects = null;
        setDropTargetSlotId(null);
        setIsDraggingFiles(false);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [slotSessionMap, onDrop, enabled]);

  return { dropTargetSlotId, isDraggingFiles };
}
