// Live relay for real-time feeds that browsers can't read directly (BC Transit's GTFS-Realtime sends no CORS
// headers). The relay is the small Cloudflare Worker in workers/bct-relay. Until it's deployed RELAY is empty and
// pages fall back to their logged snapshots. For local testing: run `node workers/bct-relay/dev.mjs` and open a page
// with ?relay=http://localhost:8787
export const RELAY = "";

export function relayURL() {
  const q = new URLSearchParams(location.search).get("relay");
  return (q ?? RELAY).replace(/\/+$/, "");
}

/** Poll a relay path every `every` ms while the tab is visible; onData(json) per success. Returns a stop function. */
export function pollRelay(path, onData, { every = 20000, onError } = {}) {
  const base = relayURL();
  if (!base) return null;
  let timer = 0, stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (!document.hidden) {
      try {
        const r = await fetch(base + path, { cache: "no-store" });
        if (!r.ok) throw new Error(`relay ${r.status}`);
        onData(await r.json());
      } catch (e) { onError?.(e); }
    }
    timer = setTimeout(tick, every);
  };
  const vis = () => { if (!document.hidden && !stopped) { clearTimeout(timer); tick(); } };
  document.addEventListener("visibilitychange", vis);
  tick();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); };
}
