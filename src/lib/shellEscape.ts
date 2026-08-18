/**
 * Shell-escape file paths for safe pasting into a terminal.
 *
 * Uses POSIX single-quote wrapping: any internal single quotes are escaped
 * as `'\''` (end quote, escaped quote, reopen quote).
 */

import { isWindows } from "@/lib/platform";

export function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

/**
 * Which quoting rules a command line typed into a session PTY must follow.
 * The backend spawns `COMSPEC` (cmd.exe) on Windows and `$SHELL` everywhere
 * else (`process_manager::spawn_shell`), so this is the only split that
 * matters — there is no PowerShell PTY to quote for.
 */
export type ShellFamily = "posix" | "cmd";

/** The family of the shell this machine's session PTYs actually run. */
export function currentShellFamily(): ShellFamily {
  return isWindows() ? "cmd" : "posix";
}

/**
 * Control characters are refused outright, on both families: the quoted
 * argument is TYPED into a live PTY, and a CR or LF inside it submits the
 * line half-written — the exact failure #137 was fixed to stop.
 *
 * Scanned rather than matched with a regex: the lint that bans control
 * characters inside a pattern is right everywhere else, and a range test
 * reads as what this actually means.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * cmd.exe has no escape for these, so a payload carrying one cannot ride a
 * launch line at all (issue #158):
 * - `"` closes the quoted region mid-argument, exposing every metacharacter
 *   after it (`^` cannot escape it back — cmd resolves quotes first).
 * - `%` is expanded (`%VAR%`) BEFORE quote processing, and `%%` collapses
 *   only inside a batch file, never at an interactive prompt.
 * - `!` is expanded the same way whenever the user has delayed expansion on
 *   (`cmd /V:ON`, or the `DelayedExpansion` registry value).
 * Everything else cmd treats as special — `&`, `|`, `<`, `>`, `^`, `(`, `)` —
 * is inert inside double quotes, so wrapping is enough for those.
 */
const CMD_UNESCAPABLE = /["%!]/;

/**
 * Quotes `value` as ONE positional argument for `shell`, or returns `null`
 * when it cannot be quoted safely.
 *
 * Refusing is a first-class outcome (issue #158): the caller falls back to
 * the delivery route it already had rather than emitting a half-escaped
 * command line. A partially escaped line is not a cosmetic defect — the
 * payload this exists for, `samurai_brief::pointer_instruction`, wraps the
 * brief path in BACKTICKS, and a backtick inside double quotes is command
 * substitution in bash/zsh: the shell would try to EXECUTE the brief path.
 */
export function quoteShellArgument(value: string, shell: ShellFamily): string | null {
  if (value.length === 0) return null;
  if (hasControlCharacter(value)) return null;
  return shell === "cmd" ? quoteForCmd(value) : quoteForPosix(value);
}

/**
 * POSIX single-quote wrapping: inside single quotes NOTHING is special —
 * backtick, `$`, `\` and every metacharacter are literal — and an internal
 * single quote is spliced back in with the `'\''` idiom.
 */
function quoteForPosix(value: string): string {
  return shellEscapePath(value);
}

/**
 * cmd.exe double-quote wrapping. Two parsers see this string: cmd.exe, for
 * which quotes neutralize the metacharacters above, and the launched
 * program's own `CommandLineToArgvW`-style argv split, for which a backslash
 * RUN immediately before the closing quote escapes that quote (`"C:\wt\"`
 * would swallow it). Interior backslashes matter only in front of a quote,
 * and quotes are refused, so doubling the trailing run is the whole fix.
 */
function quoteForCmd(value: string): string | null {
  if (CMD_UNESCAPABLE.test(value)) return null;
  const trailingBackslashes = /\\*$/.exec(value)?.[0].length ?? 0;
  return `"${value}${"\\".repeat(trailingBackslashes)}"`;
}
