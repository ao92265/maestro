import { useEffect } from "react";
import { useTourStore } from "@/stores/useTourStore";

/** Right-side utility panels reachable via Cmd/Ctrl+3, 4, 6. */
export type UtilityPanelShortcut = "memory" | "processes" | "notes" | "ai";

/** Cmd/Ctrl+digit → right-side utility panel (2 is the git panel, handled
 *  separately). 5/Notes is cut from nav — the gap is deliberate. */
const UTILITY_PANEL_BY_DIGIT: Record<string, UtilityPanelShortcut> = {
  "3": "memory",
  "4": "processes",
  "6": "ai",
};

interface UseAppKeyboardOptions {
  /** Callback to add a new terminal (Cmd/Ctrl+T) — context-aware (grid/zoom/eagle) */
  onAddSession: () => void;
  /** Whether adding a session is currently allowed */
  canAddSession: boolean;
  /** Alt+1-3: toggle the left sidebar on tab N (1-based tab index) */
  onSidebarTab?: (index: number) => void;
  /** Callback to toggle the git panel (Cmd/Ctrl+2) */
  onToggleGitPanel?: () => void;
  /** Cmd/Ctrl+3, 4, 6: toggle a right-side utility panel */
  onToggleUtilityPanel?: (panel: UtilityPanelShortcut) => void;
  /** Callback to toggle the eagle all-projects terminals view (Cmd/Ctrl+G) */
  onToggleEagleView?: () => void;
  /** Callback to toggle the landscape agent graph (Cmd/Ctrl+Shift+G) */
  onToggleLandscapeView?: () => void;
  /** Callback to toggle the Home decision queue (Cmd/Ctrl+1) */
  onToggleHomeView?: () => void;
  /** Callback to toggle the Factory ACT lane (Cmd/Ctrl+7) */
  onToggleFactoryView?: () => void;
  /** Ctrl+Tab (all platforms): switch to the next project tab */
  onNextProject?: () => void;
  /** Ctrl+Shift+Tab (all platforms): switch to the previous project tab */
  onPrevProject?: () => void;
}

/**
 * Detect whether the current platform uses Cmd (Mac) or Ctrl (Windows/Linux) as the modifier key.
 */
function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

/**
 * App-level keyboard shortcut handler.
 *
 * Shortcuts:
 * - Alt+1-3: Toggle the left sidebar on tab N (General/History/Settings)
 * - Cmd/Ctrl+1: Toggle the Home decision queue
 * - Cmd/Ctrl+2: Toggle the git panel
 * - Cmd/Ctrl+7: Toggle the Factory (ACT lane)
 * - Cmd/Ctrl+3, 4, 6: Toggle the Memory/Processes/AI panels (5/Notes cut from nav)
 * - Cmd/Ctrl+T: Add a new terminal (project picker in eagle view)
 * - Cmd/Ctrl+G: Toggle the eagle all-projects terminals view
 * - Cmd/Ctrl+Shift+G: Toggle the landscape agent graph
 * - Ctrl+Tab / Ctrl+Shift+Tab (all platforms): Next / previous project tab
 */
export function useAppKeyboard({
  onAddSession,
  canAddSession,
  onSidebarTab,
  onToggleGitPanel,
  onToggleUtilityPanel,
  onToggleEagleView,
  onToggleLandscapeView,
  onToggleHomeView,
  onToggleFactoryView,
  onNextProject,
  onPrevProject,
}: UseAppKeyboardOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // The first-run tour quotes these shortcuts on its cards; firing them
      // behind its modal would rearrange the app under a dialog the user
      // cannot see past. Its own Escape handler still works.
      if (useTourStore.getState().isOpen) return;

      // Alt-based shortcuts (no Cmd/Ctrl, no Shift)
      // Use event.code so the bindings are layout-independent (AZERTY etc.).
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        // Alt+1-3: toggle the left sidebar on the given tab. Top-row digits
        // only — Alt+numpad digits must stay free for Windows Alt-code entry
        // (e.g. Alt+164 → ñ typed into a terminal).
        const sidebarDigit = /^Digit([1-3])$/.exec(event.code);
        if (sidebarDigit && onSidebarTab) {
          event.preventDefault();
          event.stopImmediatePropagation();
          onSidebarTab(Number(sidebarDigit[1]));
        }
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle project tabs. Ctrl on EVERY platform
      // (browser/VS Code convention) — macOS reserves Cmd+Tab for the system
      // app switcher, so a Cmd binding could never fire there.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) {
          onPrevProject?.();
        } else {
          onNextProject?.();
        }
        return;
      }

      const modifierKey = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifierKey) return;

      // Cmd/Ctrl+Shift+G: toggle the landscape graph — the "everything at once"
      // sibling of Cmd/Ctrl+G, so it is checked before Shift is filtered out.
      if (event.shiftKey && !event.altKey && event.code === "KeyG" && onToggleLandscapeView) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleLandscapeView();
        return;
      }

      // Don't interfere with other modifier combinations
      if (event.altKey || event.shiftKey) return;

      // Cmd/Ctrl+1: toggle the Home decision queue — digit 1 because Home is
      // the first thing in the day, and 2-6 are already panels.
      if ((event.code === "Digit1" || event.code === "Numpad1") && onToggleHomeView) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleHomeView();
        return;
      }

      // Cmd/Ctrl+7: toggle the Factory (ACT lane) — next free digit after the
      // 2-6 panel block.
      if ((event.code === "Digit7" || event.code === "Numpad7") && onToggleFactoryView) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleFactoryView();
        return;
      }

      // Cmd/Ctrl+2: toggle the git panel.
      // Use event.code so this still triggers on layouts where Ctrl+2 produces a non-"2" event.key.
      if ((event.code === "Digit2" || event.code === "Numpad2") && onToggleGitPanel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleGitPanel();
        return;
      }

      // Cmd/Ctrl+3, 4, 6: toggle the right-side utility panels. 5/Notes is
      // cut from nav, so the digit gap is deliberate — not matched here.
      const utilityDigit = /^(?:Digit|Numpad)([346])$/.exec(event.code);
      if (utilityDigit && onToggleUtilityPanel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleUtilityPanel(UTILITY_PANEL_BY_DIGIT[utilityDigit[1]]);
        return;
      }

      if (event.code === "KeyT") {
        // Always prevent default to block WebView's new-tab behavior
        event.preventDefault();
        if (canAddSession) {
          onAddSession();
        }
        return;
      }

      // Cmd/Ctrl+G: toggle the eagle all-projects terminals view.
      if (event.code === "KeyG" && onToggleEagleView) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleEagleView();
      }
    }

    // Register in the capture phase so the App-level shortcuts (especially Cmd/Ctrl+2
    // which competes with browser tab-switching defaults) win against any descendant
    // bubble-phase listener — including xterm's textarea and other modal handlers.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    onAddSession,
    canAddSession,
    onSidebarTab,
    onToggleGitPanel,
    onToggleUtilityPanel,
    onToggleEagleView,
    onToggleLandscapeView,
    onToggleHomeView,
    onToggleFactoryView,
    onNextProject,
    onPrevProject,
  ]);
}
