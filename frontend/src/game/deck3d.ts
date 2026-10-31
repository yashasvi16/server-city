// The live 3D layer of Traffic Defense. The deck itself (grass, road, pads,
// gate, data centre, bridge) is baked into the city by Blender; this draws
// what the rules in sim.ts are doing on top of it: towers, traffic, the
// origin's queue lamps, range rings and effects.
import * as THREE from 'three';
import { radialTexture } from '../world/glow';
import { deckToWorld, DECK } from '../world/layout';
import { emissive, solid } from '../world/materials';
import {
  cacheHitRatio, COLS, LEVELS, PADS, road, ROWS, TOWERS, type GameEvent, type ReqKind, type Sim, type Tower, type TowerKind,
} from './sim';

const PAD_TOP = 0.32;
const LANE_Y = 0.72;
const COL = {
  get: new THREE.Color('#5ff2d3'),
  burst: new THREE.Color('#ff4d5e'),
  heavy: new THREE.Color('#ffa63d'),
  limiter: new THREE.Color('#ffa63d'),
  cache: new THREE.Color('#ff5a4f'),
  lb: new THREE.Color('#5ff2d3'),
  bad: new THREE.Color('#ff4d5e'),
  white: new THREE.Color('#fff4e6'),
};
const MAX_REQ = 1400;

/** Continuous game-cell coordinates -> world position on the deck. */
export function cellPos(x: number, y: number, h = 0): THREE.Vector3 {
  const [wx, wz] = deckToWorld(x, y);
  return new THREE.Vector3(wx, h, wz);
}

interface TowerView {
  t: Tower;
  group: THREE.Group;
  level: number;
  spin: THREE.Object3D[];
  tokens: THREE.Mesh[]; // limiter
  tokenOn: THREE.MeshBasicMaterial;
  tokenOff: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial; // accent that brightens with activity
  bays: THREE.MeshBasicMaterial[]; // lb workers
  flash: number;
}

interface Fx { mesh: THREE.Mesh; t: number; dur: number; grow: number; active: boolean }

export class DeckView {
  readonly group = new THREE.Group();
  private towers = new Map<number, TowerView>();
  private inst: Record<ReqKind, THREE.InstancedMesh>;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private cursor: THREE.LineSegments;
  private queueLamps: THREE.MeshBasicMaterial[] = [];
  private racks: THREE.MeshBasicMaterial[] = [];
  private alarm: THREE.Sprite;
  private alarmT = 0;
  private fx: Fx[] = [];
  private fxGeo = new THREE.RingGeometry(0.7, 1, 32).rotateX(-Math.PI / 2);
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -PAD_TOP);

  constructor() {
    // traffic: one instanced mesh per kind
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const im = new THREE.InstancedMesh(geo, mat, MAX_REQ);
      im.count = 0;
      im.frustumCulled = false;
      this.group.add(im);
      return im;
    };
    this.inst = {
      get: mk(new THREE.CapsuleGeometry(0.24, 0.55, 3, 8).rotateZ(Math.PI / 2), emissive(COL.get, 2.2)),
      burst: mk(new THREE.OctahedronGeometry(0.34, 0), emissive(COL.burst, 2.4)),
      heavy: mk(new THREE.BoxGeometry(0.85, 0.65, 0.85), new THREE.MeshLambertMaterial({ color: COL.heavy, emissive: COL.heavy, emissiveIntensity: 0.55 })),
    };

    // range ring + pad cursor
    this.ringMat = new THREE.MeshBasicMaterial({ color: COL.lb, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64).rotateX(-Math.PI / 2), this.ringMat);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.ring.add(disc);
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.group.add(this.ring);
    const sq = new THREE.EdgesGeometry(new THREE.BoxGeometry(2.6, 0.02, 2.6));
    this.cursor = new THREE.LineSegments(sq, new THREE.LineBasicMaterial({ color: COL.heavy.clone().multiplyScalar(2.5), toneMapped: false }));
    this.cursor.visible = false;
    this.group.add(this.cursor);

    // origin: eight queue lamps on the roof sockets, and two server racks by the door
    const [ex, ez] = deckToWorld(road.pts[road.pts.length - 1][0], road.pts[road.pts.length - 1][1]);
    const lampGeo = new THREE.SphereGeometry(0.22, 12, 8);
    for (let k = 0; k < 8; k++) {
      const mat = emissive(COL.white, 0.2);
      const l = new THREE.Mesh(lampGeo, mat);
      l.position.set(ex + 3 - 2.45, 5.38, ez - 3.5 + k * 1.0); // on the data centre roof, facing the road
      this.group.add(l);
      this.queueLamps.push(mat);
    }
    for (let k = 0; k < 2; k++) {
      const mat = emissive(COL.get, 0.6);
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 0.9), mat);
      r.position.set(ex + 0.12, 1.2, ez + (k - 0.5) * 1.15);
      this.group.add(r);
      this.racks.push(mat);
    }
    this.alarm = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(), color: COL.bad, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.alarm.position.set(ex + 3, 3, ez + 2);
    this.alarm.scale.setScalar(12);
    this.group.add(this.alarm);

    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(this.fxGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      mesh.visible = false;
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.fx.push({ mesh, t: 0, dur: 0.5, grow: 1, active: false });
    }
  }

  // ── towers ────────────────────────────────────────────────────────────────
  private build(t: Tower): TowerView {
    const g = new THREE.Group();
    const base = cellPos(t.c + 0.5, t.r + 0.5, PAD_TOP);
    g.position.copy(base);
    const body = solid(new THREE.Color('#2b2f63'));
    const trim = solid(new THREE.Color('#c9c3d9'));
    const col = COL[t.kind];
    const glow = emissive(col, 1.6);
    const v: TowerView = {
      t, group: g, level: 0, spin: [], tokens: [], bays: [], flash: 0, glow,
      tokenOn: emissive(col, 3), tokenOff: emissive(col, 0.18),
    };
    if (t.kind === 'limiter') {
      // a squat hexagonal gate tower with its token bucket shown as lamps
      g.add(mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.35, 6), trim, 0.175));
      g.add(mesh(new THREE.CylinderGeometry(0.72, 0.82, 1.5, 6), body, 0.35 + 0.75));
      g.add(mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.12, 6), glow, 1.2));
      const cap = mesh(new THREE.CylinderGeometry(0.5, 0.74, 0.35, 6), trim, 2.02);
      g.add(cap);
      const beacon = mesh(new THREE.SphereGeometry(0.2, 12, 8), glow, 2.38);
      g.add(beacon);
      // barrier arm that swings when a bot is dropped
      const arm = new THREE.Group();
      arm.add(mesh(new THREE.BoxGeometry(1.5, 0.1, 0.1), emissive(col, 2), 0, 0.75));
      arm.position.set(0, 1.55, 0);
      g.add(arm);
      v.spin.push(arm);
    } else if (t.kind === 'cache') {
      // a Redis-red tank with rings that spin faster as it warms
      g.add(mesh(new THREE.CylinderGeometry(0.95, 1.0, 0.3, 20), trim, 0.15));
      g.add(mesh(new THREE.CylinderGeometry(0.68, 0.72, 1.6, 20), solid(new THREE.Color('#c8423b')), 0.3 + 0.8));
      g.add(mesh(new THREE.SphereGeometry(0.68, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), solid(new THREE.Color('#d9574d')), 1.9));
      for (let i = 0; i < 2; i++) {
        const r = mesh(new THREE.TorusGeometry(0.95 - i * 0.12, 0.05, 6, 36), i ? glow : emissive(COL.heavy, 1.6), 0.9 + i * 0.55);
        r.rotation.x = Math.PI / 2;
        g.add(r);
        v.spin.push(r);
      }
    } else {
      // a server cabinet: one lit bay per worker
      g.add(mesh(new THREE.BoxGeometry(1.9, 0.3, 1.5), trim, 0.15));
      g.add(mesh(new THREE.BoxGeometry(1.6, 1.8, 1.2), body, 0.3 + 0.9));
      g.add(mesh(new THREE.BoxGeometry(1.7, 0.1, 1.3), glow, 2.15));
      const mast = mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.8, 6), trim, 2.6);
      mast.position.x = 0.55;
      g.add(mast);
    }
    // face the road
    const [rx, ry] = nearestRoad(t.c + 0.5, t.r + 0.5);
    const to = cellPos(rx, ry, PAD_TOP);
    g.rotation.y = Math.atan2(to.x - base.x, to.z - base.z);
    this.group.add(g);
    return v;
  }

  /** Rebuild the parts that change with level (bays, token lamps, height). */
  private relevel(v: TowerView) {
    const t = v.t;
    v.level = t.level;
    for (const o of v.group.children.filter((c) => c.userData.lvl)) v.group.remove(o);
    const lvlGroup = new THREE.Group();
    lvlGroup.userData.lvl = true;
    const L = t.level - 1;
    if (t.kind === 'limiter') {
      v.tokens = [];
      const n = LEVELS.limiter.capacity[L];
      const geo = new THREE.SphereGeometry(0.075, 8, 6);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const tk = new THREE.Mesh(geo, v.tokenOff);
        tk.position.set(Math.cos(a) * 0.79, 1.42, Math.sin(a) * 0.79);
        lvlGroup.add(tk);
        v.tokens.push(tk);
      }
    } else if (t.kind === 'lb') {
      v.bays = [];
      const n = LEVELS.lb.workers[L];
      for (let i = 0; i < n; i++) {
        const mat = emissive(COL.lb, 0.3);
        const b = mesh(new THREE.BoxGeometry(1.2, 0.26, 0.04), mat, 0.75 + i * 0.42);
        b.position.z = 0.62;
        lvlGroup.add(b);
        v.bays.push(mat);
      }
    }
    // level pips: small rings at the foot
    for (let i = 0; i < t.level; i++) {
      const pip = mesh(new THREE.TorusGeometry(1.08 + i * 0.13, 0.03, 4, 40), emissive(COL.white, 1.4), 0.04 + i * 0.07);
      pip.rotation.x = Math.PI / 2;
      lvlGroup.add(pip);
    }
    v.group.add(lvlGroup);
    v.group.scale.setScalar(1.15 + L * 0.1);
  }

  // ── per-frame sync ────────────────────────────────────────────────────────
  update(sim: Sim, ui: { selected: Tower | null; build: TowerKind | null; cursor: [number, number] | null; canAfford: boolean }, dt: number, t: number) {
    // towers in / out
    for (const tw of sim.towers) if (!this.towers.has(tw.id)) this.towers.set(tw.id, this.build(tw));
    for (const [id, v] of this.towers) {
      if (!sim.towers.includes(v.t)) {
        this.group.remove(v.group);
        this.towers.delete(id);
        this.spark(v.group.position.clone().setY(0.6), COL.white, 2.2, 0.6);
      }
    }
    for (const v of this.towers.values()) {
      if (v.level !== v.t.level) {
        if (v.level) this.spark(v.group.position.clone().setY(0.6), COL[v.t.kind], 2.4, 0.7);
        this.relevel(v);
      }
      v.flash = Math.max(0, v.flash - dt * 3);
      const tw = v.t;
      if (tw.kind === 'limiter') {
        const tokens = Math.floor(tw.tokens + 1e-6);
        v.tokens.forEach((m, i) => (m.material = i < tokens ? v.tokenOn : v.tokenOff));
        v.glow.color.copy(COL.limiter).multiplyScalar(1.2 + v.flash * 4);
        const arm = v.spin[0];
        arm.rotation.z = THREE.MathUtils.lerp(arm.rotation.z, v.flash > 0.2 ? 1.2 : 0, 1 - Math.exp(-14 * dt));
      } else if (tw.kind === 'cache') {
        const h = cacheHitRatio(tw);
        v.spin.forEach((r, i) => (r.rotation.z += dt * (0.6 + h * 5) * (i ? -1 : 1)));
        v.glow.color.copy(COL.cache).multiplyScalar(0.6 + h * 3 + v.flash * 3);
      } else if (tw.server) {
        tw.server.workers.forEach((w, i) => {
          const m = v.bays[i];
          if (m) m.color.copy(w.req ? COL[w.req.kind] : COL.lb).multiplyScalar(w.req ? 2.6 : 0.25);
        });
        v.glow.color.copy(COL.lb).multiplyScalar(0.8 + Math.min(1, tw.server.queue.length / tw.server.cap) * 2.5);
      }
    }

    // traffic on the road
    const counts: Record<ReqKind, number> = { get: 0, burst: 0, heavy: 0 };
    for (const r of sim.reqs) {
      if (r.state !== 'road') continue;
      const im = this.inst[r.kind];
      const i = counts[r.kind]++;
      if (i >= MAX_REQ) continue;
      const [x, y] = roadXY(r.d);
      const [x2, y2] = roadXY(r.d + 0.05);
      const [wx, wz] = deckToWorld(x, y);
      const [wx2, wz2] = deckToWorld(x2, y2);
      const yaw = Math.atan2(-(wz2 - wz), wx2 - wx);
      const bob = this.reduce ? 0 : Math.sin(t * 6 + r.id) * 0.06;
      this.p.set(wx, LANE_Y + (r.kind === 'heavy' ? -0.05 : bob), wz);
      if (r.kind === 'burst') this.q.setFromEuler(new THREE.Euler(t * 3 + r.id, t * 4, 0));
      else this.q.setFromAxisAngle(this.up, yaw);
      this.m.compose(this.p, this.q, this.s);
      im.setMatrixAt(i, this.m);
    }
    for (const k of Object.keys(this.inst) as ReqKind[]) {
      const im = this.inst[k];
      im.count = Math.min(counts[k], MAX_REQ);
      im.instanceMatrix.needsUpdate = true;
    }

    // origin queue lamps and racks
    const load = sim.origin.queue.length;
    this.queueLamps.forEach((m, i) => {
      const on = i < load;
      const c = load >= sim.origin.cap - 1 ? COL.bad : load >= sim.origin.cap / 2 ? COL.heavy : COL.get;
      m.color.copy(on ? c : COL.white).multiplyScalar(on ? 2.6 : 0.12);
    });
    sim.origin.workers.forEach((w, i) => this.racks[i]?.color.copy(w.req ? COL[w.req.kind] : COL.get).multiplyScalar(w.req ? 2.4 : 0.35));
    this.alarmT = Math.max(0, this.alarmT - dt * 1.6);
    (this.alarm.material as THREE.SpriteMaterial).opacity = this.alarmT * 0.8;

    // range ring: selected tower, or the tower about to be built
    const sel = ui.selected;
    if (sel) {
      this.ring.visible = true;
      this.ring.position.copy(cellPos(sel.c + 0.5, sel.r + 0.5, PAD_TOP + 0.03));
      this.ring.scale.setScalar(sel.range * DECK.cell);
      this.ringMat.color.copy(COL[sel.kind]);
    } else if (ui.build && ui.cursor && isPad(ui.cursor)) {
      this.ring.visible = true;
      this.ring.position.copy(cellPos(ui.cursor[0] + 0.5, ui.cursor[1] + 0.5, PAD_TOP + 0.03));
      this.ring.scale.setScalar(TOWERS[ui.build].range * DECK.cell);
      this.ringMat.color.copy(ui.canAfford ? COL[ui.build] : COL.bad);
    } else {
      this.ring.visible = false;
    }
    if (ui.cursor && isPad(ui.cursor)) {
      this.cursor.visible = true;
      this.cursor.position.copy(cellPos(ui.cursor[0] + 0.5, ui.cursor[1] + 0.5, PAD_TOP + 0.04));
    } else {
      this.cursor.visible = false;
    }

    // effects
    for (const f of this.fx) {
      if (!f.active) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      f.mesh.scale.setScalar(0.3 + k * f.grow);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
    }
  }

  /** Visual reaction to a rule event. */
  event(e: GameEvent) {
    if (e.t === 'drop') {
      const at = cellPos(e.x, e.y, LANE_Y);
      this.spark(at, COL.burst, 1.1, 0.35);
      // the limiter that took the shot raises its arm
      let best: TowerView | null = null, bd = 1e9;
      for (const v of this.towers.values()) {
        if (v.t.kind !== 'limiter') continue;
        const d = Math.hypot(v.t.c + 0.5 - e.x, v.t.r + 0.5 - e.y);
        if (d < bd && d <= v.t.range + 0.2) {
          bd = d;
          best = v;
        }
      }
      if (best) best.flash = 1;
    } else if (e.t === 'hit') {
      this.spark(cellPos(e.x, e.y, LANE_Y), COL.white, 1.3, 0.4);
      for (const v of this.towers.values()) if (v.t.kind === 'cache' && Math.hypot(v.t.c + 0.5 - e.x, v.t.r + 0.5 - e.y) <= v.t.range + 0.2) v.flash = 1;
    } else if (e.t === 'serve' && e.kind !== 'burst') {
      // served beside the road (load balancer) gets a soft puff; the origin's lamps already show its work
      const lb = [...this.towers.values()].find((v) => v.t.kind === 'lb' && Math.abs(v.t.c + 0.5 - e.x) < 0.01 && Math.abs(v.t.r + 0.5 - e.y) < 0.01);
      if (lb) this.spark(lb.group.position.clone().setY(2.3), COL[e.kind], 0.9, 0.35);
    } else if (e.t === 'error') {
      this.alarmT = 1;
      this.spark(cellPos(e.x, e.y, 0.5), COL.bad, 3, 0.55);
    }
  }

  private spark(at: THREE.Vector3, color: THREE.Color, size: number, dur: number) {
    if (this.reduce && dur < 0.5) return;
    const f = this.fx.find((x) => !x.active) ?? this.fx[0];
    f.active = true;
    f.t = 0;
    f.dur = dur;
    f.grow = size;
    f.mesh.visible = true;
    f.mesh.position.copy(at);
    (f.mesh.material as THREE.MeshBasicMaterial).color.copy(color).multiplyScalar(2.2);
  }

  /** Game cell under a ray (on the pad plane), or null off the deck. */
  pick(ray: THREE.Ray): [number, number] | null {
    const hit = ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) return null;
    const c = Math.floor((hit.x - DECK.x) / DECK.cell + DECK.cols / 2);
    const r = Math.floor((hit.z - DECK.z) / DECK.cell + DECK.rows / 2);
    return c >= 0 && r >= 0 && c < COLS && r < ROWS ? [c, r] : null;
  }

  /** Screen-space anchor for a cell (for toasts and focus rings). */
  world(c: number, r: number) {
    return cellPos(c + 0.5, r + 0.5, PAD_TOP);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
  }
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, y: number, x = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, 0);
  return m;
}

const PAD_SET = new Set(PADS.map(([c, r]) => `${c},${r}`));
function isPad([c, r]: [number, number]) {
  return PAD_SET.has(`${c},${r}`);
}

function roadXY(d: number): [number, number] {
  const { pts, acc } = road;
  for (let i = 1; i < pts.length; i++) {
    if (d <= acc[i]) {
      const u = (d - acc[i - 1]) / (acc[i] - acc[i - 1]);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    }
  }
  return pts[pts.length - 1];
}

function nearestRoad(x: number, y: number): [number, number] {
  let best: [number, number] = [x, y], bd = 1e9;
  for (let d = 0; d < road.length; d += 0.25) {
    const p = roadXY(d);
    const dd = Math.hypot(p[0] - x, p[1] - y);
    if (dd < bd) {
      bd = dd;
      best = p;
    }
  }
  return best;
}
