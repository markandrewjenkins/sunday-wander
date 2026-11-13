// "Road Atlas" skin for Sunday Wander (data-skin="alt"): the basemap tint. The rest of the skin is CSS (skin.css).
// A nature atlas: paper-tone land, vegetation in soft greens, sea and lakes in clear blues, pale roads and brown labels;
// the night edition keeps the same reading in deep green-greys and navy water. The planned route gets a white casing by
// day and a dark one at night so it stays clear of both parks and water.
// main.js re-runs its own tint() on every style load (theme or skin change) and then fires "sunday:basemap".

const PAL = {
  day: { bg: "#f2eee2", water: "#a8cde2", green: "#cde0b8", resi: "#ece7d9", bldg: "#e3dccb", road: "#fffdf6", minor: "#f8f4e8", casing: "#cfc3a6", rail: "#aaa18a", label: "#4a4234", water_label: "#2d6585", halo: "#f6f2e6", routeCase: "#ffffff" },
  night: { bg: "#1a1e1c", water: "#123049", green: "#22382a", resi: "#1e2220", bldg: "#262b28", road: "#353b38", minor: "#2a302d", casing: "#3c433f", rail: "#3c433f", label: "#b7b9a8", water_label: "#7fb3d3", halo: "#1a1e1c", routeCase: "#0d100e" },
};

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const dark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const DATA_LAYERS = new Set(["net", "hl", "stops", "plan-route", "plan-route-casing"]);

window.addEventListener("sunday:basemap", (e) => tint(e.detail.map));

function tint(map) {
  if (!on() || !map?.getStyle) return; // Classic: main.js's own tint() has just run on the fresh style
  const P = dark() ? PAL.night : PAL.day;
  const set = (id, prop, v) => { try { map.setPaintProperty(id, prop, v); } catch { /* absent in this style */ } };
  for (const l of map.getStyle()?.layers || []) {
    const id = l.id;
    if (DATA_LAYERS.has(id)) continue;
    if (l.type === "background") set(id, "background-color", P.bg);
    else if (l.type === "fill") {
      if (/water/.test(id)) set(id, "fill-color", P.water);
      else if (/park|wood|grass|glacier|ice/.test(id)) set(id, "fill-color", P.green);
      else if (/building/.test(id)) { set(id, "fill-color", P.bldg); set(id, "fill-outline-color", P.casing); }
      else if (/landuse|pier|aeroway/.test(id)) set(id, "fill-color", P.resi);
    } else if (l.type === "line") {
      if (/waterway/.test(id)) set(id, "line-color", P.water);
      else if (/boundary/.test(id)) set(id, "line-color", P.casing);
      else if (/casing/.test(id)) set(id, "line-color", P.casing);
      else if (/rail/.test(id)) set(id, "line-color", /dash/.test(id) ? P.bg : P.rail);
      else if (/minor|path|pier|subtle|taxiway/.test(id)) set(id, "line-color", P.minor);
      else if (/highway|road|runway/.test(id)) set(id, "line-color", P.road);
    } else if (l.type === "symbol" && l.layout?.["text-field"]) {
      set(id, "text-color", /water/.test(id) ? P.water_label : P.label); set(id, "text-halo-color", P.halo);
    }
  }
  // the planner adds its route layers after this event
  setTimeout(() => {
    if (!on() || !map.getLayer("plan-route-casing")) return;
    set("plan-route-casing", "line-color", P.routeCase);
    set("plan-route-casing", "line-opacity", 0.95);
    set("plan-route-casing", "line-width", ["interpolate", ["linear"], ["zoom"], 10, 8, 16, 14]);
    set("plan-route", "line-width", ["interpolate", ["linear"], ["zoom"], 10, 3.5, 16, 7]);
  }, 0);
}
