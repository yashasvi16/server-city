import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Landmark } from '../world/landmark';
import { DECK, WORLD_HALF } from '../world/layout';
import { easeInOut, v3 } from '../world/util';

export interface Pose { pos: THREE.Vector3; target: THREE.Vector3 }

const narrow = () => innerWidth < 760;

/** Frames `target` from `offset`, shifted so the subject sits beside the
 *  text column (desktop) or above the text (phones). */
export function framePose(target: THREE.Vector3, offset: THREE.Vector3, shift = 1): Pose {
  const off = offset.clone();
  if (narrow()) off.multiplyScalar(1.75); // portrait screens need more distance
  const pos = target.clone().add(off);
  const fwd = target.clone().sub(pos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const dist = off.length();
  const t = target.clone();
  if (narrow()) t.addScaledVector(up, -0.09 * dist * shift);
  else t.addScaledVector(right, -0.2 * dist * shift);
  return { pos: pos.add(t.clone().sub(target)), target: t };
}

export const HERO_POSE = () => framePose(v3(2, -6, 2), v3(72, 56, 118), 1.15);
export const ABOUT_POSE = () => framePose(v3(4, -2, -4), v3(-112, 44, 74), 0.8);
export const INTRO_POSE: Pose = { pos: v3(240, 170, 420), target: v3(0, 20, 0) };

/** The tour chapter about the game: the deck beside the island. */
export const DEFENSE_POSE = () => framePose(v3(DECK.x + 2, -2, DECK.z - 2), v3(-40, 72, 108), 0.9);

/**
 * Playing: frame the whole deck. Landscape screens look across it from the
 * south; portrait phones look along it from the east so the long road runs
 * down the screen. Distance is fitted to the screen, leaving room for the
 * HUD bars at the top and bottom.
 */
export function gamePose(camera: THREE.PerspectiveCamera): Pose {
  const aspect = innerWidth / innerHeight;
  const portrait = aspect < 0.9;
  const vf = THREE.MathUtils.degToRad(camera.fov);
  const tanV = Math.tan(vf / 2), tanH = tanV * aspect;
  const W = DECK.cols * DECK.cell + 14, D = DECK.rows * DECK.cell + 4; // board + gate + data centre
  const across = portrait ? D : W, along = portrait ? W : D;
  const tilt = portrait ? 1.08 : 0.92; // radians down from horizontal
  const usable = portrait ? 0.62 : 0.7; // share of the height left between the HUD bars
  const d = Math.max(across / 2 / tanH / 0.92, (along * Math.sin(tilt)) / 2 / tanV / usable);
  const target = v3(DECK.x + 2.5, 0, DECK.z + (portrait ? 0 : 1.2));
  const dir = portrait ? v3(Math.cos(tilt), Math.sin(tilt), 0) : v3(0, Math.sin(tilt), Math.cos(tilt));
  // nudge the board up a little: the tower bar takes more room than the stats
  target.addScaledVector(portrait ? v3(1, 0, 0) : v3(0, 0, 1), d * 0.045);
  return { pos: target.clone().addScaledVector(dir, d), target };
}

/** Drives the camera: scroll-linked tour, a fly-in, or free orbit. */
export class CameraRig {
  readonly controls: OrbitControls;
  private tour: Pose[] = [];
  private progress = 0;
  private cur: Pose;
  private flight: { from: Pose; to: Pose; t: number; dur: number; done?: () => void } | null = null;
  private pointer = new THREE.Vector2();
  mode: 'tour' | 'explore' | 'game' = 'tour';
  private gameHold: Pose | null = null;
  reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 260;
    this.controls.maxPolarAngle = 1.32;
    this.controls.screenSpacePanning = false;
    this.cur = { pos: INTRO_POSE.pos.clone(), target: INTRO_POSE.target.clone() };
    camera.position.copy(this.cur.pos);
    camera.lookAt(this.cur.target);
    addEventListener('pointermove', (e) => this.pointer.set(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5), { passive: true });
  }

  setTour(poses: Pose[]) {
    this.tour = poses;
  }

  setProgress(p: number) {
    this.progress = p;
  }

  /** Pose for the current scroll progress (between chapter keyframes). */
  private tourPose(): Pose {
    const n = this.tour.length;
    if (!n) return this.cur;
    const p = THREE.MathUtils.clamp(this.progress, 0, n - 1);
    const i = Math.floor(p), f = p - i;
    const a = this.tour[i], b = this.tour[Math.min(i + 1, n - 1)];
    // Hold on each chapter for a while, then travel.
    const k = easeInOut(THREE.MathUtils.smoothstep(f, 0.3, 0.85));
    const pos = a.pos.clone().lerp(b.pos, k);
    const target = a.target.clone().lerp(b.target, k);
    // Lift the camera mid-flight so moves arc over the island.
    pos.y += Math.sin(k * Math.PI) * a.pos.distanceTo(b.pos) * 0.12;
    return { pos, target };
  }

  fly(to: Pose, dur: number, done?: () => void) {
    if (this.reduceMotion) {
      this.cur = { pos: to.pos.clone(), target: to.target.clone() };
      done?.();
      return;
    }
    this.flight = { from: { pos: this.camera.position.clone(), target: this.cur.target.clone() }, to, t: 0, dur, done };
  }

  /** Stop an in-progress flight where it is (e.g. the visitor scrolled). */
  interrupt() {
    if (!this.flight || this.mode !== 'tour') return;
    this.flight = null;
    this.cur = { pos: this.camera.position.clone(), target: this.cur.target.clone() };
  }

  enterExplore(start: Pose) {
    this.mode = 'explore';
    this.flight = null;
    this.camera.position.copy(start.pos);
    this.controls.target.copy(start.target);
    this.controls.enabled = true;
    this.controls.update();
  }

  leaveExplore() {
    this.mode = 'tour';
    this.controls.enabled = false;
    this.cur = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  /** Game mode: fly to the deck and hold the camera there. */
  enterGame(pose: Pose) {
    if (this.mode === 'explore') this.leaveExplore();
    this.mode = 'game';
    this.gameHold = pose;
    this.fly(pose, 2.0);
  }

  /** Re-fit after a resize, without a flight. */
  setGamePose(pose: Pose) {
    this.gameHold = pose;
    if (!this.flight) this.cur = { pos: pose.pos.clone(), target: pose.target.clone() };
  }

  leaveGame() {
    this.mode = 'tour';
    this.gameHold = null;
    this.flight = null;
    this.cur = { pos: this.camera.position.clone(), target: this.cur.target.clone() };
  }

  /** Explore mode: glide to a landmark, then keep orbiting around it. */
  focusLandmark(l: Landmark, sheetFrac = 0) {
    let to = framePose(l.focus.target, l.focus.offset, 0.4);
    if (sheetFrac > 0 && sheetFrac < 0.75) {
      // A panel covers the right `sheetFrac` of the screen: pull back a little
      // and slide the view so the building is centred in what's left.
      const off = l.focus.offset.clone().multiplyScalar(1 + sheetFrac * 0.6);
      const pos = l.focus.target.clone().add(off);
      const dist = off.length();
      const fwd = l.focus.target.clone().sub(pos).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
      const slide = right.multiplyScalar(sheetFrac * tanH * dist);
      to = { pos: pos.add(slide), target: l.focus.target.clone().add(slide) };
    }
    this.flight = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone() }, to, t: 0, dur: 1.4 };
  }

  get target(): THREE.Vector3 {
    return this.mode === 'explore' ? this.controls.target : this.cur.target;
  }

  update(dt: number, t: number) {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = easeInOut(f.t);
      const pos = f.from.pos.clone().lerp(f.to.pos, k);
      pos.y += Math.sin(k * Math.PI) * f.from.pos.distanceTo(f.to.pos) * 0.08;
      const tgt = f.from.target.clone().lerp(f.to.target, k);
      this.camera.position.copy(pos);
      if (this.mode === 'explore') this.controls.target.copy(tgt);
      else this.cur.target.copy(tgt);
      this.camera.lookAt(tgt);
      if (f.t >= 1) {
        this.flight = null;
        this.cur = { pos: pos.clone(), target: tgt.clone() };
        f.done?.();
      }
      return;
    }
    if (this.mode === 'game' && this.gameHold) {
      const k = 1 - Math.exp(-6 * dt);
      this.cur.pos.lerp(this.gameHold.pos, k);
      this.cur.target.lerp(this.gameHold.target, k);
      this.camera.position.copy(this.cur.pos);
      this.camera.lookAt(this.cur.target);
      return;
    }
    if (this.mode === 'explore') {
      this.controls.update();
      const tg = this.controls.target;
      tg.x = THREE.MathUtils.clamp(tg.x, -WORLD_HALF, DECK.x + DECK.cols * DECK.cell * 0.6); // the island and the game deck
      tg.z = THREE.MathUtils.clamp(tg.z, -WORLD_HALF, WORLD_HALF);
      tg.y = THREE.MathUtils.clamp(tg.y, -5, 20);
      return;
    }
    // Tour: ease toward the scroll pose; a little pointer parallax for life.
    const goal = this.tourPose();
    const lambda = this.reduceMotion ? 50 : 3.2;
    const k = 1 - Math.exp(-lambda * dt);
    this.cur.pos.lerp(goal.pos, k);
    this.cur.target.lerp(goal.target, k);
    this.camera.position.copy(this.cur.pos);
    if (!this.reduceMotion) {
      const d = this.cur.pos.distanceTo(this.cur.target);
      this.camera.position.x += this.pointer.x * d * 0.03;
      this.camera.position.y += -this.pointer.y * d * 0.02 + Math.sin(t * 0.25) * d * 0.004;
    }
    this.camera.lookAt(this.cur.target);
  }
}
