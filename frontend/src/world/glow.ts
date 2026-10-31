import * as THREE from 'three';

let _radial: THREE.Texture | null = null;
/** Soft white disc used for halos, light pools and avatar glows. */
export function radialTexture(): THREE.Texture {
  if (_radial) return _radial;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,.42)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 64, 64);
  _radial = new THREE.CanvasTexture(c);
  return _radial;
}

interface Halo { sprite: THREE.Sprite; color: THREE.Color; base: number; pulse: number; size: number }

/**
 * Halos that sit on the baked emissive parts (a sign, a lamp, a window) and
 * flare when a request reaches that architecture node. The baked city can't
 * change at runtime, so this is how its lights react.
 */
export class Halos {
  readonly group = new THREE.Group();
  private items = new Map<string, Halo>();

  add(id: string, pos: THREE.Vector3, color: THREE.Color, size = 2.4, base = 0.25) {
    const mat = new THREE.SpriteMaterial({
      map: radialTexture(), color: color.clone(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    this.group.add(s);
    this.items.set(id, { sprite: s, color: color.clone(), base, pulse: 0, size });
  }

  pulse(id: string) {
    const h = this.items.get(id);
    if (h) h.pulse = 1;
  }

  /** Manual level for lamps animated by the landmark itself (0..1+). */
  set(id: string, level: number) {
    const h = this.items.get(id);
    if (h) h.base = level;
  }

  update(dt: number) {
    for (const h of this.items.values()) {
      h.pulse = Math.max(0, h.pulse - dt * 1.2);
      const k = h.base + h.pulse * 2.2;
      (h.sprite.material as THREE.SpriteMaterial).color.copy(h.color).multiplyScalar(k);
      h.sprite.scale.setScalar(h.size * (1 + h.pulse * 0.6));
    }
  }
}
