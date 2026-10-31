// Raging Bull: the endless runner, staged on the Arcade roof as a rolling
// world. A grassy drum turns under the bull, so the road, trees, bears,
// red-candle walls and coins come over the far horizon toward him, like the
// classic "rolling log" runner shot. The bull plays himself: he reads the
// lane ahead, switches lanes around walls, jumps bears and goes for coins.
// The arcade building is baked (build_arcade); everything here is live.
import * as THREE from 'three';
import type { Project } from '../../config/types';
import { Halos, radialTexture } from '../glow';
import type { Label, Landmark } from '../landmark';
import { SPOTS } from '../layout';
import { emissive, solid } from '../materials';
import { P } from '../palette';
import { hitBox, textSign, v3 } from '../util';

const ROOF = 0.36 + 4.7; // top of the baked cornice
const R = 2.7; // drum radius
const LEN = 4.4; // drum length (across the lanes)
const LANE = 0.78;
const SPEED = 0.55; // drum angular speed, rad/s

type ThingKind = 'bear' | 'wall' | 'coin' | 'tree' | 'rock';
interface Thing { kind: ThingKind; obj: THREE.Object3D; angle: number; lane: number; alive: boolean; pop: number }

/** Smooth, slightly bumpy shapes in one flat-shaded material. */
const lam = (hex: string) => new THREE.MeshLambertMaterial({ color: new THREE.Color(hex), flatShading: true });

function drumTexture(): THREE.CanvasTexture {
  // u: around the drum; v: across it (lanes)
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4fae7c';
  g.fillRect(0, 0, 1024, 256);
  // grass tufts
  for (let i = 0; i < 900; i++) {
    g.fillStyle = Math.random() < 0.5 ? '#5fbf86' : '#357f62';
    g.fillRect(Math.random() * 1024, Math.random() * 256, 3 + Math.random() * 5, 2 + Math.random() * 3);
  }
  // the road: three lanes of packed dirt with kerbs
  const road0 = 256 * (0.5 - (LANE * 1.65) / LEN), road1 = 256 * (0.5 + (LANE * 1.65) / LEN);
  g.fillStyle = '#e8e2cf';
  g.fillRect(0, road0 - 7, 1024, road1 - road0 + 14);
  g.fillStyle = '#a89a86';
  g.fillRect(0, road0, 1024, road1 - road0);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = Math.random() < 0.5 ? '#968a78' : '#b8ac98';
    g.fillRect(Math.random() * 1024, road0 + Math.random() * (road1 - road0), 4 + Math.random() * 8, 2);
  }
  // lane dashes
  g.fillStyle = '#f1e3c4';
  for (const f of [-0.5, 0.5]) {
    const y = 128 + (f * LANE * 256) / LEN;
    for (let x = 0; x < 1024; x += 48) g.fillRect(x, y - 2, 24, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeBull(): { group: THREE.Group; legs: THREE.Object3D[]; head: THREE.Object3D; tail: THREE.Object3D; body: THREE.Object3D } {
  const hide = lam('#a5552e');
  const dark = lam('#5e2c1a');
  const snoutM = lam('#c98f6f');
  const horn = lam('#f1e3c4');
  const hoof = lam('#1d1420');
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  // chest is bigger than the hindquarters: that's what reads as "bull"
  const chest = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), hide);
  chest.scale.set(0.95, 0.95, 1.0);
  chest.position.set(0, 0.95, -0.28);
  const hump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), dark);
  hump.position.set(0, 1.32, -0.3);
  const hind = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), hide);
  hind.scale.set(0.9, 0.85, 1.05);
  hind.position.set(0, 0.92, 0.38);
  body.add(chest, hump, hind);
  // head, low and forward, ready to charge
  const head = new THREE.Group();
  head.position.set(0, 1.0, -0.8);
  const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), dark);
  skull.scale.set(1, 0.95, 1.15);
  const snout = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), snoutM);
  snout.scale.set(1.05, 0.8, 0.9);
  snout.position.set(0, -0.14, -0.27);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.018, 6, 16), emissive(new THREE.Color('#e9b24c'), 1.6));
  ring.position.set(0, -0.26, -0.42);
  head.add(skull, snout, ring);
  for (const s of [-1, 1]) {
    // horns sweep out, then forward
    const h1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.32, 6), horn);
    h1.position.set(s * 0.33, 0.14, -0.02);
    h1.rotation.z = s * -1.25;
    const h2 = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.3, 6), horn);
    h2.position.set(s * 0.5, 0.27, -0.1);
    h2.rotation.set(-0.5, 0, s * -0.35);
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 5), dark);
    ear.position.set(s * 0.3, 0.02, 0.1);
    ear.rotation.z = s * -1.9;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), emissive(new THREE.Color('#ff4d3a'), 4));
    eye.position.set(s * 0.17, 0.06, -0.24);
    head.add(h1, h2, ear, eye);
  }
  g.add(head);
  // legs pivot at the shoulder/hip so they can gallop
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[-0.25, -0.38], [0.25, -0.38], [-0.24, 0.45], [0.24, 0.45]] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.78, z);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.62, 6), dark);
    leg.position.y = -0.31;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.1, 6), hoof);
    foot.position.y = -0.64;
    pivot.add(leg, foot);
    g.add(pivot);
    legs.push(pivot);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 1.05, 0.8);
  const tailRod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.5, 5), dark);
  tailRod.position.y = -0.22;
  const tuft = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), dark);
  tuft.position.y = -0.5;
  tail.add(tailRod, tuft);
  tail.rotation.x = 0.5;
  g.add(tail);
  g.scale.setScalar(0.8);
  return { group: g, legs, head, tail, body };
}

function makeBear(): THREE.Group {
  const fur = lam('#5a3a30'), muzzle = lam('#b98a6a'), nose = lam('#1d1420');
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), fur);
  body.scale.set(1, 0.85, 1.15);
  body.position.y = 0.3;
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), fur);
  head.position.set(0, 0.48, 0.3);
  const snout = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), muzzle);
  snout.position.set(0, 0.43, 0.5);
  const n = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), nose);
  n.position.set(0, 0.46, 0.59);
  g.add(body, head, snout, n);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), fur);
    ear.position.set(s * 0.15, 0.66, 0.26);
    g.add(ear);
  }
  return g;
}

/** A red "candle" from a falling chart: too tall to jump, change lanes. */
function makeWall(): THREE.Group {
  const g = new THREE.Group();
  const red = emissive(new THREE.Color('#e8283e'), 1.05);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.34), red);
  body.position.y = 0.75;
  const wick = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.7, 0.07), emissive(new THREE.Color('#ff8a8a'), 1.2));
  wick.position.y = 0.85;
  g.add(wick, body);
  return g;
}

function makeTree(s: number): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.35, 5), lam('#5a3a30'));
  trunk.position.y = 0.17;
  g.add(trunk);
  const leaf = lam(Math.random() < 0.5 ? '#2f8a6a' : '#226a58');
  [[0.38, 0.55, 0.42], [0.28, 0.45, 0.72], [0.17, 0.36, 0.98]].forEach(([r, h, y]) => {
    const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), leaf);
    c.position.y = y;
    g.add(c);
  });
  g.scale.setScalar(s);
  return g;
}

export class Arcade implements Landmark {
  readonly id: string;
  readonly group = new THREE.Group();
  readonly hit: THREE.Object3D[];
  readonly labels: Label[] = [];
  readonly focus: { target: THREE.Vector3; offset: THREE.Vector3 };
  private drum = new THREE.Group();
  private things: Thing[] = [];
  private bull: ReturnType<typeof makeBull>;
  private lane = 0; // current lane (-1, 0, 1)
  private x = 0;
  private y = 0;
  private vy = 0;
  private gallop = 0;
  private coins = 0;
  private halos = new Halos();
  private coinLabel: THREE.Mesh;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private center: THREE.Vector3;
  private blob: THREE.Mesh;

  constructor(p: Project, _low: boolean) {
    this.id = p.id;
    const g = this.group;
    const [cx, cz] = SPOTS.arcade.anchor;
    this.center = v3(cx, ROOF, cz);
    // behind and above the bull, so the road rolls over the horizon toward us
    this.focus = { target: v3(cx, ROOF + R + 0.3, cz - 1.2), offset: v3(4.2, 3.9, 8.2) };

    const sign = textSign('RAGING BULL', { height: 0.9, color: '#ffb36b' });
    sign.position.set(cx + 2, 0.36 + 3.35, cz + 4.08);
    g.add(sign);
    const cols = [new THREE.Color('#ff4fa3'), P.phosphor, P.sodium];
    cols.forEach((c, i) => this.halos.add(`s${i}`, v3(cx - 4 + i * 4, 0.36 + 1.4 + i * 0.5, cz + 4.4), c, 5, 0.1));
    g.add(this.halos.group);

    // The rolling world: a drum, half sunk into the roof, turning toward us.
    this.drum.position.copy(this.center);
    const tex = drumTexture();
    // a little self-light keeps the road and grass their own colours under the violet dusk fill
    const drumMat = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.28 });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, LEN, 72, 1, true).rotateZ(Math.PI / 2), drumMat);
    this.drum.add(shell);
    const capMat = lam('#7a5468');
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CircleGeometry(R, 72), capMat);
      cap.rotation.y = (s * Math.PI) / 2;
      cap.position.x = (s * LEN) / 2;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.07, 6, 72), emissive(P.sodium, 1.4));
      rim.rotation.y = Math.PI / 2;
      rim.position.x = s * (LEN / 2 + 0.01);
      this.drum.add(cap, rim);
    }
    g.add(this.drum);
    // cradle: two glowing arches the drum turns in, so it reads as a machine
    for (const s of [-1, 1]) {
      const arch = new THREE.Mesh(new THREE.TorusGeometry(R + 0.22, 0.09, 6, 48, Math.PI), solid(new THREE.Color('#3a3654')));
      arch.rotation.y = Math.PI / 2;
      arch.position.set(cx + s * (LEN / 2 + 0.2), ROOF, cz);
      g.add(arch);
    }

    // Scenery and the track's contents, fixed to the drum so they roll with it.
    const rnd = mulberry(7);
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1;
      const tree = rnd() < 0.8;
      const obj = tree ? makeTree(0.42 + rnd() * 0.3) : new THREE.Mesh(new THREE.IcosahedronGeometry(0.16 + rnd() * 0.12, 0), lam('#7a5468'));
      this.mount(obj, (i / 26) * Math.PI * 2 + rnd() * 0.2, side * (LEN / 2 - 0.22 - rnd() * 0.2));
      this.things.push({ kind: tree ? 'tree' : 'rock', obj, angle: 0, lane: 9, alive: true, pop: 0 });
    }
    for (let i = 0; i < 14; i++) {
      const t: Thing = { kind: 'coin', obj: new THREE.Group(), angle: 0, lane: 0, alive: true, pop: 0 };
      this.things.push(t);
      this.respawn(t, (i / 14) * Math.PI * 2, rnd);
    }
    for (let i = 0; i < 7; i++) {
      const t: Thing = { kind: rnd() < 0.55 ? 'bear' : 'wall', obj: new THREE.Group(), angle: 0, lane: 0, alive: true, pop: 0 };
      this.things.push(t);
      this.respawn(t, (i / 7) * Math.PI * 2 + 0.3, rnd);
    }

    // The bull, running away from us toward the horizon.
    this.bull = makeBull();
    this.bull.group.rotation.y = 0; // model faces -z already
    g.add(this.bull.group);
    // contact shadow so he sits on the road
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
    g.add(this.blob);

    // coin counter floating over the drum
    this.coinLabel = textSign('0 COINS', { height: 0.42, color: '#ffd29a', bg: null });
    this.coinLabel.position.set(cx, ROOF + R + 1.9, cz - 0.4);
    g.add(this.coinLabel);

    this.labels.push({ text: 'Arcade', pos: v3(cx, 11.5, cz), detail: false });
    this.hit = [hitBox(this.id, SPOTS.arcade.rect, 9)];
    g.add(...this.hit);
  }

  /** Attach an object to the drum surface at a drum angle and across-offset. */
  private mount(obj: THREE.Object3D, angle: number, x: number) {
    const holder = obj.parent?.userData.holder ? obj.parent : new THREE.Group();
    holder.userData.holder = true;
    holder.rotation.x = angle;
    obj.position.set(x, R, 0);
    if (obj.parent !== holder) holder.add(obj);
    if (!holder.parent) this.drum.add(holder);
    obj.userData.angle = angle;
  }

  private respawn(t: Thing, angle: number, rnd: () => number) {
    t.lane = Math.floor(rnd() * 3) - 1;
    t.alive = true;
    t.pop = 0;
    const old = t.obj;
    let obj: THREE.Object3D;
    if (t.kind === 'coin') {
      obj = new THREE.Group();
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 16).rotateZ(Math.PI / 2), emissive(new THREE.Color('#ffc94d'), 2.6));
      coin.position.y = 0.42;
      obj.add(coin);
    } else if (t.kind === 'bear') {
      obj = makeBear();
    } else {
      obj = makeWall();
    }
    if (old.parent) {
      const holder = old.parent;
      holder.remove(old);
      holder.add(obj);
    }
    t.obj = obj;
    // face the bull (who runs toward -z, so things face +z... i.e. toward him)
    obj.rotation.y = 0;
    this.mount(obj, angle, t.lane * LANE);
  }

  /** Angle of a thing above the drum axis, measured so 0 = the very top and
   *  negative = still ahead of the bull (on the far side). */
  private relAngle(t: Thing) {
    const a = ((t.obj.userData.angle as number) + this.drum.rotation.x) % (Math.PI * 2);
    const r = a < 0 ? a + Math.PI * 2 : a;
    return r > Math.PI ? r - Math.PI * 2 : r; // (-π, π]
  }

  update(dt: number, t: number) {
    const [cx] = SPOTS.arcade.anchor;
    const spin = this.reduce ? SPEED * 0.4 : SPEED;
    this.drum.rotation.x += dt * spin;

    // Things that rolled under the roof on our side come back with a new
    // lane on the far side, out of sight.
    const rnd = Math.random;
    for (const th of this.things) {
      if (th.kind === 'tree' || th.kind === 'rock') continue;
      const ra = this.relAngle(th);
      if (ra > 1.9 && (!th.alive || th.obj.userData.cycled !== true)) {
        th.obj.userData.cycled = true;
        if (th.kind !== 'coin') th.kind = rnd() < 0.55 ? 'bear' : 'wall';
        const base = th.obj.userData.angle as number;
        this.respawn(th, base, rnd);
        th.obj.userData.cycled = true;
      } else if (ra < 0) {
        th.obj.userData.cycled = false;
      }
      if (th.kind === 'coin') {
        const coin = th.obj.children[0];
        coin.rotation.y = t * 4;
        if (!th.alive) {
          th.pop = Math.min(1, th.pop + dt * 3);
          coin.scale.setScalar(1 + th.pop * 1.5);
          coin.position.y = 0.42 + th.pop * 0.6;
          coin.visible = th.pop < 1;
        }
      }
    }

    // The bull reads the next stretch of his lane.
    const ahead = (lane: number, kinds: ThingKind[], a0: number, a1: number) =>
      this.things.some((th) => th.alive && kinds.includes(th.kind) && th.lane === lane && this.relAngle(th) > -a1 && this.relAngle(th) < -a0);
    const wallAhead = ahead(this.lane, ['wall'], 0.05, 0.75);
    if (wallAhead) {
      const options = [-1, 0, 1].filter((l) => Math.abs(l - this.lane) === 1 && !ahead(l, ['wall', 'bear'], -0.1, 0.75));
      if (options.length) this.lane = options[Math.floor(Math.random() * options.length)];
    } else if (!ahead(this.lane, ['coin'], 0.1, 0.9)) {
      // drift toward a coin in a neighbouring lane if the way there is clear
      for (const l of [this.lane - 1, this.lane + 1]) {
        if (l < -1 || l > 1) continue;
        if (ahead(l, ['coin'], 0.25, 0.8) && !ahead(l, ['wall', 'bear'], -0.1, 0.8)) {
          this.lane = l;
          break;
        }
      }
    }
    if (this.y === 0 && ahead(this.lane, ['bear'], 0.02, 0.2)) this.vy = 4.2;
    this.vy -= dt * 13;
    this.y = Math.max(0, this.y + this.vy * dt);
    if (this.y === 0 && this.vy < 0) this.vy = 0;
    this.x += (this.lane * LANE - this.x) * (1 - Math.exp(-9 * dt));

    // collect coins under him
    for (const th of this.things) {
      if (th.kind !== 'coin' || !th.alive || th.lane !== this.lane) continue;
      if (Math.abs(this.relAngle(th)) < 0.07 && this.y < 0.6) {
        th.alive = false;
        this.coins++;
        this.setCoins();
      }
    }

    // gallop
    const b = this.bull;
    this.gallop += dt * (this.reduce ? 4 : 11);
    const air = this.y > 0.02;
    b.legs.forEach((leg, i) => {
      const phase = i < 2 ? 0 : Math.PI * 0.9;
      leg.rotation.x = air ? (i < 2 ? -0.8 : 0.7) : Math.sin(this.gallop + phase + (i % 2) * 0.35) * 0.75;
    });
    b.body.position.y = air ? 0 : Math.abs(Math.sin(this.gallop)) * 0.08;
    b.body.rotation.x = air ? -0.12 : Math.sin(this.gallop) * 0.06;
    b.head.rotation.x = Math.sin(this.gallop + 0.6) * 0.12 + 0.08;
    b.tail.rotation.z = Math.sin(this.gallop * 0.7) * 0.4;
    b.group.position.set(cx + this.x, ROOF + R - 0.03 + this.y, this.center.z);
    b.group.rotation.z = (this.lane * LANE - this.x) * -0.35; // lean into lane changes
    this.blob.position.set(cx + this.x, ROOF + R + 0.02, this.center.z);
    this.blob.scale.setScalar(1 / (1 + this.y * 0.8));
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.55 / (1 + this.y);

    for (let i = 0; i < 3; i++) this.halos.set(`s${i}`, 0.08 + Math.max(0, Math.sin(t * 3 - i * 0.9)) * 0.18);
    this.halos.update(dt);
  }

  private setCoins() {
    const old = this.coinLabel;
    const fresh = textSign(`${this.coins} COINS`, { height: 0.42, color: '#ffd29a', bg: null });
    fresh.position.copy(old.position);
    this.group.add(fresh);
    this.group.remove(old);
    (old.material as THREE.MeshBasicMaterial).map?.dispose();
    old.geometry.dispose();
    this.coinLabel = fresh;
  }
}

function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
