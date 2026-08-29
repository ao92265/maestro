import { create } from "zustand";
import {
  isPersistableSnoozeKey,
  parseSnoozeEntries,
  pruneSnoozes,
  removeSnooze,
  type SnoozeEntry,
  type SnoozeKey,
  upsertSnooze,
} from "@/lib/sessionActions";

/**
 * "Not now": hides a decision-queue row until its deadline, so the blocked
 * band shows what the user can actually act on rather than the same three
 * rows they have already decided to leave.
 *
 * Storage follows `useBandStore`'s watermark rather than the zustand persist
 * middleware — one small array, read once at init, written on change. Only
 * durable keys reach disk (see `isPersistableSnoozeKey`); session snoozes are
 * in-memory for the same reason `parkedSessionIds` is.
 */

const STORAGE_KEY = "maestro-snoozes";

/** Reads the persisted array; see `parseSnoozeEntries` for the tolerance rules. */
function loadPersisted(): SnoozeEntry[] {
  try {
    return parseSnoozeEntries(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage itself can throw (disabled storage, private mode).
    return [];
  }
}

function persist(entries: SnoozeEntry[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.filter((e) => isPersistableSnoozeKey(e.key))),
    );
  } catch (err) {
    // A full or unavailable localStorage costs the user the snooze surviving
    // a restart, nothing more — never the action itself.
    console.warn("Failed to persist snoozes:", err);
  }
}

interface SnoozeState {
  entries: SnoozeEntry[];
  /** Hide the row for `hours`. Re-snoozing replaces the existing deadline. */
  snooze: (key: SnoozeKey, hours: number) => void;
  /** Bring the row back now, without waiting for its deadline. */
  unsnooze: (key: SnoozeKey) => void;
  /** Drop expired deadlines. Callers drive the interval. */
  prune: () => void;
}

export const useSnoozeStore = create<SnoozeState>((set, get) => ({
  entries: pruneSnoozes(loadPersisted(), Date.now()),

  snooze: (key, hours) => {
    const entries = upsertSnooze(get().entries, key, Date.now() + hours * 60 * 60 * 1000);
    persist(entries);
    set({ entries });
  },

  unsnooze: (key) => {
    const entries = removeSnooze(get().entries, key);
    persist(entries);
    set({ entries });
  },

  prune: () => {
    const entries = pruneSnoozes(get().entries, Date.now());
    if (entries.length === get().entries.length) return;
    persist(entries);
    set({ entries });
  },
}));
