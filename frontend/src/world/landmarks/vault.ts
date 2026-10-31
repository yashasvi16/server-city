// Data Vault: Game Vault as a round bank vault (Postgres), a Redis tower with
// spinning cache rings, a Chi API office with one lamp per endpoint, and a
// WebSocket mast that pulses when the leaderboard changes. Buildings are baked
// (build_vault in the Blender build); the door, rings, waves and halos live here.
import * as THREE from 'three';
import type { Project } from '../../config/types';
import { CourierFlow } from '../courier';
import { Halos } from '../glow';
import type { FlowCallbacks, Label, Landmark } from '../landmark';
import { SPOTS } from '../layout';
import { emissive, solid } from '../materials';
import { P } from '../palette';
import { hitBox, v3 } from '../util';

const REDIS = new THREE.Color('#ff5a4f');
const Y0 = 0.36;
const VAULT = v3(-39, 0, -1);
const TOWER = v3(-46, 0, -9);
const API = v3(-32, 0, 8);
const AUTH = v3(-27.5, 0, 12.5);
const MAST_TIP = v3(API.x + 1.6, Y0 + 4.85 + 3.5, API.z - 1);

export class Vault implements Landmark {
  readonly id: string;
  readonly group = new THREE.Group();
  readonly hit: THREE.Object3D[];
  readonly labels: Label[] = [];
  readonly focus = { target: v3(-37, 2, 2), offset: v3(16, 26, 38) };
  private rings: THREE.Mesh[] = [];
  private wheel = new THREE.Group();
  private door = new THREE.Group();
  private waves: { m: THREE.Mesh; t: number }[] = [];
  private halos = new Halos();
  private flow: CourierFlow;
  private ringBoost = 0;
  private doorOpen = 0;

  constructor(private p: Project, _low: boolean) {
    this.id = p.id;
    const g = this.group;
    const nl = (k: string, d: string) => p.nodes?.[k]?.label ?? d;

    // Vault door: a steel plate with bolts and a hand wheel, set in the baked frame.
    const steel = solid(new THREE.Color('#a4a9d0'));
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.35, 32).rotateX(Math.PI / 2), steel);
    for (let i = 0; i < 12; i++) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 6).rotateX(Math.PI / 2), solid(new THREE.Color('#6d72a0')));
      const a = (i / 12) * Math.PI * 2;
      bolt.position.set(Math.cos(a) * 1.95, Math.sin(a) * 1.95, 0.22);
      plate.add(bolt);
    }
    const white = solid(new THREE.Color('#f1ecdf'));
    this.wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.08, 6, 24), white));
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.1), white);
      spoke.rotation.z = (i * Math.PI) / 3;
      this.wheel.add(spoke);
    }
    this.wheel.position.z = 0.3;
    this.door.add(plate, this.wheel);
    const doorAt = v3(VAULT.x, Y0 + 2.7, VAULT.z + 6.3);
    this.door.position.copy(doorAt);
    g.add(this.door);
    this.halos.add('vault', doorAt.clone().setZ(doorAt.z + 0.4), P.sodium, 7, 0.12);
    this.labels.push({ text: 'Data Vault', pos: v3(VAULT.x, 9, VAULT.z), detail: false });
    this.labels.push({ text: nl('vault', 'PostgreSQL'), pos: v3(VAULT.x, 7.4, VAULT.z + 4), detail: true });

    // Redis tower: floating cache rings and a beacon.
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.5 - i * 0.12, 0.09, 6, 40), emissive(i % 2 ? REDIS : P.sodium, 2.2));
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      this.rings.push(ring);
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 10), emissive(REDIS, 4));
    beacon.position.set(TOWER.x, Y0 + 17.2, TOWER.z);
    g.add(beacon);
    this.halos.add('cache', beacon.position, REDIS, 4, 0.4);
    this.labels.push({ text: nl('cache', 'Redis cache'), pos: v3(TOWER.x, 19, TOWER.z), detail: true });

    // API office lamps (baked) and the WebSocket mast tip.
    this.halos.add('api', v3(API.x, Y0 + 4.1, API.z + 2.4), P.phosphor, 5, 0.15);
    this.labels.push({ text: nl('api', 'API'), pos: v3(API.x, 6.6, API.z), detail: true });
    this.halos.add('auth', v3(AUTH.x, Y0 + 2.8, AUTH.z + 0.3), P.windowCool, 3.2, 0.25);
    this.labels.push({ text: nl('auth', 'Auth'), pos: v3(AUTH.x, 4.4, AUTH.z), detail: true });
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), emissive(P.phosphor, 3));
    tip.position.copy(MAST_TIP);
    g.add(tip);
    this.halos.add('hub', MAST_TIP, P.phosphor, 2.2, 0.3);
    this.labels.push({ text: nl('hub', 'WebSocket hub'), pos: MAST_TIP.clone().setY(MAST_TIP.y + 1.2), detail: true });
    g.add(this.halos.group);

    const nodes: Record<string, THREE.Vector3> = {
      auth: v3(AUTH.x, 1.8, AUTH.z + 0.6),
      api: v3(API.x, 2.6, API.z + 2.6),
      cache: v3(TOWER.x, 7, TOWER.z + 2.6),
      vault: v3(VAULT.x, 2.9, VAULT.z + 7.2),
      hub: MAST_TIP.clone(),
    };
    this.flow = new CourierFlow(nodes, (n) => this.pulse(n));
    g.add(this.flow.courier.group);

    this.hit = [hitBox(this.id, SPOTS.vault.rect, 14)];
    g.add(...this.hit);
  }

  private pulse(n: string) {
    this.halos.pulse(n);
    if (n === 'cache') this.ringBoost = 1;
    if (n === 'vault') this.doorOpen = 1;
    if (n === 'hub') this.emitWave();
  }

  private emitWave() {
    const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 48), emissive(P.phosphor, 2));
    m.rotation.x = Math.PI / 2;
    m.position.copy(MAST_TIP);
    this.group.add(m);
    this.waves.push({ m, t: 0 });
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
    this.ringBoost = Math.max(0, this.ringBoost - dt * 0.5);
    this.rings.forEach((r, i) => {
      r.rotation.z += dt * (0.4 + i * 0.15) * (i % 2 ? -1 : 1) * (1 + this.ringBoost * 6);
      r.position.set(TOWER.x, Y0 + 5 + i * 2.8 + Math.sin(t * 1.3 + i) * 0.18, TOWER.z);
    });
    this.wheel.rotation.z = Math.sin(t * 0.5) * 0.3 + this.doorOpen * 2;
    this.doorOpen = Math.max(0, this.doorOpen - dt * 0.35);
    this.door.position.z = VAULT.z + 6.3 + this.doorOpen * 0.6;
    this.halos.update(dt);
    if (Math.random() < dt * 0.08) this.emitWave(); // idle broadcast now and then
    this.waves = this.waves.filter((w) => {
      w.t += dt * 0.7;
      w.m.scale.setScalar(1 + w.t * 9);
      (w.m.material as THREE.MeshBasicMaterial).color.copy(P.phosphor).multiplyScalar(2 * (1 - w.t));
      if (w.t >= 1) {
        this.group.remove(w.m);
        w.m.geometry.dispose();
        (w.m.material as THREE.Material).dispose();
        return false;
      }
      return true;
    });
  }
}
