// The two game districts, each with something that actually plays:
// a pool table with real 2D ball physics on the Pool Hall roof, and an
// endless runner on the Arcade roof (runner.ts). The halls and table are
// baked (build_poolhall / build_arcade); balls and cue live here.
import * as THREE from 'three';
import type { Project } from '../../config/types';
import type { Label, Landmark } from '../landmark';
import { SPOTS } from '../layout';
import { solid } from '../materials';
import { hitBox, textSign, v3 } from '../util';

interface Ball { x: number; z: number; vx: number; vz: number; mesh: THREE.Mesh; pocketed: boolean }

export class PoolHall implements Landmark {
  readonly id: string;
  readonly group = new THREE.Group();
  readonly hit: THREE.Object3D[];
  readonly labels: Label[] = [];
  readonly focus = { target: v3(-31, 4.5, -30), offset: v3(7, 15, 19) };
  /** The felt; the app raycasts it so a visitor can take a shot. */
  readonly table: THREE.Mesh;
  private balls: Ball[] = [];
  private W = 8;
  private D = 4.2;
  private R = 0.2;
  private origin: THREE.Vector3;
  private idle = 3;
  private cue: THREE.Mesh;
  private cueT = 0;
  private cueAngle = 0;

  constructor(p: Project, low: boolean) {
    this.id = p.id;
    const g = this.group;
    const [cx, cz] = SPOTS.poolhall.anchor;
    const Y0 = 0.36;
    const FELT = Y0 + 3.9 + 0.54; // baked felt top
    const sign = textSign('POOL', { height: 1.1, color: '#9fffe0' });
    sign.position.set(cx + 4.6, Y0 + 2.9, cz + 4.82);
    g.add(sign);
    this.origin = v3(cx, FELT, cz);
    // Invisible pick plane over the baked felt: tap it to shoot.
    // Live felt over the baked table: cloth, pockets and the head string, lit
    // like the balls on it. Also the surface visitors tap to take a shot.
    this.table = new THREE.Mesh(new THREE.PlaneGeometry(this.W, this.D).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: feltTexture(this.W, this.D), emissive: new THREE.Color('#0d5a3c'), emissiveIntensity: 0.35 }));
    this.origin.y += 0.012;
    this.table.position.copy(this.origin);
    this.table.userData.landmark = this.id;
    this.table.userData.pool = true;
    g.add(this.table);
    const colors = ['#f5f1e6', '#ffcf3a', '#2f6bff', '#ff4d5e', '#7b3fd6', '#ff8a2a', '#1fae6a', '#8a1f2a', '#151515'];
    colors.forEach((c) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(this.R, 14, 10), new THREE.MeshLambertMaterial({ color: new THREE.Color(c) }));
      g.add(m);
      this.balls.push({ x: 0, z: 0, vx: 0, vz: 0, mesh: m, pocketed: false });
    });
    this.cue = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 3.2, 8).rotateZ(Math.PI / 2).translate(-1.9, 0, 0), solid(new THREE.Color('#d9b48a')));
    g.add(this.cue);
    this.rack();
    this.labels.push({ text: 'Pool Hall', pos: v3(cx, 9.4, cz), detail: false });
    this.labels.push({ text: 'Tap the table to take a shot', pos: v3(cx, FELT + 1.4, cz + this.D / 2 + 0.8), detail: true });
    void low;
    this.hit = [hitBox(this.id, SPOTS.poolhall.rect, 9)];
    g.add(...this.hit);
  }

  private rack() {
    const [cue, ...rest] = this.balls;
    Object.assign(cue, { x: -this.W * 0.28, z: 0, vx: 0, vz: 0, pocketed: false });
    let k = 0;
    for (let row = 0; row < 4 && k < rest.length; row++) {
      for (let j = 0; j <= row && k < rest.length; j++, k++) {
        Object.assign(rest[k], { x: this.W * 0.18 + row * this.R * 1.8, z: (j - row / 2) * this.R * 2.05, vx: 0, vz: 0, pocketed: false });
      }
    }
    this.balls.forEach((b) => (b.mesh.visible = true));
  }

  /** Strike the cue ball toward a point on the table (table-local x,z). */
  strike(tx?: number, tz?: number) {
    const cue = this.balls[0];
    if (cue.pocketed) {
      Object.assign(cue, { x: -this.W * 0.28, z: 0, pocketed: false });
      cue.mesh.visible = true;
    }
    let dx: number, dz: number;
    if (tx === undefined || tz === undefined) {
      const target = this.balls.find((b, i) => i > 0 && !b.pocketed) ?? this.balls[1];
      dx = target.x - cue.x + (Math.random() - 0.5) * 0.3;
      dz = target.z - cue.z + (Math.random() - 0.5) * 0.3;
    } else {
      dx = tx - cue.x;
      dz = tz - cue.z;
    }
    const d = Math.hypot(dx, dz) || 1;
    const power = 7 + Math.random() * 3;
    cue.vx = (dx / d) * power;
    cue.vz = (dz / d) * power;
    this.cueAngle = Math.atan2(-dz, dx);
    this.cueT = 1;
  }

  /** Converts a world point on the felt to table-local coordinates and shoots. */
  strikeAtWorld(p: THREE.Vector3) {
    this.strike(p.x - this.origin.x, p.z - this.origin.z);
  }

  update(dt: number) {
    const h = Math.min(dt, 1 / 30) / 4;
    for (let s = 0; s < 4; s++) this.step(h);
    const moving = this.balls.some((b) => !b.pocketed && Math.hypot(b.vx, b.vz) > 0.02);
    if (!moving) {
      this.idle -= dt;
      if (this.balls.filter((b) => !b.pocketed).length <= 2) this.rack();
      if (this.idle <= 0) {
        this.idle = 6 + Math.random() * 4;
        this.strike();
      }
    }
    for (const b of this.balls) {
      b.mesh.position.set(this.origin.x + b.x, this.origin.y + this.R - 0.02, this.origin.z + b.z);
      b.mesh.rotation.z -= b.vx * dt * 3;
      b.mesh.rotation.x += b.vz * dt * 3;
    }
    const cue = this.balls[0];
    this.cueT = Math.max(0, this.cueT - dt * 2.5);
    this.cue.visible = this.cueT > 0;
    this.cue.position.set(this.origin.x + cue.x - Math.cos(this.cueAngle) * (0.3 + (1 - this.cueT) * 0.6), this.origin.y + 0.35, this.origin.z + cue.z + Math.sin(this.cueAngle) * (0.3 + (1 - this.cueT) * 0.6));
    this.cue.rotation.set(0, this.cueAngle, 0.12);
  }

  private step(h: number) {
    const hw = this.W / 2 - this.R, hd = this.D / 2 - this.R;
    for (const b of this.balls) {
      if (b.pocketed) continue;
      b.x += b.vx * h;
      b.z += b.vz * h;
      const f = Math.pow(0.62, h); // rolling friction
      b.vx *= f;
      b.vz *= f;
      if (Math.abs(b.x) > hw) { b.x = Math.sign(b.x) * hw; b.vx *= -0.85; }
      if (Math.abs(b.z) > hd) { b.z = Math.sign(b.z) * hd; b.vz *= -0.85; }
      for (const [px, pz] of [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1]]) {
        if (Math.hypot(b.x - (px * this.W) / 2 * 0.97, b.z - (pz * this.D) / 2 * 0.95) < 0.34) {
          b.pocketed = true;
          b.mesh.visible = false;
          b.vx = b.vz = 0;
        }
      }
    }
    // Elastic collisions between equal-mass balls.
    for (let i = 0; i < this.balls.length; i++) {
      for (let j = i + 1; j < this.balls.length; j++) {
        const a = this.balls[i], b = this.balls[j];
        if (a.pocketed || b.pocketed) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d === 0 || d >= this.R * 2) continue;
        const nx = dx / d, nz = dz / d;
        const overlap = this.R * 2 - d;
        a.x -= (nx * overlap) / 2; a.z -= (nz * overlap) / 2;
        b.x += (nx * overlap) / 2; b.z += (nz * overlap) / 2;
        const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (rel <= 0) continue;
        a.vx -= rel * nx; a.vz -= rel * nz;
        b.vx += rel * nx; b.vz += rel * nz;
      }
    }
  }
}

export { Arcade } from './runner';

function feltTexture(W: number, D: number): THREE.CanvasTexture {
  const px = 128;
  const c = document.createElement('canvas');
  c.width = W * px / 2;
  c.height = D * px / 2;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(c.width / 2, c.height / 2, 10, c.width / 2, c.height / 2, c.width * 0.6);
  grd.addColorStop(0, '#22b277');
  grd.addColorStop(1, '#13805a');
  g.fillStyle = grd;
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.lineWidth = 3;
  const hx = c.width * 0.22;
  g.beginPath();
  g.moveTo(hx, 0);
  g.lineTo(hx, c.height);
  g.stroke();
  g.beginPath();
  g.arc(hx, c.height / 2, c.height * 0.16, Math.PI / 2, -Math.PI / 2);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.beginPath();
  g.arc(c.width * 0.68, c.height / 2, 5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#05060c';
  for (const [px2, pz] of [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1]]) {
    g.beginPath();
    g.arc(c.width / 2 + (px2 * c.width) / 2 * 0.97, c.height / 2 + (pz * c.height) / 2 * 0.95, (0.32 / D) * c.height, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
