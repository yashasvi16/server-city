// Talks to the Go backend: polls /api/stats and keeps a presence WebSocket.
// If the backend can't be reached, switches to demo mode: simulated "ghost"
// visitors and no stats, clearly labelled as such. It keeps probing in the
// background and switches to live mode if the backend appears.

export interface Peer {
  id: string;
  name: string;
  hue: number;
  x: number;
  z: number;
  ghost?: boolean;
}

export interface Stats {
  requestsServed: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  uptimeSec: number;
  visitorsOnline: number;
  version: string;
}

export type Mode = 'connecting' | 'live' | 'demo';

export interface BackendEvents {
  mode(m: Mode): void;
  stats(s: Stats | null): void;
  upsert(p: Peer): void;
  remove(id: string): void;
  self(id: string | null): void;
  /** A new guestbook entry from any visitor (live mode only). */
  guestbook?(e: { id: string; name: string; message: string; at: string }): void;
  /** Someone set a new best on a leaderboard (live mode only). */
  leaderboard?(board: string): void;
  /** True while a configured backend is probably cold-starting (free hosts
   *  sleep when idle); false once it is live or we give up waiting. */
  waking?(on: boolean): void;
}

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

function wsURL(): string {
  const base = API_BASE || location.origin;
  return base.replace(/^http/, 'ws') + '/ws';
}

async function fetchJSON<T>(path: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API_BASE + path, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) throw new Error('not JSON');
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export function isStaticHost(): boolean {
  if (API_BASE) return false; // an explicit backend URL was configured
  const h = location.hostname;
  return location.protocol === 'file:' || h.endsWith('claude.ai') || h.endsWith('claudeusercontent.com');
}

/** Checks for a live backend: up to `attempts` tries with a 4s timeout each.
 *  Resolves to null (never rejects) when the backend is unreachable. */
export async function probeBackend(attempts = 2): Promise<Stats | null> {
  if (isStaticHost()) return null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJSON<Stats>('/api/stats', 4000);
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null;
}

export class Backend {
  mode: Mode = 'connecting';
  private ws: WebSocket | null = null;
  private wsAttempts = 0;
  private statsTimer = 0;
  private probeTimer = 0;
  private ghosts: GhostSim | null = null;
  private lastSent = { x: NaN, z: NaN, at: 0 };
  private peers = new Set<string>();

  constructor(private ev: BackendEvents) {}

  /** `firstProbe` lets main.ts start probing before three.js has loaded. */
  async start(firstProbe?: Promise<Stats | null>): Promise<void> {
    if (isStaticHost()) {
      // Artifact/file hosting has no backend; don't wait for a timeout.
      this.enterDemo();
      return;
    }
    const s = await (firstProbe ?? probeBackend());
    if (s) this.enterLive(s);
    else this.enterDemo();
  }

  /** Tell others where this visitor is looking (throttled to ~4 Hz). */
  sendPosition(x: number, z: number): void {
    const now = performance.now();
    if (now - this.lastSent.at < 250) return;
    if (Math.abs(x - this.lastSent.x) < 0.5 && Math.abs(z - this.lastSent.z) < 0.5) return;
    this.lastSent = { x, z, at: now };
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'move', x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 }));
    }
  }

  private setMode(m: Mode) {
    if (this.mode === m) return;
    this.mode = m;
    this.ev.mode(m);
  }

  private wakeTimer = 0;

  private enterLive(first: Stats) {
    clearTimeout(this.wakeTimer);
    this.ev.waking?.(false);
    this.ghosts?.stop();
    this.ghosts = null;
    clearTimeout(this.probeTimer);
    clearInterval(this.statsTimer);
    this.clearPeers();
    this.setMode('live');
    this.ev.stats(first);
    const poll = async () => {
      if (document.hidden) return;
      try {
        this.ev.stats(await fetchJSON<Stats>('/api/stats', 4000));
      } catch {
        this.ev.stats(null); // show "unavailable", keep trying
      }
    };
    this.statsTimer = window.setInterval(poll, 5000);
    this.connectWS();
  }

  private enterDemo() {
    this.setMode('demo');
    this.ev.stats(null);
    this.ev.self(null);
    this.ghosts = new GhostSim(this.ev);
    this.ghosts.start();
    if (isStaticHost()) return;
    // A separately hosted backend (API_BASE) may be asleep on a free plan and
    // take about a minute to start; say so instead of just "demo".
    if (API_BASE) {
      this.ev.waking?.(true);
      this.wakeTimer = window.setTimeout(() => this.ev.waking?.(false), 120000);
    }
    // Keep checking with backoff (5s, 10s, 20s, then every 30s): a backend
    // that is cold-starting (e.g. a sleeping Fly machine) takes over when up.
    let delay = API_BASE ? 4000 : 5000;
    const retry = async () => {
      const st = await probeBackend(1);
      if (st) return this.enterLive(st);
      delay = API_BASE && delay < 8000 ? delay : Math.min(30000, delay * 2); // poll briskly while it wakes
      this.probeTimer = window.setTimeout(retry, delay);
    };
    this.probeTimer = window.setTimeout(retry, delay);
  }

  private clearPeers() {
    for (const id of this.peers) this.ev.remove(id);
    this.peers.clear();
  }

  private connectWS() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsURL());
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsAttempts = 0;
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = () => {
      this.ws = null;
      this.ev.self(null);
      this.clearPeers();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    // Exponential backoff with full jitter, capped at 30s.
    const cap = Math.min(30000, 1000 * 2 ** this.wsAttempts++);
    setTimeout(() => this.connectWS(), Math.random() * cap);
  }

  private onMessage(raw: unknown) {
    if (typeof raw !== 'string') return;
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const toPeer = (p: any): Peer => ({ id: p.id, name: p.n, hue: p.h, x: p.x, z: p.z });
    const upsert = (p: Peer) => {
      this.peers.add(p.id);
      this.ev.upsert(p);
    };
    switch (m.t) {
      case 'welcome':
        this.ev.self(m.you.id);
        for (const p of m.peers ?? []) upsert(toPeer(p));
        break;
      case 'snap': {
        const seen = new Set<string>();
        for (const p of m.peers ?? []) {
          seen.add(p.id);
          upsert(toPeer(p));
        }
        for (const id of [...this.peers]) {
          if (!seen.has(id)) {
            this.peers.delete(id);
            this.ev.remove(id);
          }
        }
        break;
      }
      case 'gb':
        if (m.e && typeof m.e.message === 'string') this.ev.guestbook?.(m.e);
        break;
      case 'lb':
        if (typeof m.board === 'string') this.ev.leaderboard?.(m.board);
        break;
      case 'tick':
        for (const p of m.j ?? []) upsert(toPeer(p));
        for (const [id, x, z] of m.m ?? []) this.ev.upsert({ id, x, z } as Peer);
        for (const [id, n] of Object.entries(m.u ?? {})) this.ev.upsert({ id, name: n } as Peer);
        for (const id of m.l ?? []) {
          this.peers.delete(id);
          this.ev.remove(id);
        }
        break;
    }
  }
}

// Wanders a few clearly-labelled ghosts between district entrances so the
// published demo still shows what presence looks like.
const SPOTS: [number, number][] = [
  [0, 44], [0, 30], [0, 18], [-14, 18], [14, 18], [-30, 18], [30, 18], [0, -14], [-24, 2], [24, 2], [-20, -20], [20, -20], [8, 30],
];
class GhostSim {
  private timer = 0;
  private ghosts: (Peer & { tx: number; tz: number; wait: number })[] = [];
  constructor(private ev: BackendEvents) {}
  start() {
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const [x, z] = SPOTS[Math.floor(Math.random() * SPOTS.length)];
      const g = { id: `ghost-${i}`, name: `ghost ${i + 1}`, hue: (i * 67 + 200) % 360, x, z, tx: x, tz: z, wait: Math.random() * 3, ghost: true };
      this.ghosts.push(g);
      this.ev.upsert(g);
    }
    let last = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      for (const g of this.ghosts) {
        const dx = g.tx - g.x, dz = g.tz - g.z, d = Math.hypot(dx, dz);
        if (d < 0.5) {
          if ((g.wait -= dt) <= 0) {
            [g.tx, g.tz] = SPOTS[Math.floor(Math.random() * SPOTS.length)];
            g.wait = 2 + Math.random() * 5;
          }
          continue;
        }
        const step = Math.min(d, 4 * dt);
        g.x += (dx / d) * step;
        g.z += (dz / d) * step;
        this.ev.upsert({ id: g.id, x: g.x, z: g.z } as Peer);
      }
    }, 100);
  }
  stop() {
    clearInterval(this.timer);
    for (const g of this.ghosts) this.ev.remove(g.id);
    this.ghosts = [];
  }
}
