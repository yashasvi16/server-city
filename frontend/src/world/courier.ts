import * as THREE from 'three';
import type { Flow } from '../config/types';
import type { FlowCallbacks } from './landmark';
import { emissive } from './materials';
import { P } from './palette';
import { radialTexture } from './glow';

/** A glowing orb with a fading light trail, flown along arcs between nodes. */
export class Courier {
  readonly group = new THREE.Group();
  private orb: THREE.Mesh;
  private halo: THREE.Sprite;
  private trail: THREE.Line;
  private hist: THREE.Vector3[] = [];
  private curve: THREE.Curve<THREE.Vector3> | null = null;
  private u = 0;
  private dur = 1;
  private onArrive: (() => void) | null = null;
  private color = new THREE.Color();

  constructor(size = 0.45) {
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), emissive(P.sodium, 6));
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(), color: P.sodium, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo.scale.setScalar(size * 7);
    const N = 28;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    const alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) alpha[i] = 1 - i / (N - 1);
    g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    this.trail = new THREE.Line(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color() } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * 3.0, vA * vA); }',
    }));
    this.trail.frustumCulled = false;
    this.group.add(this.orb, this.halo, this.trail);
    this.group.visible = false;
    this.setColor(P.sodium);
  }

  setColor(c: THREE.Color) {
    this.color.copy(c);
    (this.orb.material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(6);
    (this.halo.material as THREE.SpriteMaterial).color.copy(c);
    ((this.trail.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).copy(c);
  }

  at(p: THREE.Vector3) {
    this.group.visible = true;
    this.curve = null;
    this.orb.position.copy(p);
    this.halo.position.copy(p);
    this.hist = [p.clone()];
  }

  /** Fly an arc from the current position to `to`. */
  fly(to: THREE.Vector3, lift: number, speed: number, onArrive: () => void) {
    const from = this.orb.position.clone();
    const mid = from.clone().lerp(to, 0.5);
    mid.y += lift + from.distanceTo(to) * 0.18;
    this.curve = new THREE.QuadraticBezierCurve3(from, mid, to.clone());
    this.dur = Math.max(0.35, this.curve.getLength() / speed);
    this.u = 0;
    this.onArrive = onArrive;
  }

  hide() {
    this.group.visible = false;
    this.curve = null;
    this.onArrive = null;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    if (this.curve) {
      this.u = Math.min(1, this.u + dt / this.dur);
      const e = this.u < 0.5 ? 2 * this.u * this.u : 1 - Math.pow(-2 * this.u + 2, 2) / 2;
      this.curve.getPoint(e, this.orb.position);
      this.halo.position.copy(this.orb.position);
      if (this.u >= 1) {
        this.curve = null;
        const cb = this.onArrive;
        this.onArrive = null;
        cb?.();
      }
    }
    this.hist.unshift(this.orb.position.clone());
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (this.hist.length > pos.count) this.hist.length = pos.count;
    for (let i = 0; i < pos.count; i++) {
      const p = this.hist[Math.min(i, this.hist.length - 1)];
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
  }
}

const OUTCOME: Record<Flow['outcome'], THREE.Color> = { ok: P.phosphor, retry: P.sodium, dead: P.signal };

/** Plays a config flow by flying a courier node to node, dwelling at each. */
export class CourierFlow {
  readonly courier = new Courier(0.5);
  private gen = 0;
  private timers: number[] = [];
  playing = false;

  constructor(private nodes: Record<string, THREE.Vector3>, private pulse: (node: string) => void) {}

  play(flow: Flow, cb: FlowCallbacks) {
    this.stop();
    const gen = ++this.gen;
    this.playing = true;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const c = this.courier;
    c.setColor(P.sodium);
    c.at(this.nodes[flow.steps[0].node]);
    const arrive = (i: number) => {
      if (gen !== this.gen) return;
      const node = flow.steps[i].node;
      this.pulse(node);
      if (i === flow.steps.length - 1) c.setColor(OUTCOME[flow.outcome]);
      cb.onStep(i);
      this.timers.push(window.setTimeout(() => {
        if (gen !== this.gen) return;
        if (i === flow.steps.length - 1) {
          this.timers.push(window.setTimeout(() => {
            if (gen !== this.gen) return;
            c.hide();
            this.playing = false;
            cb.onDone();
          }, 900));
          return;
        }
        const to = this.nodes[flow.steps[i + 1].node];
        if (reduce || to.distanceTo(c.group.children[0].position) < 0.01) {
          c.at(to);
          arrive(i + 1);
        } else {
          c.fly(to, 2.5, 16, () => arrive(i + 1));
        }
      }, reduce ? 1700 : 1000));
    };
    arrive(0);
  }

  stop() {
    this.gen++;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.courier.hide();
    this.playing = false;
  }

  update(dt: number) {
    this.courier.update(dt);
  }
}
