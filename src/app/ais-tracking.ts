import type { VesselTarget } from './ais.models';

interface AisTrackingOptions {
  target: () => VesselTarget | null;
  ready: () => boolean;
  track: (current: () => boolean, changed: (ship: VesselTarget) => boolean) => Promise<VesselTarget | null>;
  stopped: (error?: unknown) => void;
}

export function startAisTracking(options: AisTrackingOptions): () => void {
  let active = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let last: VesselTarget | null = null;
  const current = () => active && options.target() !== null;
  const changed = (ship: VesselTarget) => !last || ship.mmsi !== last.mmsi
    || ship.longitude !== last.longitude || ship.latitude !== last.latitude || ship.heading !== last.heading;
  const stop = () => { active = false; clearTimeout(timeout); };
  const finish = (error?: unknown) => { stop(); options.stopped(error); };

  const tick = async () => {
    if (!active) return;
    try {
      const ship = options.target();
      if (!ship) { finish(); return; }
      if (options.ready() && changed(ship)) {
        const sent = await options.track(current, changed);
        if (!active) return;
        if (!sent || !current()) { finish(); return; }
        last = { ...sent };
      }
    } catch (error) { if (active) finish(error); return; }
    // 完成后再计时，只处理最新目标，不累积在途期间的中间位置。
    if (active) timeout = setTimeout(() => { void tick(); }, 1000);
  };
  void tick();
  return stop;
}
