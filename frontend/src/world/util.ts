import * as THREE from 'three';

/** Deterministic PRNG (mulberry32) so the island is identical on every load. */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const damp = (a: number, b: number, lambda: number, dt: number) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));

/** A flat glowing sign with text (neon/backlit), drawn once to a canvas. */
export function textSign(text: string, opts: { height?: number; color?: string; bg?: string | null; font?: string; glow?: number } = {}): THREE.Mesh {
  const { height = 1, color = '#ffd29a', bg = '#140f2a', font = "800 96px 'Unbounded Variable', 'Arial Black', sans-serif", glow = 1.8 } = opts;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 80;
  c.width = w;
  c.height = 150;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: !bg, toneMapped: false, color: new THREE.Color(glow, glow, glow) });
  return new THREE.Mesh(new THREE.PlaneGeometry((height * c.width) / c.height, height), mat);
}

/** Invisible picking volume for a landmark. */
export function hitBox(id: string, rect: [number, number, number, number], h: number): THREE.Mesh {
  const [a, b, c, d] = rect;
  const m = new THREE.Mesh(new THREE.BoxGeometry(c - a, h, d - b), new THREE.MeshBasicMaterial({ visible: false }));
  m.position.set((a + c) / 2, h / 2, (b + d) / 2);
  m.userData.landmark = id;
  return m;
}
