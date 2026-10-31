// The plaza (live stats hologram) and the lantern garden (guestbook).
import * as THREE from 'three';
import type { Mode, Stats } from '../../net/backend';
import type { Label, Landmark } from '../landmark';
import { SPOTS } from '../layout';
import { Halos } from '../glow';
import { P } from '../palette';
import { hitBox, v3 } from '../util';

const DISPLAY = "'Unbounded Variable', 'Arial Black', sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

/** A floating holographic panel that shows this server's own numbers. */
export class Hologram {
  readonly group = new THREE.Group();
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private mat: THREE.ShaderMaterial;
  private panel: THREE.Mesh;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 600;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { uMap: { value: this.tex }, uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D uMap; uniform float uTime; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(uMap, vUv);
          float scan = 0.82 + 0.18 * sin(vUv.y * 380.0 - uTime * 6.0);
          float edge = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x) * smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y);
          float flick = 0.94 + 0.06 * sin(uTime * 23.0) * sin(uTime * 7.0);
          gl_FragColor = vec4(c.rgb * 1.6 * scan * flick, (0.10 + c.a * 0.9) * edge);
        }`,
    });
    // The base and emitter disc are baked (build_plaza); the beam and panel are live.
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(10, 5.86), this.mat);
    this.panel.position.y = 7;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(4.8, 1.1, 3, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: P.phosphor.clone().multiplyScalar(0.5), transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.y = 2.6;
    this.group.add(beam, this.panel);
    this.draw('connecting', null, 0);
  }

  draw(mode: Mode, s: Stats | null, ghosts: number, waking = false) {
    const c = this.ctx, W = 1024, H = 600;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(40, 255, 210, 0.06)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(95, 242, 211, 0.9)';
    c.lineWidth = 3;
    c.strokeRect(14, 14, W - 28, H - 28);
    c.fillStyle = '#9ffff0';
    c.font = `500 30px ${MONO}`;
    c.fillText(mode === 'live' ? '● LIVE  /api/stats' : waking ? '… WAKING UP' : mode === 'demo' ? '○ OFFLINE DEMO' : '… CONNECTING', 48, 70);
    const cell = (label: string, value: string, x: number, y: number) => {
      c.fillStyle = '#eafffb';
      c.font = `700 92px ${DISPLAY}`;
      c.fillText(value, x, y);
      c.fillStyle = '#7fd8c6';
      c.font = `400 28px ${MONO}`;
      c.fillText(label, x, y + 44);
    };
    if (mode === 'live' && s) {
      cell('requests served', compact(s.requestsServed), 48, 220);
      cell('p95 handler time', `${s.p95Ms.toFixed(2)}ms`, 540, 220);
      cell('uptime', uptime(s.uptimeSec), 48, 440);
      cell('visitors online', String(s.visitorsOnline), 540, 440);
    } else if (mode === 'demo' && waking) {
      c.fillStyle = '#eafffb';
      c.font = `700 64px ${DISPLAY}`;
      c.fillText('Waking the server', 48, 220);
      c.fillStyle = '#9fe6d8';
      c.font = `400 32px ${MONO}`;
      ['The Go backend sleeps when nobody is here', '(free hosting) and takes about a minute to', 'start. Live numbers appear when it is up.'].forEach((l, i) => c.fillText(l, 48, 310 + i * 52));
    } else if (mode === 'demo') {
      c.fillStyle = '#eafffb';
      c.font = `700 64px ${DISPLAY}`;
      c.fillText('No backend here', 48, 220);
      c.fillStyle = '#9fe6d8';
      c.font = `400 32px ${MONO}`;
      ['This copy runs without the Go server,', 'so there are no live numbers.', `The ${ghosts} visitors on the streets are simulated.`].forEach((l, i) => c.fillText(l, 48, 310 + i * 52));
    }
    this.tex.needsUpdate = true;
  }

  update(t: number) {
    this.mat.uniforms.uTime.value = t;
    this.panel.position.y = 7 + Math.sin(t * 1.2) * 0.12;
  }
}

function compact(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n.toLocaleString('en-US');
}
function uptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
}

interface Lantern { phase: number; radius: number; height: number; speed: number; rise: number; born: number }

/** Lantern garden: every guestbook message floats a lantern around the island. */
export class Garden implements Landmark {
  readonly id = 'guestbook';
  readonly group = new THREE.Group();
  readonly hit: THREE.Object3D[];
  readonly labels: Label[] = [];
  readonly focus = { target: v3(16, 3, 33), offset: v3(22, 20, 32) };
  private lanterns: Lantern[] = [];
  private mesh: THREE.InstancedMesh;
  private max = 80;
  private m = new THREE.Matrix4();
  private halos = new Halos();
  private start: THREE.Vector3;

  constructor(_low: boolean) {
    const g = this.group;
    const [cx, cz] = SPOTS.guestbook.anchor;
    // Pavilion, pond and lantern tree are baked (build_garden); the lamp inside
    // the pavilion flares when someone signs, and their lantern rises from it.
    this.start = v3(cx, 2.4, cz);
    this.halos.add('pavilion', this.start, P.window, 5, 0.3);
    g.add(this.halos.group);
    // Lanterns: paper cylinders with a warm core.
    const geo = new THREE.CylinderGeometry(0.32, 0.26, 0.62, 8);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb36b').multiplyScalar(3.2), toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    g.add(this.mesh);
    this.labels.push({ text: 'Guestbook', pos: v3(cx, 6, cz), detail: false });
    this.hit = [hitBox(this.id, SPOTS.guestbook.rect, 8)];
    g.add(...this.hit);
  }

  /** Sets the lantern count from existing entries (oldest already aloft). */
  seed(n: number) {
    this.lanterns = [];
    for (let i = 0; i < Math.min(n, this.max); i++) this.add(true);
  }

  /** A new message: a lantern rises from the pavilion. */
  add(aloft = false) {
    if (this.lanterns.length >= this.max) this.lanterns.shift();
    const k = this.lanterns.length;
    this.lanterns.push({
      phase: Math.random() * Math.PI * 2,
      radius: 18 + ((k * 7) % 24) + Math.random() * 4,
      height: 12 + ((k * 3.7) % 12) + Math.random() * 2,
      speed: (0.02 + Math.random() * 0.025) * (k % 2 ? 1 : -1),
      rise: aloft ? 1 : 0,
      born: performance.now() / 1000,
    });
    if (!aloft) this.halos.pulse('pavilion');
  }

  update(dt: number, t: number) {
    const start = this.start;
    this.lanterns.forEach((l, i) => {
      l.rise = Math.min(1, l.rise + dt * 0.12);
      const a = l.phase + t * l.speed;
      const orbit = v3(Math.cos(a) * l.radius, l.height + Math.sin(t * 0.6 + l.phase) * 0.6, Math.sin(a) * l.radius);
      const e = 1 - Math.pow(1 - l.rise, 3);
      const p = start.clone().lerp(orbit, e);
      p.y += Math.sin(e * Math.PI) * 4;
      this.m.makeRotationY(t * 0.3 + l.phase).setPosition(p);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.count = this.lanterns.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halos.set('pavilion', 0.3 + Math.sin(t * 2) * 0.04);
    this.halos.update(dt);
  }
}
