import { useCallback, useEffect, useRef, useState } from "react";
import {
  listDevProcesses,
  listDockerContainers,
  type DevProcess,
  type DockerContainer,
} from "@/lib/processes";

const POLL_INTERVAL_MS = 3_000;
/** While docker is unavailable, only re-probe it this often — a stopped
 * Docker Desktop makes `docker ps` slow to fail, no point hammering it. */
const DOCKER_RETRY_MS = 30_000;

/**
 * Polls the watchlist-filtered process scan (and `docker ps`) every 3 seconds.
 *
 * - Polls only while `enabled` (section expanded) and the window is focused —
 *   enumerating every OS process is heavier than the global metrics call.
 * - `processes` is `null` until the first successful fetch.
 * - Overlapping polls are skipped rather than queued.
 */
export function useDevProcesses(enabled: boolean, watchlist: string[]) {
  const [processes, setProcesses] = useState<DevProcess[] | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dockerBackoffUntil = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const procs = await listDevProcesses(watchlist);
      setProcesses(procs);
      setError(null);

      if (Date.now() >= dockerBackoffUntil.current) {
        const ps = await listDockerContainers();
        setDockerAvailable(ps.available);
        setContainers(ps.available ? ps.containers : []);
        if (!ps.available) dockerBackoffUntil.current = Date.now() + DOCKER_RETRY_MS;
      }
    } catch (err) {
      setError(String(err));
    } finally {
      inFlight.current = false;
    }
  }, [watchlist]);

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      // Skip when the window is in the background — nobody's looking.
      if (!document.hasFocus()) return;
      void refresh();
    };

    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  return { processes, containers, dockerAvailable, error, refresh };
}
