// Writes tools/blender/scene.json: the island map, landmark footprints and
// every station track (as polylines) for the Blender build. Run with
// `npm run export-scene`. The runtime imports the same layout, so the baked
// city and the trains/packets can never drift apart.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { site } from '../src/config/site.config';
import * as L from '../src/world/layout';
import { PADS, ROAD } from '../src/game/sim';

const station = site.projects.find((p) => p.district.kind === 'station');
const nodes = Object.values(L.STATION_NODES);
const tracks = station?.flows
  ? L.stationHops(station.flows).map(([a, b]) => ({ from: a, to: b, points: L.nodeRoute(L.STATION_NODES[a], L.STATION_NODES[b], nodes) }))
  : [];

const out = {
  tile: L.TILE,
  island: L.ISLAND,
  gate: L.GATE,
  roads: L.ROADS,
  spots: L.SPOTS,
  stationNodes: L.STATION_NODES,
  billboard: L.BILLBOARD_AT,
  tracks,
  spur: [[L.STATION_NODES.client[0], L.MAIN_Z], L.STATION_NODES.client],
  deck: {
    ...L.DECK,
    // in world (x, z), through cell centres
    road: ROAD.map(([c, r]) => L.deckToWorld(c + 0.5, r + 0.5)),
    pads: PADS.map(([c, r]) => L.deckToWorld(c + 0.5, r + 0.5)),
  },
};
const file = resolve(import.meta.dirname, '../../tools/blender/scene.json');
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file}: ${tracks.length} station tracks`);
