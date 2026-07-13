/**
 * Deterministic per-project accent color.
 *
 * The color is derived purely from the project name, so the same project
 * always gets the same color — across sessions, restarts and machines.
 * Used by the eagle view to color-code terminal tiles by project.
 */

/**
 * Maps a project name to a stable HSL color.
 *
 * Hash → hue; saturation/lightness are fixed to values that read well as
 * borders and bold text on the dark theme.
 */
export function projectColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue} 70% 55%)`;
}

/** Last path segment of a project path, for display fallbacks. */
export function projectBaseName(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base || normalized;
}
