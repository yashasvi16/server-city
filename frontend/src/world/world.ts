// Assembles the island: the baked city (static, lit offline in Blender) plus
// the live layer on top of it. The experience layer drives the camera and
// talks to landmarks through the Landmark interface.
import * as THREE from 'three';
import { site } from '../config/site.config';
import { Avatars } from './avatars';
import { City } from './city';
import type { Landmark } from './landmark';
import { BILLBOARD_AT } from './layout';
import { Arena } from './landmarks/arena';
import { Arcade, PoolHall } from './landmarks/games';
import { Garden, Hologram } from './landmarks/plaza';
import { Station } from './landmarks/station';
import { Vault } from './landmarks/vault';
import { Stage, type Tier } from './stage';

export class World {
  readonly landmarks: Landmark[] = [];
  readonly byId = new Map<string, Landmark>();
  readonly hologram = new Hologram();
  readonly garden: Garden;
  readonly avatars = new Avatars();
  readonly pool: PoolHall | undefined;
  readonly hits: THREE.Object3D[] = [];

  static async create(host: HTMLElement, tier: Tier, onProgress?: (what: string) => void): Promise<World> {
    const stage = new Stage(host, tier);
    const city = await City.load(onProgress);
    return new World(stage, city, tier);
  }

  private constructor(readonly stage: Stage, readonly city: City, tier: Tier) {
    const s = stage.scene;
    s.add(city.group);
    for (const p of site.projects) {
      let l: Landmark;
      switch (p.district.kind) {
        case 'station': l = new Station(p, tier.low); break;
        case 'vault': l = new Vault(p, tier.low); break;
        case 'arena': l = new Arena(p, tier.low); break;
        case 'poolhall': l = this.pool = new PoolHall(p, tier.low) as PoolHall; break;
        case 'arcade': l = new Arcade(p, tier.low); break;
      }
      this.add(l);
    }
    this.garden = new Garden(tier.low);
    this.add(this.garden);
    this.hologram.group.position.set(BILLBOARD_AT[0], 0.36 + 0.7, BILLBOARD_AT[1]);
    this.hologram.group.rotation.y = 0.25;
    s.add(this.hologram.group, this.avatars.group);
  }

  private add(l: Landmark) {
    this.landmarks.push(l);
    this.byId.set(l.id, l);
    this.stage.scene.add(l.group);
    for (const h of l.hit) this.hits.push(h);
  }

  update(dt: number, t: number) {
    for (const l of this.landmarks) l.update(dt, t);
    this.hologram.update(t);
    this.avatars.update(dt, t);
  }

  render(dt: number, t: number) {
    this.stage.render(dt, t);
  }
}
