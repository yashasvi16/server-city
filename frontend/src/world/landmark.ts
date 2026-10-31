import type * as THREE from 'three';

export interface Label {
  text: string;
  pos: THREE.Vector3;
  /** Shown only while this landmark is focused (detail labels). */
  detail?: boolean;
}

export interface FlowCallbacks {
  onStep(i: number): void;
  onDone(): void;
}

/** A project's building(s) on the island. */
export interface Landmark {
  id: string; // project id from site.config.ts, or 'guestbook'
  group: THREE.Group;
  /** Invisible meshes used for picking. */
  hit: THREE.Object3D[];
  /** Point the camera frames when this landmark is focused. */
  focus: { target: THREE.Vector3; offset: THREE.Vector3 };
  labels: Label[];
  update(dt: number, t: number): void;
  setFocused?(on: boolean): void;
  playFlow?(index: number, cb: FlowCallbacks): void;
  stopFlow?(): void;
}
