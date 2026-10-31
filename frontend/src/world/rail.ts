import * as THREE from 'three';
import { emissive, solid } from './materials';
import { P } from './palette';

/** Polyline with rounded corners as a single arc-length-parameterized curve. */
export function filletPath(pts: THREE.Vector3[], radius = 1.6): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  if (pts.length < 2) {
    path.add(new THREE.LineCurve3(pts[0], pts[0].clone().add(new THREE.Vector3(0.001, 0, 0))));
    return path;
  }
  let cur = pts[0].clone();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const inDir = b.clone().sub(a).normalize(), outDir = c.clone().sub(b).normalize();
    const r = Math.min(radius, a.distanceTo(b) / 2, b.distanceTo(c) / 2);
    const p1 = b.clone().addScaledVector(inDir, -r), p2 = b.clone().addScaledVector(outDir, r);
    if (cur.distanceTo(p1) > 1e-4) path.add(new THREE.LineCurve3(cur, p1));
    path.add(new THREE.QuadraticBezierCurve3(p1, b.clone(), p2));
    cur = p2;
  }
  path.add(new THREE.LineCurve3(cur, pts[pts.length - 1].clone()));
  return path;
}

/** A short train that follows a curve by distance; cars trail behind. */
export class Train {
  readonly group = new THREE.Group();
  private cars: THREE.Group[] = [];
  private stripeMat: THREE.MeshBasicMaterial;
  private headMat: THREE.MeshBasicMaterial;
  private curve: THREE.Curve<THREE.Vector3> | null = null;
  private len = 0;
  private dist = 0;
  private trail: { curve: THREE.Curve<THREE.Vector3>; len: number }[] = []; // previous curves, for cars behind
  speed = 9;
  onArrive: (() => void) | null = null;
  moving = false;

  constructor(cars = 3, color = P.sodium) {
    this.stripeMat = emissive(color, 3.2);
    this.headMat = emissive(P.white, 6);
    const bodyMat = solid(new THREE.Color('#e4e2f2'));
    const roofMat = solid(new THREE.Color('#3b3f6b'));
    for (let i = 0; i < cars; i++) {
      const car = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.85, 1.15), bodyMat);
      body.position.y = 0.62;
            const roof = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.16, 1.05), roofMat);
      roof.position.y = 1.1;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.14, 1.18), this.stripeMat);
      stripe.position.y = 0.72;
      car.add(body, roof, stripe);
      if (i === 0) {
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), this.headMat);
        lamp.position.set(1.03, 0.55, 0);
        car.add(lamp);
      }
      this.cars.push(car);
      this.group.add(car);
    }
  }

  setColor(c: THREE.Color) {
    this.stripeMat.color.copy(c).multiplyScalar(3.2);
  }

  place(curve: THREE.Curve<THREE.Vector3>, atStart = true) {
    this.trail = [];
    this.curve = curve;
    this.len = curve.getLength();
    this.dist = atStart ? 0 : this.len;
    this.moving = false;
    this.pose();
  }

  /** Continue onto a new curve (whose start is where we are). */
  go(curve: THREE.Curve<THREE.Vector3>, onArrive: () => void) {
    if (this.curve) this.trail.unshift({ curve: this.curve, len: this.len });
    this.trail.length = Math.min(this.trail.length, 3);
    this.curve = curve;
    this.len = curve.getLength();
    this.dist = 0;
    this.onArrive = onArrive;
    this.moving = true;
  }

  /** Point at `d` units behind the head, walking back through previous curves. */
  private pointBehind(d: number, out: THREE.Vector3, tan: THREE.Vector3) {
    let s = this.dist - d;
    if (s >= 0 || !this.trail.length) {
      const u = THREE.MathUtils.clamp(s / this.len, 0, 1);
      this.curve!.getPointAt(u, out);
      this.curve!.getTangentAt(u, tan);
      return;
    }
    for (const seg of this.trail) {
      s += seg.len;
      if (s >= 0) {
        const u = THREE.MathUtils.clamp(s / seg.len, 0, 1);
        seg.curve.getPointAt(u, out);
        seg.curve.getTangentAt(u, tan);
        return;
      }
    }
    const last = this.trail[this.trail.length - 1];
    last.curve.getPointAt(0, out);
    last.curve.getTangentAt(0, tan);
  }

  private pose() {
    if (!this.curve) return;
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    this.cars.forEach((car, i) => {
      this.pointBehind(i * 2.25, p, t);
      car.position.set(p.x, p.y, p.z);
      car.rotation.y = Math.atan2(-t.z, t.x);
    });
  }

  update(dt: number) {
    if (!this.curve) return;
    if (this.moving) {
      this.dist += this.speed * dt;
      if (this.dist >= this.len) {
        this.dist = this.len;
        this.moving = false;
        const cb = this.onArrive;
        this.onArrive = null;
        cb?.();
      }
    }
    this.pose();
  }
}
