import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Node 21+ defines its own global `localStorage`/`sessionStorage`, which is
// `undefined` unless node runs with --localstorage-file. That existing global
// wins over the storage the happy-dom environment would provide (window IS
// globalThis under vitest, so there is nothing to bridge from), and any suite
// calling `localStorage.clear()` explodes on newer Node (observed on Node 26;
// CI's older Node never defines the global). Install an in-memory Storage
// where the global is missing. No-op where storage already works.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}
for (const key of ["localStorage", "sessionStorage"] as const) {
  if (!globalThis[key]) {
    Object.defineProperty(globalThis, key, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
  ask: vi.fn(),
}));

// Mock @tauri-apps/plugin-clipboard-manager
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
}));

// Mock tauri-plugin-macos-permissions-api
vi.mock("tauri-plugin-macos-permissions-api", () => ({
  checkFullDiskAccessPermission: vi.fn().mockResolvedValue(true),
  requestFullDiskAccessPermission: vi.fn().mockResolvedValue(undefined),
}));
