import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON, fmtInt } from "../shared/ui.js";
import { createPlanner } from "../shared/planner.js";
import { edgeCoords, fmtKm, fmtDur, MODES } from "../shared/route.js";
import { skinData } from "./skin.js";

const DATA = "./data/sunday/";
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const TIERS = ["S", "A", "B", "C", "D"];
const TIER_SHARE = [0.05, 0.10, 0.15, 0.20, 0.50];         // share of road length in each tier
const TIER_BLURB = { S: "Worth the trip", A: "Go out of your way", B: "Pleasant", C: "Fine to pass through", D: "Just getting there" };
const FEAT = {
  water: ["Water views", "🌊"], green: ["Parks & forest", "🌲"], farm: ["Farmland", "🌾"], trees: ["Street trees", "🌳"],
  sights: ["Sights & heritage", "🏛️"], stops: ["Places to stop", "🍦"], road: ["Slow & wide road", "🛣️"], flow: ["Few traffic lights", "🚦"],
  curve: ["Gentle curves", "〰️"], infra: ["Bike lanes & paths", "🚲"], quiet: ["Quiet for walking", "🤫"], busy: ["Industrial land (avoid)", "🏭"],
};
const STOP_GROUPS = {
  treats: ["Ice cream & treats", ["ice_cream", "chocolate", "bakery"], "#d6336c"],
  cafe: ["Cafés", ["cafe"], "#9c6644"],
  farm: ["Farm stands", ["farm"], "#5c8a2e"],
  view: ["Viewpoints", ["viewpoint", "lighthouse"], "#1f6feb"],
  beach: ["Beaches & picnics", ["beach", "picnic_site", "pier", "rest_area"], "#0d9488"],
  sights: ["Sights", ["museum", "attraction", "gallery", "historic", "artwork"], "#7c3aed"],
  loo: ["Washrooms", ["toilets"], "#6b7280"],
};
const kindGroup = Object.fromEntries(Object.entries(STOP_GROUPS).flatMap(([g, [, ks]]) => ks.map((k) => [k, g])));

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();
let D, map, planner;
const state = { region: "victoria", mode: "car", weights: {}, stops: new Set(["treats", "view", "beach", "farm"]), G: null, edgeScore: null, roads: null };
const net = { fc: null, tierOf: null };

init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  D = await loadJSON(DATA + "sunday.json");
  state.weights = JSON.parse(JSON.stringify(D.weights));
  const hash = new URLSearchParams(location.hash.slice(1));
  if (D.regions[hash.get("region")]) state.region = hash.get("region");
  document.getElementById("regions").replaceChildren(...Object.entries(D.regions).map(([k, r]) =>
    el("button", { type: "button", "data-k": k, onclick: () => setRegion(k) }, r.name)));
  buildStopChips();
  buildTierLegend();
  initMap();
  planner = createPlanner({
    host: document.getElementById("planner"), map, title: "Trip planner", scoreLabel: "Sunday", defaultScenic: 3,
    graphUrl: (city, mode) => `${DATA}graph_${city}_${mode}.json`,
    scoreFor: (G, mode) => scoreEdges(G, mode),
    stopsFor: (city) => stopsList(city),
    presetsFor: (city, mode) => D.regions[city].routes.filter((r) => r.mode === mode)
      .map((r) => ({ ...r, meta: `${r.km.toFixed(0)} km · ${fmtDur(r.minutes * 60)}` })),
    describe: (r, G) => describeRoute(r, G),
    ignoreClicksOn: ["stops"],
    onGraph: (G, mode) => { state.G = G; state.mode = mode; renderWeights(); rescore(); },
    // "Motor Club" skin: announce the planned route (null when cleared)
    onRoute: (r) => window.dispatchEvent(new CustomEvent("sunday:route", { detail: r ? { metres: r.metres, seconds: r.seconds, score: r.score } : null })),
  });
  document.getElementById("reset-weights").addEventListener("click", () => { state.weights[state.mode] = { ...D.weights[state.mode] }; renderWeights(); rescore(); planner.rescore(); });
  await setRegion(state.region, { initial: true });
  document.getElementById("generated").textContent = `Road network and stops built ${new Date(D.generated).toLocaleDateString("en-CA", { dateStyle: "medium" })}.`;
  window.addEventListener("themechange", () => { map.setStyle(isDark() ? MAP_STYLE.dark : MAP_STYLE.light); });
}

async function setRegion(k, { initial = false } = {}) {
  state.region = k;
  history.replaceState(null, "", `#region=${k}`);
  for (const b of document.querySelectorAll("#regions button")) b.setAttribute("aria-pressed", String(b.dataset.k === k));
  const R = D.regions[k];
  if (!initial) map.flyTo({ center: R.center, zoom: R.zoom + 0.6, duration: 1200 });
  renderRoutes();
  renderWeather();
  drawStops();
  await planner.setCity(k);
}

// ------------------------------------------------------------------ scoring (mirrors score() in pipelines/sunday/build.py)
function scoreEdges(G, mode) {
  const w = state.weights[mode], keys = Object.keys(w).filter((k) => G.feat[k]);
  const pos = d3.sum(keys, (k) => Math.max(0, w[k])) || 1;
  const s = new Float32Array(G.E), tag = G.feat.scenic_tag;
  for (let e = 0; e < G.E; e++) {
    let v = 0;
    for (const k of keys) v += w[k] * G.feat[k][e];
    v = v / 100 / pos + (tag ? 0.15 * tag[e] / 100 : 0);
    s[e] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  if (G === state.G && mode === state.mode) state.edgeScore = s;
  return s;
}
// tier cut-offs by share of road length
function tierCuts(G, s) {
  const idx = Array.from({ length: G.E }, (_, i) => i).sort((a, b) => s[b] - s[a]);
  const total = d3.sum(G.len), cuts = [];
  let acc = 0, t = 0, edge = 0;
  for (const i of idx) {
    acc += G.len[i];
    while (t < 4 && acc > total * d3.sum(TIER_SHARE.slice(0, t + 1))) { cuts.push(s[i]); t++; }
    edge++;
  }
  while (cuts.length < 4) cuts.push(0);
  return cuts;                                             // S if s ≥ cuts[0], A if ≥ cuts[1] …
}
const tierIndex = (v, cuts) => (v >= cuts[0] ? 0 : v >= cuts[1] ? 1 : v >= cuts[2] ? 2 : v >= cuts[3] ? 3 : 4);

function rescore() {
  const G = state.G;
  if (!G) return;
  const s = scoreEdges(G, state.mode);
  net.cuts = tierCuts(G, s);
  drawNetwork();
  renderRoads();
  renderStats();
}

// ------------------------------------------------------------------ map
function initMap() {
  const R = D.regions[state.region];
  map = new maplibregl.Map({ container: "map", style: isDark() ? MAP_STYLE.dark : MAP_STYLE.light, center: R.center, zoom: R.zoom + 0.6,
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  if (import.meta.env.DEV) window.__map = map;
  map.on("style.load", () => { tint(); addLayers(); drawNetwork(); drawStops(); });
  map.on("mousemove", "net", (e) => {
    if (!state.G) return;
    const p = e.features[0].properties;
    map.getCanvas().style.cursor = "pointer";
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(...roadTip(p.e)));
  });
  map.on("mouseleave", "net", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  map.on("mousemove", "stops", (e) => {
    const p = e.features[0].properties, k = D.stop_kinds[p.k];
    map.getCanvas().style.cursor = "pointer";
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, `${k.icon} ${k.label}`), el("b", {}, p.n)));
  });
  map.on("mouseleave", "stops", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
}
function tint() {
  const pal = isDark() ? { bg: "#24262a", water: "#1d2a35", green: "#283126" } : { bg: "#f3f0e8", water: "#cfe0e6", green: "#dfe7d2" };
  for (const l of map.getStyle().layers) {
    const id = l.id.toLowerCase();
    try {
      if (l.type === "background") map.setPaintProperty(l.id, "background-color", pal.bg);
      else if (l.type === "fill" && id.includes("water")) map.setPaintProperty(l.id, "fill-color", pal.water);
      else if (l.type === "fill" && ["park", "wood", "forest", "grass"].some((k) => id.includes(k))) map.setPaintProperty(l.id, "fill-color", pal.green);
    } catch { /* not every layer supports it */ }
  }
  window.dispatchEvent(new CustomEvent("sunday:basemap", { detail: { map } }));
}
const beforeRoute = () => (map.getLayer("plan-route-casing") ? "plan-route-casing" : undefined);
function addLayers() {
  if (map.getSource("net")) return;
  map.addSource("net", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("hl", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const col = ["match", ["get", "t"], ...TIERS.flatMap((t, i) => [i, cssVar(`--tier-${t}`) || "#888"]), "#888"];
  map.addLayer({ id: "net", type: "line", source: "net", layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["-", 5, ["get", "t"]] },
    paint: { "line-color": col,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, ["match", ["get", "t"], 0, 2.6, 1, 1.8, 2, 1, 0.5], 15, ["match", ["get", "t"], 0, 6, 1, 4.5, 2, 3, 3, 2, 1.2]],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, ["match", ["get", "t"], 0, 1, 1, 0.9, 2, 0.55, 3, 0.15, 0], 13, ["match", ["get", "t"], 3, 0.6, 4, 0.35, 1]] } }, beforeRoute());
  map.addLayer({ id: "hl", type: "line", source: "hl", layout: { "line-cap": "round" }, paint: { "line-color": cssVar("--ink"), "line-width": 9, "line-opacity": 0.35 } }, beforeRoute());
  map.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 10.5,
    paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 7],
      "circle-stroke-color": cssVar("--surface") || "#fff", "circle-stroke-width": 1.5 } });
}
function drawNetwork() {
  const G = state.G;
  if (!G || !map.getSource("net")) return;
  if (!net.fc || net.G !== G) {
    net.G = G;
    net.fc = { type: "FeatureCollection", features: Array.from({ length: G.E }, (_, e) => ({ type: "Feature", properties: { e, t: 4 },
      geometry: { type: "LineString", coordinates: edgeCoords(G, e, false) } })) };
  }
  const s = state.edgeScore, cuts = net.cuts;
  for (const f of net.fc.features) f.properties.t = tierIndex(s[f.properties.e], cuts);
  map.getSource("net").setData(net.fc);
}
function stopsList(city) {
  return D.regions[city].stops.filter((s) => state.stops.has(kindGroup[s[2]])).map(([lon, lat, k, n]) => ({ lon, lat, name: n, icon: D.stop_kinds[k].icon, kind: k }));
}
function drawStops() {
  if (!map?.getSource("stops")) return;
  map.getSource("stops").setData({ type: "FeatureCollection", features: D.regions[state.region].stops.filter((s) => state.stops.has(kindGroup[s[2]]))
    .map(([lon, lat, k, n]) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { k, n, c: STOP_GROUPS[kindGroup[k]][2] } })) });
}
function buildStopChips() {
  document.getElementById("stop-chips").replaceChildren(...Object.entries(STOP_GROUPS).map(([g, [label, , c]]) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": String(state.stops.has(g)) }, el("span", { class: "sw", style: { background: c } }), label);
    b.addEventListener("click", () => { state.stops.has(g) ? state.stops.delete(g) : state.stops.add(g); b.setAttribute("aria-pressed", String(state.stops.has(g))); drawStops(); planner?.rescore(); });
    return b;
  }));
}
function buildTierLegend() {
  document.getElementById("tier-legend").replaceChildren(...TIERS.map((t) => el("div", { class: "tl-row" },
    el("i", { style: { background: `var(--tier-${t})` } }), el("b", {}, t), el("span", {}, TIER_BLURB[t]))));
}

function roadTip(e) {
  const G = state.G, s = state.edgeScore[e], w = state.weights[state.mode];
  const name = G.names[G.name[e]] || "Unnamed " + G.classes[G.cls[e]].replace("_", " ");
  const contrib = Object.entries(w).filter(([k]) => G.feat[k]).map(([k, wt]) => ({ k, v: G.feat[k][e], c: wt * G.feat[k][e] }))
    .filter((x) => x.v >= 30).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 4);
  return [el("div", { class: "t-title" }, `${name} · ${TIERS[tierIndex(s, net.cuts)]} tier`),
    tipRow(null, `${Math.round(s * 100)}`, "Sunday score"),
    el("div", { class: "t-title", style: { marginTop: "4px" } }, `${G.speed[e]} km/h · ${G.lanes[e]} lane${G.lanes[e] > 1 ? "s" : ""}`),
    ...contrib.map((x) => tipRow(null, `${x.v}`, `${FEAT[x.k][1]} ${FEAT[x.k][0]}`))];
}

// ------------------------------------------------------------------ weights
function renderWeights() {
  const w = state.weights[state.mode];
  const host = document.getElementById("weights");
  host.replaceChildren(el("div", { class: "w-mode" }, `For ${MODES[state.mode].icon} ${MODES[state.mode].label.toLowerCase()} trips`),
    ...Object.keys(w).map((k) => {
      const neg = w[k] < 0 || k === "busy";
      const inp = el("input", { type: "range", min: "0", max: "5", step: "0.5", value: String(Math.abs(w[k])), "aria-label": FEAT[k][0] });
      const val = el("b", {}, String(Math.abs(w[k])));
      inp.addEventListener("input", () => { val.textContent = inp.value; });
      inp.addEventListener("change", () => { w[k] = (neg ? -1 : 1) * +inp.value; rescore(); planner.rescore(); });
      return el("label", { class: "w-row" }, el("span", { class: "w-name" }, `${FEAT[k][1]} ${FEAT[k][0]}`), inp, val);
    }));
}

// ------------------------------------------------------------------ road tier list
function roadGroups(G) {
  // named roads, split into separate stretches where they don't connect (same-named streets in different towns)
  const parent = new Int32Array(G.E).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byNode = new Map();
  for (let e = 0; e < G.E; e++) {
    if (!G.names[G.name[e]]) continue;
    for (const n of [G.a[e], G.b[e]]) {
      const k = `${n}_${G.name[e]}`;
      if (byNode.has(k)) parent[find(e)] = find(byNode.get(k)); else byNode.set(k, e);
    }
  }
  const groups = new Map();
  for (let e = 0; e < G.E; e++) {
    if (!G.names[G.name[e]]) continue;
    const r = find(e);
    (groups.get(r) || groups.set(r, []).get(r)).push(e);
  }
  return [...groups.values()].map((edges) => ({ edges, name: G.names[G.name[edges[0]]], len: d3.sum(edges, (e) => G.len[e]) }));
}
function renderRoads() {
  const G = state.G, s = state.edgeScore, min = { car: 800, bike: 600, foot: 400 }[state.mode];
  if (!state.roads || state.roads.G !== G) state.roads = { G, list: roadGroups(G) };
  const roads = state.roads.list.filter((r) => r.len >= min).map((r) => {
    const sc = d3.sum(r.edges, (e) => s[e] * G.len[e]) / r.len;
    const f = Object.fromEntries(["water", "green", "trees", "sights", "stops", "farm"].map((k) => [k, d3.sum(r.edges, (e) => G.feat[k][e] * G.len[e]) / r.len]));
    return { ...r, sc, f };
  }).sort((a, b) => b.sc - a.sc);
  const n = roads.length, share = [0.05, 0.15, 0.35, 0.65, 1];
  const tierOfRank = (i) => share.findIndex((x) => i < x * n);
  document.getElementById("roads-title").textContent = `The best roads in ${D.regions[state.region].name} for a ${state.mode === "car" ? "drive" : state.mode === "bike" ? "ride" : "walk"}`;
  document.getElementById("roads-sub").textContent = `${fmtInt.format(n)} named roads and paths at least ${fmtKm(min)} long, ranked by their average score. Click one to see it on the map.`;
  const rows = TIERS.slice(0, 4).map((t, ti) => {
    const items = roads.filter((_, i) => tierOfRank(i) === ti).slice(0, ti === 0 ? 18 : 12);
    return el("div", { class: "tier-row" },
      el("div", { class: `tier-label tier-${t}` }, el("b", {}, t), el("span", {}, TIER_BLURB[t])),
      el("div", { class: "tier-items road-items" }, ...items.map((r) => el("button", { type: "button", class: "road-card", onclick: () => showRoad(r) },
        el("span", { class: "rc-name" }, r.name),
        el("span", { class: "rc-meta" }, `${fmtKm(r.len)} · score ${Math.round(r.sc * 100)}`),
        el("span", { class: "rc-feat" }, ...Object.entries(r.f).filter(([, v]) => v >= 35).sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k]) => el("i", { title: FEAT[k][0] }, FEAT[k][1])))))));
  });
  document.getElementById("road-tiers").replaceChildren(...rows);
}
function showRoad(r) {
  const G = state.G;
  const coords = r.edges.map((e) => edgeCoords(G, e, false));
  map.getSource("hl")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: coords } }] });
  const flat = coords.flat();
  map.fitBounds([[d3.min(flat, (p) => p[0]), d3.min(flat, (p) => p[1])], [d3.max(flat, (p) => p[0]), d3.max(flat, (p) => p[1])]], { padding: 80, maxZoom: 15.5, duration: 900 });
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ------------------------------------------------------------------ routes, stats, weather
function renderRoutes() {
  const R = D.regions[state.region];
  const order = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  document.getElementById("routes").replaceChildren(...["car", "bike", "foot"].flatMap((mode) => {
    const rs = R.routes.filter((r) => r.mode === mode).sort((a, b) => order[a.tier] - order[b.tier] || b.score - a.score);
    if (!rs.length) return [];
    return [el("h3", { class: "routes-mode" }, `${MODES[mode].icon} ${mode === "car" ? "Drives" : mode === "bike" ? "Rides" : "Walks"}`),
      el("div", { class: "routes-grid" }, ...rs.map((r) => el("article", { class: "card route-card" },
        el("div", { class: "rt-top" }, el("span", { class: `pl-tier tier-${r.tier}` }, `${r.tier} tier`), el("span", { class: "rt-score" }, `score ${Math.round(r.score * 100)}`)),
        el("h4", {}, r.name), el("p", {}, r.blurb),
        el("div", { class: "rt-stats" }, el("span", {}, `${r.km.toFixed(1)} km`), el("span", {}, fmtDur(r.minutes * 60)),
          r.water_km >= 0.5 ? el("span", {}, `🌊 ${r.water_km.toFixed(1)} km by the water`) : null,
          r.green_km >= 0.5 ? el("span", {}, `🌲 ${r.green_km.toFixed(1)} km of park & forest`) : null),
        el("button", { type: "button", class: "pl-btn", onclick: () => { planner.loadPreset(r); document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" }); } }, "Show on the map →"))))];
  }));
}
function renderStats() {
  const G = state.G, s = state.edgeScore, R = D.regions[state.region];
  let good = 0;
  for (let e = 0; e < G.E; e++) if (s[e] >= net.cuts[1]) good += G.len[e];
  const ice = R.stops.filter((x) => x[2] === "ice_cream").length;
  const best = R.routes.filter((r) => r.mode === state.mode).sort((a, b) => b.score - a.score)[0];
  const stat = (l, v, sub) => el("div", { class: "card stat" }, el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, sub));
  document.getElementById("stats").replaceChildren(
    stat("S & A-tier roads", fmtKm(good), `the best 15% of the ${MODES[state.mode].label.toLowerCase()} network`),
    stat("Ice-cream stops", fmtInt.format(ice), `plus ${fmtInt.format(R.stops.filter((x) => ["cafe", "bakery"].includes(x[2])).length)} cafés and bakeries`),
    stat("Top ready-made route", best ? best.name : "—", best ? `${best.km.toFixed(0)} km · ${fmtDur(best.minutes * 60)}` : ""));
  skinData({ D, region: state.region, mode: state.mode, good, ice, best }); // "Motor Club" skin: share already-computed figures
}
function describeRoute(r, G) {
  let water = 0, green = 0, trees = 0;
  for (const [e] of r.steps) { if (G.feat.water[e] >= 60) water += G.len[e]; if (G.feat.green[e] >= 50) green += G.len[e]; if (G.feat.trees[e] >= 50) trees += G.len[e]; }
  return [["🌊 By the water", fmtKm(water)], ["🌲 Parks & forest", fmtKm(green)], ["🌳 Tree-lined", fmtKm(trees)]];
}
async function renderWeather() {
  const R = D.regions[state.region], host = document.querySelector("#weather .wx-body");
  try {
    const q = new URLSearchParams({ latitude: R.center[1], longitude: R.center[0], timezone: "auto", forecast_days: "8",
      daily: "temperature_2m_max,precipitation_probability_max,cloud_cover_mean,wind_speed_10m_max,sunset" });
    const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json();
    const i = w.daily.time.findIndex((t) => new Date(t + "T12:00").getDay() === 0);
    const [tmax, pop, cloud, wind, sunset] = ["temperature_2m_max", "precipitation_probability_max", "cloud_cover_mean", "wind_speed_10m_max", "sunset"].map((k) => w.daily[k][i]);
    const verdict = pop >= 60 ? "Rain likely: a café crawl, or the covered Sunday drive." : pop >= 30 ? "Mixed: go early and keep it short."
      : cloud < 40 ? (tmax >= 18 ? "Glorious: head for the water, and the ice cream." : "Crisp and clear: perfect for the coast and the views.") : "Grey but dry: a good day for the forest roads.";
    const day = new Date(w.daily.time[i] + "T12:00").toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
    host.replaceChildren(el("div", { class: "wx-day" }, day), el("div", { class: "wx-temp" }, `${Math.round(tmax)}°`),
      el("div", { class: "wx-line" }, `${pop}% chance of rain · ${Math.round(cloud)}% cloud · wind ${Math.round(wind)} km/h · sunset ${sunset.slice(11, 16)}`),
      el("p", { class: "wx-verdict" }, verdict));
    skinData({ wx: { region: state.region, tmax, pop, date: w.daily.time[i] } }); // "Motor Club" skin: touring bulletin
  } catch { host.textContent = "Forecast unavailable right now."; skinData({ wx: null }); }
}
