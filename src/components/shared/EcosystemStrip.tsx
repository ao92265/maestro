import { Boxes } from "lucide-react";
import { useEffect, useState } from "react";
import { useEcosystemStore } from "@/stores/useEcosystemStore";

/**
 * How the rest of the machine is doing, next to the CPU and quota readouts
 * that are already always on screen.
 *
 * A chip rather than a row of tiles, because the bottom bar has no room for
 * seven of anything and a surface he has to open is one he will not. The
 * detail is one click away and written in words: "Not running", never a
 * truncated socket error, which is the mistake that made the previous health
 * strips useless at a glance.
 */

const REFRESH_MS = 30 * 1000;

export function EcosystemStrip() {
  const { health, refresh } = useEcosystemStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // No reading is not the same as everything being fine, so it renders as
  // nothing rather than as a healthy count.
  if (!health) return null;

  const up = health.services.filter((service) => service.up).length;
  const total = health.services.length;
  const trouble = up < total || health.jobs.failing.length > 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-label="Systems"
        className="flex items-center gap-1.5 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text"
      >
        <Boxes size={11} className={trouble ? "text-maestro-yellow" : "text-maestro-green"} />
        <span className={trouble ? "text-maestro-yellow" : undefined}>
          {up}/{total}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-6 right-0 z-50 w-60 rounded-lg border border-maestro-border bg-maestro-card p-2 shadow-lg">
          <div className="flex flex-col gap-1">
            {health.services.map((service) => (
              <div key={service.name} className="flex items-center gap-2 text-[11px]">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    service.up ? "bg-maestro-green" : "bg-maestro-muted"
                  }`}
                />
                <span className="flex-1 truncate text-maestro-text">{service.name}</span>
                <span className="text-maestro-muted">{service.detail}</span>
              </div>
            ))}
          </div>

          <div className="my-1.5 h-px bg-maestro-border/40" />

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[11px] text-maestro-muted">
              <span className="flex-1">Background jobs</span>
              <span>
                {health.jobs.healthy}/{health.jobs.total}
              </span>
            </div>
            {health.jobs.failing.map((job) => (
              <div key={job.label} className="flex items-center gap-2 text-[11px]">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-maestro-yellow" />
                <span className="flex-1 truncate text-maestro-text">{job.label}</span>
                <span className="text-maestro-muted">{job.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
