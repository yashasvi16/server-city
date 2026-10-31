import * as THREE from 'three';
import type { Landmark } from '../world/landmark';

interface Item { el: HTMLElement; pos: THREE.Vector3; landmark: string; detail: boolean }

/** Crisp HTML labels pinned to 3D points. Detail labels show only for the
 *  landmark in focus; title labels show in explore mode. */
export class Labels {
  private items: Item[] = [];
  private v = new THREE.Vector3();
  focused: string | null = null;
  showTitles = false;
  hot: string | null = null;
  /** Tour mode: keep labels out of the text column. */
  avoidText = true;

  constructor(host: HTMLElement, landmarks: Landmark[]) {
    for (const l of landmarks) {
      for (const lb of l.labels) {
        const el = document.createElement('div');
        el.className = lb.detail ? 'lbl' : 'lbl title';
        el.textContent = lb.text;
        host.appendChild(el);
        this.items.push({ el, pos: lb.pos, landmark: l.id, detail: !!lb.detail });
      }
    }
  }

  update(camera: THREE.PerspectiveCamera) {
    const w = innerWidth, h = innerHeight;
    const boxes: [number, number, number, number][] = [];
    const small = w < 760;
    for (const it of this.items) {
      const want = it.detail ? it.landmark === this.focused : this.showTitles;
      if (!want) {
        it.el.classList.remove('on');
        continue;
      }
      this.v.copy(it.pos).project(camera);
      const sx = (this.v.x + 1) / 2, sy = (1 - this.v.y) / 2;
      const underText = this.avoidText && (w < 760 ? sy > 0.5 : sx < 0.47);
      const visible = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05 && sy > 0.08 && !underText;
      // Greedy overlap culling: earlier labels win.
      let free = visible;
      if (visible) {
        const px = sx * w, py = sy * h;
        const bw = it.el.textContent!.length * (small ? 6.2 : 7.4) + 20, bh = small ? 22 : 26;
        const b: [number, number, number, number] = [px - bw / 2, py - bh, px + bw / 2, py];
        free = b[0] > 4 && b[2] < w - 4 && !boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
        if (free) boxes.push(b);
      }
      it.el.classList.toggle('on', free);
      it.el.classList.toggle('hot', !it.detail && it.landmark === this.hot);
      if (free) it.el.style.transform = `translate3d(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px, 0) translate(-50%, -100%)`;
    }
  }
}
