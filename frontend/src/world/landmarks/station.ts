// Queue Station: Mini-Sidekiq as a rail yard. The buildings and track are
// baked into the city (tools/blender/build_city.py, build_station); this file
// adds what moves: trains running the real flows from the config, the
// dispatcher's weighted signal lamps, worker-pool fans, the scheduler clock
// and halos that flare as a job reaches each node.
import * as THREE from 'three';
import type { Flow, Project } from '../../config/types';
import { Halos } from '../glow';
import type { FlowCallbacks, Label, Landmark } from '../landmark';
import { nodeRoute, SPOTS, STATION_NODES } from '../layout';
import { emissive, solid } from '../materials';
import { P } from '../palette';
import { filletPath, Train } from '../rail';
import { hitBox, v3 } from '../util';

const OUTCOME: Record<Flow['outcome'], THREE.Color> = { ok: P.phosphor, retry: P.sodium, dead: P.signal };
const Y0 = 0.42; // top of the yard bed (YARD_TOP in the Blender build)
const RAIL_Y = Y0 + 0.05;

export class Station implements Landmark {
  readonly id: string;
  readonly group = new THREE.Group();
  readonly hit: THREE.Object3D[] = [];
  readonly labels: Label[] = [];
  readonly focus = { target: v3(0, 0, -1), offset: v3(-6, 40, 50) };

  private curves = new Map<string, THREE.Curve<THREE.Vector3>>();
  private flows: Flow[];
  private halos = new Halos();
  private signal: THREE.MeshBasicMaterial[] = [];
  private fans: THREE.Object3D[] = [];
  private hands: THREE.Object3D[] = [];
  private hero: Train;
  private ambient: Train[] = [];
  private ambientTimer = 1.5;
  private playing = false;
  private gen = 0;
  private timers: number[] = [];
  fanBoost = 0;

  constructor(p: Project, low: boolean) {
    this.id = p.id;
    this.flows = p.flows ?? [];
    const N = STATION_NODES;
    const nodes = Object.values(N);
    for (const f of this.flows) {
      for (let i = 0; i < f.steps.length - 1; i++) {
        const a = f.steps[i].node, b = f.steps[i + 1].node;
        const key = `${a}>${b}`;
        if (a === b || this.curves.has(key)) continue;
        const pts = nodeRoute(N[a], N[b], nodes).map(([x, z]) => v3(x, RAIL_Y, z));
        this.curves.set(key, filletPath(pts, 1.8));
      }
    }
    this.build(p);
    this.group.add(this.halos.group);

    this.hero = new Train(3, P.phosphor);
    this.hero.speed = 10;
    this.hero.group.visible = false;
    this.group.add(this.hero.group);
    for (let i = 0; i < (low ? 1 : 2); i++) {
      const t = new Train(2, P.sodium);
      t.speed = 11;
      t.group.visible = false;
      this.ambient.push(t);
      this.group.add(t.group);
    }
    this.hit.push(hitBox(this.id, SPOTS.station.rect, 12));
    this.group.add(...this.hit);
  }

  private build(p: Project) {
    const N = STATION_NODES;
    const g = this.group;
    const nl = (id: string) => p.nodes?.[id]?.label ?? id;
    const label = (text: string, x: number, y: number, z: number, detail = true) => this.labels.push({ text, pos: v3(x, y, z), detail });
    const H = this.halos;

    { // client: ticket kiosk window
      const [x, z] = N.client;
      H.add('client', v3(x - 2.8, Y0 + 1.4, z + 3.7), P.window, 2.6);
      label(nl('client'), x - 2.8, Y0 + 3.6, z + 2.6);
    }
    { // broker: the station hall sign
      const [x, z] = N.broker;
      H.add('broker', v3(x - 1.5, Y0 + 7.4, z + 0.5), P.sodium, 5);
      label('Queue Station', x - 1.5, 10.4, z, false);
      label(nl('broker'), x - 1.5, 8.8, z);
    }
    { // dispatcher: three lamps on the signal board blink 3:2:1 like the queue weights
      const [x, z] = N.dispatcher;
      const colors = [P.sodium, P.white, P.windowCool];
      colors.forEach((c, i) => {
        const m = emissive(c, 0.4);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8), m);
        lamp.position.set(x - 3, Y0 + 7.4 - i * 0.8, z + 3.45);
        g.add(lamp);
        this.signal.push(m);
      });
      H.add('dispatcher', v3(x - 3, Y0 + 6.6, z + 3.6), P.white, 3);
      label(nl('dispatcher'), x - 3, Y0 + 10, z + 2.5);
    }
    { // worker pool: a roof fan per shed (one goroutine each)
      const [x, z] = N.pool;
      const bladeMat = solid(new THREE.Color('#b8bce0'));
      const hubMat = emissive(P.phosphor, 2);
      for (let i = 0; i < 4; i++) {
        const sx = x - 3.9 + i * 2.6, sz = -4 + (z - 2);
        const fan = new THREE.Group();
        for (let b = 0; b < 3; b++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.28), bladeMat);
          blade.rotation.y = (b * Math.PI) / 3;
          fan.add(blade);
        }
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 8), hubMat);
        fan.add(hub);
        fan.position.set(sx, Y0 + 2.5, sz);
        g.add(fan);
        this.fans.push(fan);
      }
      H.add('pool', v3(x, Y0 + 1.3, -4 + (z - 2) + 1.4), P.window, 6, 0.15);
      label(nl('pool'), x, Y0 + 4.4, -4 + (z - 2));
    }
    { // middleware gantries
      const [x, z] = N.middleware;
      H.add('middleware', v3(x - 3.95, Y0 + 2.75, z), P.phosphor, 5, 0.15);
      label(nl('middleware'), x - 4, Y0 + 4.4, z);
    }
    { // handler: factory chimney
      const [x, z] = N.handler;
      H.add('handler', v3(x + 6, Y0 + 5.3, z + 5.6), P.sodium, 3);
      label(nl('handler'), x + 4.6, Y0 + 6.8, z + 4);
    }
    { // ack platform strip
      const [x, z] = N.ack;
      H.add('ack', v3(x, Y0 + 0.6, z - 0.86), P.phosphor, 6, 0.12);
      label(nl('ack'), x, Y0 + 3.6, z - 1.5);
    }
    { // retry roundhouse doors
      const [x, z] = N.retry;
      H.add('retry', v3(x, Y0 + 1.2, z + 2.4), P.sodium, 4, 0.15);
      label(nl('retry'), x, Y0 + 4.8, z - 1.3);
    }
    { // scheduler clock with moving hands
      const [x, z] = N.scheduler;
      const cx = x - 3.2, cz = z - 1.0;
      const handMat = solid(new THREE.Color('#1b1f3b'));
      for (const [len, w] of [[0.55, 0.07], [0.4, 0.1]] as const) {
        const hand = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.03).translate(0, len / 2, 0), handMat);
        hand.position.set(cx, Y0 + 6.7, cz + 1.07);
        g.add(hand);
        this.hands.push(hand);
      }
      H.add('scheduler', v3(cx, Y0 + 6.7, cz + 1.2), P.white, 2.6);
      label(nl('scheduler'), cx, Y0 + 10.4, cz);
    }
    { // dead letters: blinking lamp on the buffer stop
      const [x, z] = N.dlq;
      const m = emissive(P.signal, 2.5);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), m);
      lamp.position.set(x + 1.3, Y0 + 1.42, z);
      g.add(lamp);
      this.signal.push(m); // index 3: animated separately
      H.add('dlq', v3(x + 1.3, Y0 + 1.42, z), P.signal, 2.4, 0.3);
      label(nl('dlq'), x + 1.3, Y0 + 3, z);
    }
  }

  private stepCurve(a: string, b: string) {
    return this.curves.get(`${a}>${b}`);
  }

  private stopAt(node: string) {
    const [x, z] = STATION_NODES[node];
    return filletPath([v3(x - 0.01, RAIL_Y, z), v3(x, RAIL_Y, z)]);
  }

  playFlow(index: number, cb: FlowCallbacks) {
    this.stopFlow();
    const flow = this.flows[index];
    if (!flow) return;
    const gen = ++this.gen;
    this.playing = true;
    for (const t of this.ambient) t.group.visible = false;
    const tr = this.hero;
    tr.setColor(P.sodium);
    tr.place(this.stopAt(flow.steps[0].node), false);
    tr.group.visible = true;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const arrive = (i: number) => {
      if (gen !== this.gen) return;
      const node = flow.steps[i].node;
      this.halos.pulse(node);
      if (node === 'pool' || node === 'handler') this.fanBoost = 1;
      if (node === 'ack' || node === 'dlq' || node === 'retry') tr.setColor(OUTCOME[flow.outcome]);
      cb.onStep(i);
      this.timers.push(window.setTimeout(() => {
        if (gen !== this.gen) return;
        if (i === flow.steps.length - 1) {
          this.timers.push(window.setTimeout(() => {
            if (gen !== this.gen) return;
            tr.group.visible = false;
            this.playing = false;
            cb.onDone();
          }, 900));
          return;
        }
        const next = flow.steps[i + 1].node;
        const c = this.stepCurve(node, next);
        if (!c || reduce) {
          tr.place(this.stopAt(next), false);
          arrive(i + 1);
        } else {
          tr.go(c, () => arrive(i + 1));
        }
      }, reduce ? 1700 : 1000));
    };
    arrive(0);
  }

  stopFlow() {
    this.gen++;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.hero.group.visible = false;
    this.playing = false;
  }

  /** Background traffic: short trains running the first two flows. */
  private runAmbient() {
    const t = this.ambient.find((x) => !x.group.visible);
    const flow = this.flows[Math.random() < 0.8 ? 0 : 1];
    if (!t || !flow) return;
    const steps = flow.steps.map((s) => s.node);
    const curves: THREE.Curve<THREE.Vector3>[] = [];
    for (let i = 0; i < steps.length - 1; i++) {
      const c = this.stepCurve(steps[i], steps[i + 1]);
      if (c) curves.push(c);
    }
    if (!curves.length) return;
    t.setColor(flow.outcome === 'ok' ? P.sodium : P.signal.clone().lerp(P.sodium, 0.5));
    t.place(curves[0]);
    t.group.visible = true;
    let k = 0;
    const next = () => {
      this.halos.pulse(steps[k + 1]);
      k++;
      if (k >= curves.length) {
        window.setTimeout(() => (t.group.visible = false), 400);
        return;
      }
      t.go(curves[k], next);
    };
    t.go(curves[0], next);
  }

  update(dt: number, t: number) {
    this.hero.update(dt);
    for (const a of this.ambient) a.update(dt);
    if (!this.playing) {
      this.ambientTimer -= dt;
      if (this.ambientTimer <= 0) {
        this.ambientTimer = 3.2 + Math.random() * 2;
        this.runAmbient();
      }
    }
    // Signal tower: critical, critical, critical, default, default, low.
    const seq = [0, 0, 0, 1, 1, 2];
    const on = seq[Math.floor(t * 2.2) % seq.length];
    const base = [P.sodium, P.white, P.windowCool];
    for (let i = 0; i < 3; i++) this.signal[i].color.copy(base[i]).multiplyScalar(i === on ? 4 : 0.25);
    this.signal[3].color.copy(P.signal).multiplyScalar(1.5 + Math.max(0, Math.sin(t * 3)) * 2.5);
    this.fanBoost = Math.max(0, this.fanBoost - dt * 0.4);
    for (const [i, f] of this.fans.entries()) f.rotation.y += dt * (1.5 + i * 0.3 + this.fanBoost * 9);
    this.hands[0].rotation.z = -t * 0.9;
    this.hands[1].rotation.z = -t * 0.075;
    this.halos.update(dt);
  }
}
