import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Health of the other systems on this machine: the ecosystem's declared
 * listeners, and the launchd jobs worth noticing when they stop.
 *
 * A reading that cannot be confirmed is dropped rather than kept. Every
 * dashboard before this one failed the same way: it rendered a system that
 * was not running, and looked identical to one that worked.
 */

export interface ServiceTile {
  name: string;
  port: number;
  up: boolean;
  detail: string;
}

export interface JobRow {
  label: string;
  reason: string | null;
}

export interface EcosystemHealth {
  services: ServiceTile[];
  jobs: { healthy: number; total: number; failing: JobRow[] };
}

type Store = {
  health: EcosystemHealth | null;
  refresh: () => Promise<void>;
};

export const useEcosystemStore = create<Store>((set) => ({
  health: null,

  refresh: async () => {
    try {
      set({ health: await invoke<EcosystemHealth>("ecosystem_health") });
    } catch {
      set({ health: null });
    }
  },
}));
