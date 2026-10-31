// The island map, on a 6-unit grid so Kenney city tiles (scaled ×6) snap to
// it. x = east, z = south (toward the default camera).
// The Blender build (tools/blender/build_city.py) reads this map through
// `npm run export-scene`, so the baked city and the runtime always agree.

export type V2 = readonly [number, number];

export const TILE = 6;
export const ISLAND = { rx: 62, rz: 58 };
export const WORLD_HALF = 60; // must match backend presence.WorldHalf

export const GATE: V2 = [0, 46];
export const MAIN_Z = 18; // Main Street (east-west, south of the station)
export const BACK_Z = -18; // Back Street (north side)
export const AVENUE_X = 0;

export interface Road { a: V2; b: V2 }
/** Road centrelines; every endpoint and bend sits on the tile grid. */
export const ROADS: Road[] = [
  { a: [0, 48], b: [0, 18] }, // avenue: gateway to Main Street
  { a: [-48, MAIN_Z], b: [54, MAIN_Z] }, // Main Street, out to the bridge to the defense deck
  { a: [-42, BACK_Z], b: [42, BACK_Z] }, // Back Street
  { a: [-24, MAIN_Z], b: [-24, BACK_Z] }, // west connector
  { a: [24, MAIN_Z], b: [24, BACK_Z] }, // east connector
];

export interface Spot {
  anchor: V2; // camera focus
  entrance: V2; // where ambient traffic arrives
  rect: [number, number, number, number]; // [minX, minZ, maxX, maxZ] footprint
}

export const SPOTS: Record<string, Spot> = {
  station: { anchor: [0, -1], entrance: [-18, 18], rect: [-21, -15, 21, 15] },
  vault: { anchor: [-39, 0], entrance: [-24, 6], rect: [-51, -15, -27, 15] },
  arena: { anchor: [0, -34], entrance: [0, -18], rect: [-15, -48, 15, -21] },
  poolhall: { anchor: [-31, -30], entrance: [-30, -18], rect: [-41, -38, -21, -23] },
  arcade: { anchor: [31, -30], entrance: [30, -18], rect: [21, -38, 41, -23] },
  guestbook: { anchor: [17, 33], entrance: [6, 30], rect: [9, 24, 27, 42] },
  plaza: { anchor: [-17, 33], entrance: [-6, 30], rect: [-27, 24, -9, 42] },
};

/** Mini-Sidekiq architecture laid out as stations on a rail yard. */
export const STATION_NODES: Record<string, V2> = {
  client: [-18, 12],
  broker: [-8, 12],
  dispatcher: [-8, 2],
  pool: [2, 2],
  middleware: [12, 2],
  handler: [12, -8],
  ack: [2, -8],
  retry: [2, -13],
  scheduler: [-14, -13],
  dlq: [19, -8],
};

/** The live-stats hologram on the west plaza. */
export const BILLBOARD_AT: V2 = [-18, 33];

/** Route from the gateway along real streets to a point near a district. */
export function streetRoute(to: V2): V2[] {
  const pts: V2[] = [GATE, [AVENUE_X, MAIN_Z]];
  if (to[0] !== AVENUE_X) pts.push([to[0], MAIN_Z]);
  pts.push(to);
  return dedupe(pts);
}

/** Manhattan route that avoids passing through unrelated nodes. */
export function nodeRoute(a: V2, b: V2, obstacles: V2[]): V2[] {
  const xFirst: V2[] = [a, [b[0], a[1]], b];
  const zFirst: V2[] = [a, [a[0], b[1]], b];
  const others = obstacles.filter((o) => !same(o, a) && !same(o, b));
  const clips = (path: V2[]) => others.some((o) => pathHits(path, o, 1.2));
  return dedupe(!clips(xFirst) ? xFirst : !clips(zFirst) ? zFirst : xFirst);
}

function same(a: V2, b: V2) {
  return a[0] === b[0] && a[1] === b[1];
}
function dedupe(pts: V2[]): V2[] {
  return pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
}
function pathHits(path: V2[], p: V2, r: number): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    if (p[0] >= Math.min(ax, bx) - r && p[0] <= Math.max(ax, bx) + r && p[1] >= Math.min(az, bz) - r && p[1] <= Math.max(az, bz) + r) return true;
  }
  return false;
}

/** Island outline radius at angle θ (gentle irregularity, deterministic). */
export function islandRadius(theta: number): number {
  return 1 + 0.04 * Math.sin(3 * theta + 0.7) + 0.022 * Math.sin(5 * theta + 2.1) + 0.006 * Math.sin(11 * theta);
}

/** θ measured in the x / -z plane (matches the Blender build). */
export function insideIsland(x: number, z: number, margin = 0): boolean {
  const th = Math.atan2(-z / ISLAND.rz, x / ISLAND.rx);
  const r = Math.hypot(x / ISLAND.rx, z / ISLAND.rz);
  return r < islandRadius(th) - margin / ISLAND.rx;
}

/** All station track hops used by any flow (unique, in first-seen order). */
export function stationHops(flows: { steps: { node: string }[] }[]): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const f of flows) {
    for (let i = 0; i < f.steps.length - 1; i++) {
      const a = f.steps[i].node, b = f.steps[i + 1].node;
      if (a === b || seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * The Traffic Defense deck: a floating platform east of the island where the
 * mini-game is played, joined to the city by a bridge. Game cell (c, r) maps
 * to world (x, z) through deckToWorld. The Blender build reads the same
 * numbers (via export-scene) to model the deck, its road and its pads.
 */
export const DECK = { x: 112, z: 24, cell: 3, cols: 16, rows: 9 };
export function deckToWorld(c: number, r: number): [number, number] {
  return [DECK.x + (c - DECK.cols / 2) * DECK.cell, DECK.z + (r - DECK.rows / 2) * DECK.cell];
}
