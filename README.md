# Sunday Wander

Every road rated for a relaxed outing by car, bike or on foot, with a trip planner and loop builder. Region: Greater Victoria, Greater Vancouver.

**Live dashboard: https://markandrewjenkins.github.io/sunday-wander/**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

- **Network:** Every road and path from OpenStreetMap, read from BBBike's weekly city extracts (Overpass is the fallback). Ways are split at intersections, and access and one-way rules are worked out separately for cars, bikes and walking (`pipelines/common/roadgraph.py`).
- **Ingredients per road segment (0–100):**
  - water views: line of sight over the Copernicus GLO-30 surface model (buildings and trees block it) to the sea, or to lakes and rivers over 2 ha, in 24 directions up to 2 km; "next to the water" is a separate, smaller ingredient, and ponds and wetlands don't count;
  - parks and forest within ~60 m, and farmland within ~100 m;
  - street trees from the city inventories;
  - sights: viewpoints, heritage places, lighthouses, and Wikidata landmarks with a heritage designation or a Wikipedia article;
  - stops: ice cream, cafés, bakeries, farm stands, picnic sites, beaches, washrooms;
  - "slow and wide": posted speed and lanes, where 50 km/h on two lanes is best; winding local roads through forest count as narrow;
  - traffic signals and stop signs per km, and gentle curves (sinuosity);
  - cycling infrastructure for bikes, and quiet streets for walking;
  - industrial land counts against.
- **Score and tiers:** a weighted mix that viewers can re-weight live. Tiers are by share of road length: S is the top 5%, then A 10%, B 15%, C 20% and D the rest. There is no ground truth for "a nice drive", so this is a transparent recipe, not a trained model.
- **Routing (in the browser):** A* and Dijkstra over the network. Each second on a road costs extra in proportion to how low that road ranks, and the Direct ↔ Scenic slider sets how much. The loop builder routes start → two high-ranked stretches → start, trying the pairs whose triangle fits the target time. Routes export as GPX or a Google Maps link.
- **Ready-made routes:** editorial picks of local classics, routed and rated with the same recipe (`pipelines/sunday/routes.py`).

The same planner (`site/src/shared/planner.js`, `route.js`) appears in **Cherry Blossom Watch** and **Fall Foliage Watch**. There, every street tree is attached to its nearest road segment, so a route is scored by the selected trees forecast to be in bloom (or in colour) on the chosen date. Their ready-made routes are data-driven: the streets whose best ~600 m is most densely lined with S- and A-tier trees, grouped by neighbourhood (`pipelines/common/treetrips.py`).

All data is published under open licences (OGL-Canada, OGL-Vancouver, OGL-Victoria, OGL-Toronto; NASA data is public domain). iNaturalist observations remain © their observers.

## Design

The page has a Classic design and a themed alternative, **Road Atlas** (printed nature atlas: paper land, green parks, blue sea; quiet serif type and hairline rules), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.sunday.fetch missing
.venv/Scripts/python -m pipelines.sunday.build
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
