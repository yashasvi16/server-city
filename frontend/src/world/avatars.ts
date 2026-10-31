import * as THREE from 'three';
import type { Peer } from '../net/backend';
import { radialTexture } from './glow';
import { P } from './palette';

interface Avatar { group: THREE.Group; label: THREE.Sprite; name: string; target: THREE.Vector3; ghost: boolean }

const BODY = new THREE.CapsuleGeometry(0.32, 0.7, 4, 8).translate(0, 0.75, 0);

function nameSprite(text: string, ghost: boolean): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = "500 44px 'IBM Plex Sans', system-ui, sans-serif";
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 36;
  c.height = 64;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10, 12, 32, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 4, c.width, 56, 28);
  ctx.fill();
  ctx.fillStyle = ghost ? '#b7bde6' : '#f4f1ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set((0.55 * c.width) / c.height, 0.55, 1);
  s.renderOrder = 30;
  return s;
}

/** Other visitors, standing where they are looking. */
export class Avatars {
  readonly group = new THREE.Group();
  private all = new Map<string, Avatar>();
  private selfId: string | null = null;

  get count() {
    return this.all.size;
  }

  setSelf(id: string | null) {
    this.selfId = id;
    if (id) this.remove(id);
  }

  upsert(p: Partial<Peer> & { id: string }) {
    if (p.id === this.selfId) return;
    let a = this.all.get(p.id);
    if (!a) {
      if (p.x === undefined || p.z === undefined) return;
      const ghost = !!p.ghost;
      const color = new THREE.Color().setHSL(((p.hue ?? 200) % 360) / 360, 0.7, 0.62);
      const group = new THREE.Group();
      const body = new THREE.Mesh(BODY, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(ghost ? 1.2 : 2.2), transparent: ghost, opacity: ghost ? 0.6 : 1, toneMapped: false }));
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTexture(), color: color.clone().multiplyScalar(0.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      pool.position.y = 0.09;
      const label = nameSprite(p.name ?? 'visitor', ghost);
      label.position.y = 2.3;
      group.add(body, pool, label);
      group.position.set(p.x, 0, p.z);
      this.group.add(group);
      a = { group, label, name: p.name ?? 'visitor', target: new THREE.Vector3(p.x, 0, p.z), ghost };
      this.all.set(p.id, a);
    }
    if (p.x !== undefined && p.z !== undefined) a.target.set(p.x, 0, p.z);
    if (p.name && p.name !== a.name) {
      a.group.remove(a.label);
      (a.label.material as THREE.SpriteMaterial).map?.dispose();
      a.label = nameSprite(p.name, a.ghost);
      a.label.position.y = 2.3;
      a.group.add(a.label);
      a.name = p.name;
    }
  }

  remove(id: string) {
    const a = this.all.get(id);
    if (!a) return;
    this.group.remove(a.group);
    (a.label.material as THREE.SpriteMaterial).map?.dispose();
    this.all.delete(id);
  }

  update(dt: number, t: number) {
    const k = 1 - Math.exp(-dt * 5);
    for (const a of this.all.values()) {
      a.group.position.lerp(a.target, k);
      a.group.children[0].position.y = Math.abs(Math.sin(t * 6 + a.group.position.x)) * 0.08;
    }
  }
}

export const SELF_COLOR = P.sodium;
