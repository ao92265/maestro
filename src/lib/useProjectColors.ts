import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { resolveProjectColors } from "@/lib/projectColor";

/**
 * Clash-resolved accent colors for all open projects.
 *
 * Subscribes to the open tab names and returns the shared
 * name → color map from {@link resolveProjectColors}, so every surface
 * (project tabs, eagle tiles, sidebar, zoom tab bar) shows the same color for
 * a project even after a clash between two names has been resolved.
 */
export function useProjectColors(): Map<string, string> {
  const names = useWorkspaceStore(useShallow((s) => s.tabs.map((t) => t.name)));
  return useMemo(() => resolveProjectColors(names), [names]);
}
