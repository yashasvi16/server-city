// Jetstrike Arena: a stadium with jets circling overhead, plus the Gateway
// arch at the south edge (auth + sessions), where every request enters.
// The stadium, buildings and arch are baked (build_arena / build_gateway);
// jets, the gateway scanner, the pitch glow and halos live here.
import * as THREE from 'three';
import type { Project } from '../../config/types';
import { CourierFlow } from '../courier';
import type { FlowCallbacks, Label, Landmark } from '../landmark';
import { GATE, SPOTS } from '../layout';
import { Halos } from '../glow';
import { emissive, solid } from '../materials';
import { P } from '../palette';
import { hitBox, textSign, v3 } from '../util';

class Jet {
  readonly group = new THREE.Group();
  private trail: THREE.Line;
  constructor(private radius: number, private height: number, private speed: number, private phase: number) {
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.32, 2.4, 6).rotateZ(-Math.PI / 2), solid(new THREE.Color('#d6d9ef')));
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 2.4), solid(new THREE.Color('#8a90c0')));
    wing.position.x = -0.2;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.06), solid(new THREE.Color('#8a90c0')));
    tail.position.set(-1.0, 0.3, 0);
    const engine = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), emissive(P.sodium, 6));
    engine.position.x = -1.25;
    this.group.add(body, wing, tail, engine);
    const N = 60;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = 1 - i / (N - 1);
    g.setAttribute('alpha', new THREE.BufferAttribute(a, 1));
    this.trail = new THREE.Line(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(vec3(1.0,0.85,0.7) * 1.4, vA * vA * 0.7); }',
    }));
    this.trail.frustumCulled = false;
  }
  get trailObj() {
    return this.trail;
  }
  private at(t: number, center: THREE.Vector3, out: THREE.Vector3) {
    const a = this.phase + t * this.speed;
    const r = this.radius + Math.sin(t * 0.7 + this.phase) * 2;
    return out.set(center.x + Math.cos(a) * r, this.height + Math.sin(t * 1.1 + this.phase) * 1.2, center.z + Math.sin(a) * r);
  }
  update(t: number, center: THREE.Vector3) {
    const p = this.at(t, center, new THREE.Vector3());
    const ahead = this.at(t + 0.05, center, new THREE.Vector3());
    this.group.position.copy(p);
    this.group.lookAt(ahead);
    this.group.rotateY(-Math.PI / 2);
    this.group.rotateX(-0.45); // bank into the turn
    // The trail is the flight path over the last ~1.5 s, computed exactly,
    // so it stays smooth at any frame rate.
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const q = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      this.at(t - i * 0.025, center, q);
      pos.setXYZ(i, q.x, q.y, q.z);
    }
    pos.needsUpdate = true;
  }
}

export class Arena implements Landmark {
  readonly id: string;
  readonly group = new THREE.Group();
  readonly hit: THREE.Object3D[];
  readonly labels: Label[] = [];
  readonly focus = { target: v3(1, 3, -31), offset: v3(22, 40, 54) };
  private jets: Jet[] = [];
  private center: THREE.Vector3;
  private laser: THREE.Mesh;
  private flow: CourierFlow;
  private halos = new Halos();

  constructor(private p: Project, low: boolean) {
    this.id = p.id;
    const g = this.group;
    const Y0 = 0.36;
    const [cx, cz] = SPOTS.arena.anchor;
    this.center = v3(cx, 0, cz);
    const nl = (k: string, d: string) => p.nodes?.[k]?.label ?? d;
    this.labels.push({ text: 'Jetstrike Arena', pos: v3(cx, 11, cz), detail: false });

    const jets = low ? 2 : 3;
    for (let i = 0; i < jets; i++) {
      const j = new Jet(16 + i * 2.5, 14 + i * 2, 0.32 + i * 0.05, (i * Math.PI * 2) / jets);
      this.jets.push(j);
      g.add(j.group, j.trailObj);
    }

    // Halos over the baked pieces that light up as a request passes.
    this.halos.add('arena', v3(cx, Y0 + 0.6, cz), P.phosphor, 13, 0.12);
    this.halos.add('sessions', v3(-10.5, Y0 + 1.8, -21.4), P.windowCool, 4, 0.18);
    this.halos.add('buffer', v3(10.5, Y0 + 2, -21.4), P.sodium, 4, 0.18);
    this.halos.add('db', v3(14.5, Y0 + 3.1, -31), P.sodium, 4, 0.2);
    this.labels.push(
      { text: nl('sessions', 'Sessions'), pos: v3(-10.5, 5.2, -23.5), detail: true },
      { text: nl('buffer', 'Accumulator'), pos: v3(10.5, 5.6, -23.5), detail: true },
      { text: nl('db', 'PostgreSQL'), pos: v3(14.5, 5, -31), detail: true },
    );

    // Gateway: sign on the baked lintel and a scanner beam between the pylons.
    const [gx, gz] = GATE;
    const gateSign = textSign('GATEWAY', { height: 0.95, color: '#ffd29a' });
    gateSign.position.set(gx, Y0 + 10.25, gz + 1.17);
    g.add(gateSign);
    this.laser = new THREE.Mesh(new THREE.PlaneGeometry(8.9, 0.08), emissive(P.signal, 3));
    (this.laser.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    this.laser.position.set(gx, 4, gz);
    g.add(this.laser);
    this.halos.add('gateway', v3(gx, Y0 + 9.4, gz + 1.3), P.sodium, 9, 0.1);
    this.labels.push({ text: nl('gateway', 'Gateway'), pos: v3(gx, 13, gz), detail: true });
    g.add(this.halos.group);

    const nodes: Record<string, THREE.Vector3> = {
      gateway: v3(gx, 3, gz),
      sessions: v3(-10.5, 3.6, -21),
      arena: v3(cx, 3, cz),
      buffer: v3(10.5, 3.8, -21),
      db: v3(14.5, 4.2, -31),
    };
    this.flow = new CourierFlow(nodes, (n) => this.halos.pulse(n));
    g.add(this.flow.courier.group);

    const gateHit = hitBox(this.id, [gx - 7, gz - 2, gx + 7, gz + 2], 12);
    this.hit = [hitBox(this.id, SPOTS.arena.rect, 10), gateHit];
    g.add(...this.hit);
  }

  playFlow(i: number, cb: FlowCallbacks) {
    const f = this.p.flows?.[i];
    if (f) this.flow.play(f, cb);
  }
  stopFlow() {
    this.flow.stop();
  }

  update(dt: number, t: number) {
    this.flow.update(dt);
    for (const j of this.jets) j.update(t, this.center);
    this.laser.position.y = 1 + (Math.sin(t * 1.6) * 0.5 + 0.5) * 7.5;
    this.halos.set('arena', 0.1 + Math.sin(t * 2) * 0.03);
    this.halos.update(dt);
  }
}
