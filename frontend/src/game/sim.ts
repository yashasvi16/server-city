// Traffic Defense: the game rules, with no rendering, so they can be tested.
//
// Requests travel a road from the internet to your origin servers. You place
// three real pieces of backend infrastructure along it:
//
//   Rate limiter   A token bucket. Drops bot bursts while it has tokens, then
//                  refills at a fixed rate. Normal users are under the limit
//                  and pass untouched, exactly as a per-client limiter would.
//   Cache          Answers cacheable GETs itself. Its hit ratio starts low and
//                  rises as it warms up. Heavy writes are never cacheable, and
//                  bots randomise their URLs, so neither is served from cache.
//   Load balancer  Adds one more server beside the road with a short queue.
//                  It serves whatever reaches it, including bot traffic, which
//                  wastes its capacity unless a limiter dropped it first.
//
// Whatever gets through queues at the origin (two servers, a bounded queue).
// A full queue means the request fails and burns error budget. Run out of
// budget and the run is over.

export type ReqKind = 'get' | 'burst' | 'heavy';
export type TowerKind = 'limiter' | 'cache' | 'lb';

export interface Req {
  id: number;
  kind: ReqKind;
  d: number; // distance travelled along the road, in cells
  speed: number; // cells per second
  state: 'road' | 'queued' | 'serving' | 'gone';
  checked: Set<number>; // caches that have already rolled for this request
}

export interface Server {
  queue: Req[];
  cap: number; // queue capacity
  workers: { req: Req | null; left: number }[];
}

export interface Tower {
  id: number;
  kind: TowerKind;
  c: number;
  r: number;
  range: number;
  tokens: number; // limiter
  warm: number; // cache, 0..1
  hits: number;
  looks: number;
  server: Server | null; // load balancer
  cool: number;
  level: number; // 1..MAX_LEVEL
  spent: number;
}

export const MAX_LEVEL = 3;
/** What each upgrade level buys. */
export const LEVELS = {
  limiter: { capacity: [6, 9, 13], refill: [1.6, 2.6, 3.8] },
  cache: { maxHit: [0.62, 0.72, 0.82] },
  lb: { workers: [1, 2, 3], queue: [2, 3, 4] },
};
export const upgradeCost = (t: Tower) => TOWERS[t.kind].cost * t.level * 2;

export type GameEvent =
  | { t: 'drop'; x: number; y: number }
  | { t: 'hit'; x: number; y: number }
  | { t: 'serve'; x: number; y: number; kind: ReqKind }
  | { t: 'error'; x: number; y: number }
  | { t: 'wave'; wave: number; bonus: number }
  | { t: 'over' }
  | { t: 'won' };

export const COLS = 16;
export const ROWS = 9;

/** Road waypoints in cell coordinates (cell centres are at +0.5). */
export const ROAD: [number, number][] = [
  [-1, 2], [3, 2], [3, 6], [8, 6], [8, 1], [12, 1], [12, 5], [16, 5],
];

export const TOWERS: Record<TowerKind, { name: string; cost: number; upkeep: number; range: number; blurb: string }> = {
  limiter: { name: 'Rate limiter', cost: 40, upkeep: 2, range: 2.3, blurb: 'Token bucket. Drops bot bursts, lets normal users through.' },
  cache: { name: 'Cache', cost: 35, upkeep: 2, range: 1.7, blurb: 'Serves repeat GETs itself. Gets better as it warms up.' },
  lb: { name: 'Load balancer', cost: 60, upkeep: 5, range: 1.6, blurb: 'Adds a server with a short queue. Serves anything, bots included.' },
};

export const LIMITER = { capacity: 6, refillPerSec: 1.6, shotEvery: 0.12 };
export const CACHE = { minHit: 0.12, maxHit: 0.62, warmPerLook: 0.04 };
export const SERVICE: Record<ReqKind, number> = { get: 0.7, burst: 0.45, heavy: 2.0 }; // seconds of server time
const SPEED: Record<ReqKind, number> = { get: 1.7, burst: 2.7, heavy: 0.95 };
const POINTS: Record<ReqKind, { score: number; credits: number }> = {
  get: { score: 10, credits: 1 },
  heavy: { score: 30, credits: 3 },
  burst: { score: 0, credits: 0 }, // serving a bot earns nothing
};
const CACHE_HIT = { score: 15, credits: 2 }; // served fast and cheap

export const START_CREDITS = 70;
export const ERROR_BUDGET = 20;
export const MAX_WAVE = 50; // must match BoardRules in the backend
/** Score per wave is capped so every honest run stays inside the server's plausibility check (2000/wave). */
export const WAVE_SCORE_CAP = 1800;
export const SELL_REFUND = 0.6;

interface Spawn { at: number; kind: ReqKind }

/** The traffic for wave n: steady users, bot bursts from wave 2, heavy writes from wave 3. */
export function waveSchedule(n: number, rand: () => number): Spawn[] {
  const out: Spawn[] = [];
  const span = Math.min(10 + n * 0.35, 24);
  const gets = Math.min(8 + Math.round(3.4 * n + 0.06 * n * n), 400);
  for (let i = 0; i < gets; i++) out.push({ at: (i / gets) * span + rand() * 0.3, kind: 'get' });
  if (n >= 2) {
    const clumps = Math.min(Math.floor((n + 1) / 2), 25);
    const size = Math.min(3 + n, 60);
    for (let k = 0; k < clumps; k++) {
      const t0 = 1.5 + (k / clumps) * span + rand();
      for (let i = 0; i < size; i++) out.push({ at: t0 + i * 0.09, kind: 'burst' });
    }
  }
  if (n >= 3) {
    const heavy = Math.min(Math.round((n - 2) * 1.4 + 0.05 * n * n), 180);
    for (let i = 0; i < heavy; i++) out.push({ at: 1 + (i / heavy) * span + rand() * 0.5, kind: 'heavy' });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Road as a polyline through cell centres, with cumulative lengths. */
function buildRoad() {
  const pts = ROAD.map(([c, r]) => [c + 0.5, r + 0.5] as [number, number]);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const cells = new Set<string>();
  for (let i = 1; i < ROAD.length; i++) {
    const [a, b] = [ROAD[i - 1], ROAD[i]];
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    for (let s = 0; s <= steps; s++) {
      const c = a[0] + Math.sign(b[0] - a[0]) * s, r = a[1] + Math.sign(b[1] - a[1]) * s;
      if (c >= 0 && c < COLS) cells.add(`${c},${r}`);
    }
  }
  return { pts, acc, length: acc[acc.length - 1], cells };
}

export const road = buildRoad();

/**
 * Build pads: the only cells that take a tower. A fixed set of lots beside
 * the road (like rack space in a data centre), so the game is about choosing
 * what goes where, not covering the map.
 */
export const PADS: [number, number][] = [
  [1, 1], [2, 3], [4, 1], [4, 4], [2, 5], [4, 7], [6, 5], [6, 7], [7, 3],
  [9, 3], [9, 5], [10, 0], [10, 2], [7, 0], [11, 3], [13, 0], [13, 2], [11, 6], [13, 4], [14, 6], [15, 4],
];
const PAD_SET = new Set(PADS.map(([c, r]) => `${c},${r}`));

export function roadPoint(d: number): [number, number] {
  const { pts, acc } = road;
  for (let i = 1; i < pts.length; i++) {
    if (d <= acc[i]) {
      const u = (d - acc[i - 1]) / (acc[i] - acc[i - 1]);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    }
  }
  return pts[pts.length - 1];
}

export function cacheHitRatio(t: Tower): number {
  return CACHE.minHit + (LEVELS.cache.maxHit[t.level - 1] - CACHE.minHit) * t.warm;
}

export class Sim {
  credits = START_CREDITS;
  budget = ERROR_BUDGET;
  wave = 0; // last wave started
  score = 0;
  served = 0;
  errors = 0;
  state: 'build' | 'wave' | 'over' | 'won' = 'build';
  time = 0; // simulated seconds
  towers: Tower[] = [];
  reqs: Req[] = [];
  origin: Server = { queue: [], cap: 8, workers: [{ req: null, left: 0 }, { req: null, left: 0 }] };
  events: GameEvent[] = [];
  lastBill = 0;

  private rand: () => number;
  private nextId = 1;
  private schedule: Spawn[] = [];
  private waveClock = 0;
  private waveScore = 0;

  constructor(seed = 1) {
    this.rand = mulberry32(seed);
  }

  /** Why a tower can't go here, or null if it can. */
  canPlace(kind: TowerKind, c: number, r: number): string | null {
    if (this.state === 'over' || this.state === 'won') return 'The run is over.';
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return 'Off the map.';
    if (road.cells.has(`${c},${r}`)) return 'That’s the road.';
    if (!PAD_SET.has(`${c},${r}`)) return 'Build on the marked pads.';
    if (this.towers.some((t) => t.c === c && t.r === r)) return 'Something is already there.';
    if (this.credits < TOWERS[kind].cost) return `Needs ${TOWERS[kind].cost} credits.`;
    return null;
  }

  place(kind: TowerKind, c: number, r: number): Tower | string {
    const why = this.canPlace(kind, c, r);
    if (why) return why;
    this.credits -= TOWERS[kind].cost;
    const t: Tower = {
      id: this.nextId++, kind, c, r, range: TOWERS[kind].range,
      tokens: LIMITER.capacity, warm: 0, hits: 0, looks: 0, cool: 0, level: 1, spent: TOWERS[kind].cost,
      server: kind === 'lb' ? { queue: [], cap: 2, workers: [{ req: null, left: 0 }] } : null,
    };
    this.towers.push(t);
    return t;
  }

  /** Why this tower can't be upgraded, or null if it can. */
  canUpgrade(t: Tower): string | null {
    if (t.level >= MAX_LEVEL) return 'Fully upgraded.';
    if (this.credits < upgradeCost(t)) return `Needs ${upgradeCost(t)} credits.`;
    return null;
  }

  upgrade(id: number): string | null {
    const t = this.towers.find((x) => x.id === id);
    if (!t) return 'No such tower.';
    const why = this.canUpgrade(t);
    if (why) return why;
    const cost = upgradeCost(t);
    this.credits -= cost;
    t.spent += cost;
    t.level++;
    if (t.server) {
      const L = t.level - 1;
      while (t.server.workers.length < LEVELS.lb.workers[L]) t.server.workers.push({ req: null, left: 0 });
      t.server.cap = LEVELS.lb.queue[L];
    }
    return null;
  }

  sell(id: number): number {
    const i = this.towers.findIndex((t) => t.id === id);
    if (i < 0) return 0;
    const t = this.towers[i];
    // Requests waiting at a sold load balancer go back onto the road.
    if (t.server) {
      for (const q of [...t.server.queue, ...t.server.workers.map((w) => w.req).filter((x): x is Req => !!x)]) q.state = 'road';
    }
    const refund = Math.floor(t.spent * SELL_REFUND);
    this.credits += refund;
    this.towers.splice(i, 1);
    return refund;
  }

  /** Running cost of everything placed, charged when a wave starts (your cloud bill). */
  get bill(): number {
    return this.towers.reduce((n, t) => n + TOWERS[t.kind].upkeep * t.level, 0);
  }

  startWave(): boolean {
    if (this.state !== 'build') return false;
    this.lastBill = Math.min(this.credits, this.bill);
    this.credits -= this.lastBill;
    this.wave++;
    this.state = 'wave';
    this.schedule = waveSchedule(this.wave, this.rand);
    this.waveClock = 0;
    this.waveScore = 0;
    return true;
  }

  private addScore(n: number) {
    const room = WAVE_SCORE_CAP - this.waveScore;
    const add = Math.max(0, Math.min(n, room));
    this.waveScore += add;
    this.score += add;
  }

  private finish(q: Req, x: number, y: number, how: 'serve' | 'hit' | 'drop') {
    q.state = 'gone';
    if (how === 'drop') {
      this.events.push({ t: 'drop', x, y });
      return;
    }
    this.served++;
    if (how === 'hit') {
      this.credits += CACHE_HIT.credits;
      this.addScore(CACHE_HIT.score);
      this.events.push({ t: 'hit', x, y });
    } else {
      this.credits += POINTS[q.kind].credits;
      this.addScore(POINTS[q.kind].score);
      this.events.push({ t: 'serve', x, y, kind: q.kind });
    }
  }

  private runServer(s: Server, dt: number, x: number, y: number) {
    for (const w of s.workers) {
      if (!w.req && s.queue.length) {
        w.req = s.queue.shift()!;
        w.req.state = 'serving';
        w.left = SERVICE[w.req.kind];
      }
      if (w.req) {
        w.left -= dt;
        if (w.left <= 0) {
          const q = w.req;
          w.req = null;
          this.finish(q, x, y, 'serve');
        }
      }
    }
  }

  step(dt: number) {
    if (this.state === 'over' || this.state === 'won') return;
    this.time += dt;
    if (this.state === 'wave') {
      this.waveClock += dt;
      while (this.schedule.length && this.schedule[0].at <= this.waveClock) {
        const s = this.schedule.shift()!;
        const speed = SPEED[s.kind] * (1 + Math.min(this.wave, 50) * 0.018);
        this.reqs.push({ id: this.nextId++, kind: s.kind, d: 0, speed, state: 'road', checked: new Set() });
      }
    }

    // Move requests along the road.
    for (const q of this.reqs) if (q.state === 'road') q.d += q.speed * dt;

    // Towers act on requests in range.
    for (const t of this.towers) {
      const tx = t.c + 0.5, ty = t.r + 0.5;
      const inRange = (q: Req) => {
        if (q.state !== 'road') return false;
        const [x, y] = roadPoint(q.d);
        return Math.hypot(x - tx, y - ty) <= t.range;
      };
      if (t.kind === 'limiter') {
        const cap = LEVELS.limiter.capacity[t.level - 1];
        t.tokens = Math.min(cap, t.tokens + LEVELS.limiter.refill[t.level - 1] * dt);
        t.cool -= dt;
        while (t.cool <= 0 && t.tokens >= 1) {
          const target = this.reqs.filter((q) => q.kind === 'burst' && inRange(q)).sort((a, b) => b.d - a.d)[0];
          if (!target) break;
          t.tokens -= 1;
          t.cool += LIMITER.shotEvery;
          const [x, y] = roadPoint(target.d);
          this.finish(target, x, y, 'drop');
        }
        if (t.cool < 0) t.cool = 0;
      } else if (t.kind === 'cache') {
        for (const q of this.reqs) {
          if (q.kind !== 'get' || q.checked.has(t.id) || !inRange(q)) continue;
          q.checked.add(t.id);
          t.looks++;
          if (this.rand() < cacheHitRatio(t)) {
            t.hits++;
            const [x, y] = roadPoint(q.d);
            this.finish(q, x, y, 'hit');
          }
          t.warm = Math.min(1, t.warm + CACHE.warmPerLook);
        }
      } else if (t.server) {
        const s = t.server;
        const busy = s.workers.filter((w) => w.req).length;
        for (const q of this.reqs) {
          if (s.queue.length + busy >= s.cap + s.workers.length) break;
          if (!inRange(q)) continue;
          q.state = 'queued';
          s.queue.push(q);
        }
        this.runServer(s, dt, tx, ty);
      }
    }

    // Arrivals at the origin.
    const [ox, oy] = road.pts[road.pts.length - 1];
    for (const q of this.reqs) {
      if (q.state !== 'road' || q.d < road.length) continue;
      if (this.origin.queue.length >= this.origin.cap) {
        q.state = 'gone';
        this.errors++;
        this.budget -= q.kind === 'heavy' ? 2 : 1;
        this.events.push({ t: 'error', x: ox, y: oy });
      } else {
        q.state = 'queued';
        this.origin.queue.push(q);
      }
    }
    this.runServer(this.origin, dt, ox, oy);
    this.reqs = this.reqs.filter((q) => q.state !== 'gone');

    if (this.budget <= 0) {
      this.budget = 0;
      this.state = 'over';
      this.events.push({ t: 'over' });
      return;
    }
    if (this.state === 'wave' && !this.schedule.length && !this.reqs.length) {
      const bonus = 100 + 20 * this.wave;
      this.addScore(bonus);
      this.credits += 15 + 3 * this.wave;
      this.events.push({ t: 'wave', wave: this.wave, bonus });
      if (this.wave >= MAX_WAVE) {
        this.state = 'won';
        this.events.push({ t: 'won' });
      } else {
        this.state = 'build';
      }
    }
  }

  /** Requests currently waiting or being served at the origin. */
  get originLoad() {
    return this.origin.queue.length + this.origin.workers.filter((w) => w.req).length;
  }

  /** Waves fully cleared (what the leaderboard records). */
  get wavesCleared() {
    return this.state === 'wave' || this.state === 'over' ? Math.max(0, this.wave - 1) : this.wave;
  }
}
