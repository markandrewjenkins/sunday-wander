// "Touring Club" skin extras for Sunday Wander: a 1950s–60s touring-club tour book (day) and a dashboard at dusk (night).
// - a TOURING BULLETIN live strip under the header (region, Sunday forecast, S & A km, ice cream, current route odometer)
// - a little touring car that drives along the header rule once on load
// - a club roundel in the hero, dashboard gauges on the stat cards (shown at night), strip-map stubs on route cards
// - rolling odometer digits in the trip planner, a road-map basemap tint (cream by day, dusk by night) and a footer line.
// Everything exists only while data-skin="alt" is on <html> and is removed when it is switched off.
// Uses only figures main.js already computed, handed over through skinData() and the "sunday:route" event.

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const dark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const nf = new Intl.NumberFormat("en-CA");
const MODE = { car: "car", bike: "bike", foot: "foot" };

const S = { D: null, region: null, mode: "car", good: null, ice: null, best: null, wx: null, route: null };
let built = null, drove = false, mapRef = null;

/** main.js pushes figures here: skinData({ D, region, mode, good, ice, best }) and skinData({ wx }). */
export function skinData(patch) {
  if (patch.region && patch.region !== S.region) S.route = null; // the planner clears its route on a region change
  Object.assign(S, patch);
  sync();
}

window.addEventListener("skinchange", sync);
window.addEventListener("sunday:route", (e) => { S.route = e.detail; if (built) { update(); planOdo(); } });
window.addEventListener("sunday:basemap", (e) => { mapRef = e.detail.map; tint(mapRef); });

function sync() {
  if (!on()) { teardown(); return; }
  build();
  update();
}

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const deco = (n) => { n.setAttribute("aria-hidden", "true"); return n; };

// ------------------------------------------------------------------ odometer wheels
// digits become little drums that roll to their figure; anything else is printed between them
function odo(text, cls = "") {
  const w = h("span", `mc-odo ${cls}`);
  for (const ch of String(text)) {
    if (/\d/.test(ch)) {
      const wh = h("span", "mc-wh"), col = h("span", "mc-col"); // the drum's 0–9 strip is CSS-generated
      col.style.setProperty("--d", still() ? ch : "0");
      col.dataset.d = ch;
      wh.append(col);
      w.append(wh);
    } else { const c = h("span", ch === " " ? "mc-sp" : "mc-sep"); c.dataset.c = ch; w.append(c); }
  }
  return w;
}
function roll(scope) {
  if (still()) return;
  const cols = [...scope.querySelectorAll(".mc-col")];
  requestAnimationFrame(() => requestAnimationFrame(() => cols.forEach((c, i) => {
    c.style.transitionDuration = `${700 + (cols.length - i) * 140}ms`;
    c.style.setProperty("--d", c.dataset.d);
  })));
}

// ------------------------------------------------------------------ build / teardown
function build() {
  if (built || !document.querySelector(".topbar")) return;
  const top = document.querySelector(".topbar");

  // live strip: the club's touring bulletin
  const strip = deco(h("div", "mc-strip"));
  strip.innerHTML = `<div class="mc-strip-in">
    <span class="mc-live"><i class="mc-dot"></i>Touring bulletin</span>
    <span class="mc-r"><em>Region</em><b data-k="region">—</b></span>
    <span class="mc-r"><em>Sunday</em><b data-k="wx">—</b></span>
    <span class="mc-r"><em data-k="goodLbl">S &amp; A roads</em><b data-k="good">—</b></span>
    <span class="mc-r"><em>Ice cream</em><b data-k="ice">—</b></span>
    <span class="mc-r mc-trip"><em>Trip meter</em><b data-k="route">—</b></span>
    <span class="mc-r mc-asof"><em>Data as of</em><b data-k="asof">—</b></span>
  </div>`;
  top.after(strip);


  // the club roundel in the hero
  const badge = deco(h("div", "mc-badge"));
  badge.innerHTML = roundel();
  document.querySelector(".hero .wrap")?.prepend(badge);

  // footer flavour
  const flav = deco(h("p", "mc-flavour", "Pacific Touring Club · Keep right, pass left, and always stop for ice cream."));
  document.querySelector("footer.site .wrap")?.append(flav);

  // re-decorate whatever main.js / the planner re-render
  const obs = new MutationObserver(() => { gauges(); stubs(); planCheck(); });
  for (const id of ["stats", "routes"]) { const n = document.getElementById(id); if (n) obs.observe(n, { childList: true }); }
  const res = document.querySelector(".pl-result");
  if (res) obs.observe(res, { childList: true });

  built = { strip, car: null, badge, flav, obs };
  if (mapRef) tint(mapRef);
}

function teardown() {
  if (!built) return;
  built.obs.disconnect();
  for (const k of ["strip", "car", "badge", "flav"]) built[k]?.remove();
  document.querySelectorAll(".mc-gauge, .mc-stub, .mc-tour").forEach((n) => n.remove());
  document.querySelectorAll("[data-mc]").forEach((n) => delete n.dataset.mc);
  document.querySelectorAll(".mc-sr").forEach((n) => n.classList.remove("mc-sr"));
  document.querySelectorAll(".mc-g").forEach((n) => n.classList.remove("mc-g"));
  document.querySelectorAll(".pl-stats b[data-mc-text]").forEach((b) => { b.textContent = b.dataset.mcText; delete b.dataset.mcText; });
  built = null;
}

// ------------------------------------------------------------------ live readouts
function update() {
  if (!built) return;
  if (S.D && !drove) drive();
  const set = (k, v) => built.strip.querySelectorAll(`[data-k="${k}"]`).forEach((n) => { if (typeof v === "string") n.textContent = v; else n.replaceChildren(v); });
  const { D, region } = S;
  if (D && region) {
    const R = D.regions[region];
    set("region", R.name.replace(/^Greater /, "").toUpperCase());
    set("goodLbl", `S & A roads · ${MODE[S.mode] || ""}`);
    if (S.good != null) set("good", `${nf.format(Math.round(S.good / 1000))} km`);
    if (S.ice != null) set("ice", nf.format(S.ice));
    const g = new Date(D.generated);
    set("asof", g.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }).replace(".", "").toUpperCase());
    built.badge.querySelector(".mc-badge-region").textContent = R.name.replace(/^Greater /, "").toUpperCase();
  }
  if (S.wx && S.wx.region === region) set("wx", `${Math.round(S.wx.tmax)}° · ${S.wx.pop}% rain`);
  else if (S.wx === null) set("wx", "no forecast");
  const r = S.route, tripEl = built.strip.querySelector('[data-k="route"]');
  if (r) {
    const key = `${Math.round(r.metres / 100)}_${Math.round(r.seconds / 60)}`;
    if (tripEl.dataset.key !== key) {
      tripEl.dataset.key = key;
      const km = (r.metres / 1000).toFixed(1).padStart(5, "0");
      const box = h("span", "mc-tripv");
      box.append(odo(km, "mc-odo-s"), h("span", "mc-unit", "km"), h("span", "mc-mins", ` · ${dur(r.seconds)}`));
      tripEl.replaceChildren(box);
      roll(tripEl);
    }
  } else { tripEl.dataset.key = ""; tripEl.textContent = "plan a trip ↓"; }
  gauges(); stubs(); planOdo();
}
// a touring car that drives the header rule once, when the figures first arrive
function drive() {
  drove = true;
  if (still()) return;
  const car = deco(h("div", "mc-car"));
  car.innerHTML = CAR;
  document.querySelector(".topbar").append(car);
  car.addEventListener("animationend", (e) => { if (e.target === car) car.remove(); });
  built.car = car;
}
const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };

// ------------------------------------------------------------------ dashboard gauges on the stat cards (visible at night)
const niceMax = (m) => (m <= 10 ? 10 : m <= 100 ? Math.ceil(m / 10) * 10 : Math.ceil(m / 50) * 50);
const P = (f, r) => { const a = Math.PI * (1 - f); return [100 + r * Math.cos(a), 100 - r * Math.sin(a)]; };
const fx = (v) => v.toFixed(1);
function dial({ id, ticks, labels = [], zone, arc, needle, ring }) {
  let t = "";
  for (let i = 0; i <= ticks; i++) {
    const f = i / ticks, major = i % 2 === 0, [x1, y1] = P(f, 82), [x2, y2] = P(f, major ? 70 : 75);
    t += `<line class="g-tick${major ? " maj" : ""}" x1="${fx(x1)}" y1="${fx(y1)}" x2="${fx(x2)}" y2="${fx(y2)}"/>`;
  }
  const lab = labels.map(([f, s]) => { const [x, y] = P(f, 58); return `<text class="g-lbl" x="${fx(x)}" y="${fx(y + 4)}" text-anchor="middle">${s}</text>`; }).join("");
  const band = (f0, f1, cls, r = 86) => { const [a, b] = P(f0, r), [c, d] = P(f1, r); return `<path class="${cls}" d="M${fx(a)} ${fx(b)} A${r} ${r} 0 0 1 ${fx(c)} ${fx(d)}"/>`; };
  const ringText = ring ? `<defs><path id="${id}-rp" d="M42 100 A58 58 0 0 1 158 100"/></defs><text class="g-ring"><textPath href="#${id}-rp" startOffset="50%" text-anchor="middle">${ring}</textPath></text>` : "";
  const nd = needle == null ? "" : `<g class="g-needle" style="--a:${(Math.min(1, Math.max(0, needle)) * 180).toFixed(1)}deg"><path d="M100 97 L28 100 L100 103 Z"/></g><circle class="g-hub" cx="100" cy="100" r="7"/><circle class="g-hub-in" cx="100" cy="100" r="2.5"/>`;
  return `<svg viewBox="0 0 200 112" class="g-svg">
    <defs><linearGradient id="${id}-chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="g-c1"/><stop offset=".5" class="g-c2"/><stop offset="1" class="g-c3"/></linearGradient></defs>
    <path class="g-bezel" d="M6 104 A94 94 0 0 1 194 104" stroke="url(#${id}-chrome)"/>
    <path class="g-face" d="M12 104 A88 88 0 0 1 188 104 Z"/>
    ${zone ? band(zone[0], zone[1], "g-zone") : ""}${arc != null && arc > 0 ? band(0, Math.min(1, arc), "g-arc", 86) : ""}
    ${t}${lab}${ringText}${nd}</svg>`;
}
function gauges() {
  if (!built || !S.D) return;
  const cards = [...document.querySelectorAll("#stats .stat")];
  if (cards.length !== 3 || cards[0].dataset.mc) return;
  cards.forEach((c) => { c.dataset.mc = "1"; });
  const [c1, c2, c3] = cards;
  // 1 · odometer: kilometres of S & A road for this mode
  const g1 = deco(h("div", "mc-gauge g-odo"));
  g1.innerHTML = dial({ id: "mcg1", ticks: 16, ring: "SUNDAY-GRADE" });
  const km = String(Math.round((S.good || 0) / 100)).padStart(5, "0");
  const win = h("div", "g-window");
  win.append(odo(km.slice(0, -1)), odo(km.slice(-1), "g-tenth"), h("span", "g-unit", "km"));
  g1.append(win);
  // 2 · "fuel" gauge: ice-cream stops on a scale up to the better-stocked region
  const iceAll = Object.values(S.D.regions).map((R) => R.stops.filter((x) => x[2] === "ice_cream").length);
  const mx = niceMax(Math.max(...iceAll, S.ice || 0));
  const g2 = deco(h("div", "mc-gauge g-fuel"));
  g2.innerHTML = dial({ id: "mcg2", ticks: 8, labels: [[0, "0"], [0.5, nf.format(mx / 2)], [1, nf.format(mx)]], zone: [0, 0.125], needle: (S.ice || 0) / mx });
  g2.append(Object.assign(h("div", "g-read"), { innerHTML: `${CONE}<b>${nf.format(S.ice || 0)}</b>` }));
  // 3 · trip clock: minutes for the top ready-made route, 0–120
  const mins = S.best ? S.best.minutes : 0;
  const g3 = deco(h("div", "mc-gauge g-clock"));
  g3.innerHTML = dial({ id: "mcg3", ticks: 8, labels: [[0, "0"], [0.25, "30"], [0.5, "60"], [0.75, "90"], [1, "120"]], arc: mins / 120, needle: mins / 120 });
  g3.append(Object.assign(h("div", "g-read"), { innerHTML: `<b>${S.best ? dur(mins * 60) : "—"}</b>` }));
  c1.querySelector(".label").after(g1);
  c2.querySelector(".label").after(g2);
  c3.querySelector(".label").after(g3);
  c1.classList.add("mc-g"); c2.classList.add("mc-g"); c3.classList.add("mc-g");
  roll(g1);
}

// ------------------------------------------------------------------ route cards: strip-map pages with a mileage stub
function stubs() {
  if (!built) return;
  let n = 0;
  document.querySelectorAll("#routes .routes-grid").forEach((grid) => {
    const mode = grid.previousElementSibling?.textContent.match(/Drives|Rides|Walks/)?.[0] || "";
    grid.querySelectorAll(".route-card").forEach((card) => {
      n++;
      if (card.dataset.mc) return;
      card.dataset.mc = "1";
      const [kmEl, tEl] = card.querySelectorAll(".rt-stats > span");
      const km = (kmEl?.textContent || "").replace(/\s*km$/, ""), t = tEl?.textContent || "";
      const tm = t.match(/^(\d+)\s*min$/), th = t.match(/^(\d+)\s*h\s*(\d+)?/);
      const stub = deco(h("div", "mc-stub"));
      stub.innerHTML = `<span class="mc-stub-no">No.&nbsp;${String(n).padStart(2, "0")}</span>
        <span class="mc-stub-v"><b>${km}</b><small>km</small></span>
        <span class="mc-stub-v"><b>${tm ? tm[1] : th ? `${th[1]}:${(th[2] || "0").padStart(2, "0")}` : t}</b><small>${tm ? "min" : "h:mm"}</small></span>
        <span class="mc-stub-mode">${{ Drives: "Drive", Rides: "Ride", Walks: "Walk" }[mode] || ""}</span>`;
      const tour = deco(h("div", "mc-tour", "P.M.T.C. · Strip map"));
      kmEl?.classList.add("mc-sr"); tEl?.classList.add("mc-sr");
      card.prepend(tour);
      card.append(stub);
    });
  });
}

// ------------------------------------------------------------------ trip planner: odometer read-out
function planCheck() {
  // the planner empties its result without an event when a route can no longer be drawn
  if (!document.querySelector(".pl-result .pl-stats") && S.route) { S.route = null; update(); }
  planOdo();
}
function planOdo() {
  if (!built) return;
  const bs = [...document.querySelectorAll(".pl-stats b")];
  if (!bs.length || bs[0].dataset.mcText) return;
  for (const b of bs) {
    const txt = b.textContent;
    b.dataset.mcText = txt;
    const sr = h("span", "mc-sr", txt);
    b.replaceChildren(sr, deco(odo(txt.replace(/\s+/g, " "))));
  }
  roll(bs[0].closest(".pl-stats"));
}

// ------------------------------------------------------------------ artwork
const CAR = `<svg viewBox="0 0 76 30" class="mc-car-svg">
  <path class="car-beam" d="M70 17 L76 13 L76 23 Z"/>
  <path class="car-body" d="M3 21 C2 17 5 15.5 10 15 L21 14 C25 7 30 5.5 37 5.5 L45 5.5 C51 5.5 55 9 58 14 L67 15 C72 15.6 73 18 72.5 21 Z"/>
  <path class="car-glass" d="M24 14 C27 9 31 7.5 36 7.5 L39 7.5 L39 14 Z M41.5 7.5 L45 7.5 C49 7.5 52 10 54.5 14 L41.5 14 Z"/>
  <path class="car-trim" d="M8 18 L66 18"/>
  <circle class="car-lamp" cx="70.5" cy="17" r="1.6"/>
  <g class="car-wheel" style="transform-origin:19px 22px"><circle cx="19" cy="22" r="5.6"/><circle class="hub" cx="19" cy="22" r="2.4"/><path class="spoke" d="M19 17 V27 M14 22 H24"/></g>
  <g class="car-wheel" style="transform-origin:57px 22px"><circle cx="57" cy="22" r="5.6"/><circle class="hub" cx="57" cy="22" r="2.4"/><path class="spoke" d="M57 17 V27 M52 22 H62"/></g>
</svg>`;
const CONE = `<svg viewBox="0 0 20 28" class="g-cone"><circle cx="10" cy="8" r="6.5" class="scoop"/><path d="M3.8 11 L10 27 L16.2 11 Z" class="cone"/><path d="M5.5 14 L13 21 M14.5 14 L7 21" class="waffle"/></svg>`;
function roundel() {
  return `<svg viewBox="0 0 160 160" class="mc-badge-svg">
    <defs><path id="mc-rt" d="M80 80 m-56 0 a56 56 0 1 1 112 0"/><path id="mc-rb" d="M80 80 m-61 0 a61 61 0 1 0 122 0"/></defs>
    <circle cx="80" cy="80" r="77" class="b-out"/><circle cx="80" cy="80" r="71" class="b-ring"/><circle cx="80" cy="80" r="46" class="b-in"/>
    <text class="b-rt"><textPath href="#mc-rt" startOffset="50%" text-anchor="middle">PACIFIC TOURING CLUB</textPath></text>
    <text class="b-rb"><textPath href="#mc-rb" startOffset="50%" text-anchor="middle">★ WEST COAST EDITION ★</textPath></text>
    <text x="80" y="70" text-anchor="middle" class="b-t1">TOUR BOOK</text>
    <text x="80" y="92" text-anchor="middle" class="b-t2">SUNDAY</text>
    <text x="80" y="108" text-anchor="middle" class="b-t3 mc-badge-region">—</text>
  </svg>`;
}

// ------------------------------------------------------------------ basemap: cream road map (day), dusk (night)
const TINT = {
  day: { bg: "#f1e6c8", water: "#a9c9d6", green: "#d3dcaa", resi: "#ecdfbf", bldg: "#e4d3ae", road: "#fdf8ea", minor: "#f7efda", casing: "#d4c096", rail: "#bfa77c", label: "#5b4630", halo: "#f6eed8" },
  night: { bg: "#0f1422", water: "#09111f", green: "#131d1c", resi: "#121828", bldg: "#18203a", road: "#262f47", minor: "#1c2438", casing: "#2c3651", rail: "#252e45", label: "#a7b0c4", halo: "#0f1422" },
};
const DATA_LAYERS = new Set(["net", "hl", "stops", "plan-route", "plan-route-casing"]);
function tint(map) {
  if (!on() || !map?.getStyle) return; // Classic: main.js's own tint() has just run on the fresh style
  const P = dark() ? TINT.night : TINT.day;
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
      set(id, "text-color", P.label); set(id, "text-halo-color", P.halo);
    }
  }
  // the planner adds its route layers after this event: give the route a headlight glow at night
  setTimeout(() => {
    if (!on() || !map.getLayer("plan-route-casing")) return;
    const night = dark();
    set("plan-route-casing", "line-color", night ? "#ffe066" : "#fffaf0");
    set("plan-route-casing", "line-opacity", night ? 0.32 : 0.9);
    set("plan-route-casing", "line-blur", night ? 5 : 0);
    set("plan-route-casing", "line-width", ["interpolate", ["linear"], ["zoom"], 10, night ? 12 : 6, 16, night ? 22 : 12]);
  }, 0);
}

// start: covers the skin already being on at page load (skinData() also syncs once data arrives)
if (on()) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync); else sync(); }
