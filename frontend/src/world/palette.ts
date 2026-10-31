// Blue hour over a floating server city. One palette for scene and UI.
import * as THREE from 'three';

export const P = {
  // sky, top to horizon
  zenith: new THREE.Color('#070a1f'),
  upper: new THREE.Color('#141a4a'),
  mid: new THREE.Color('#34306e'),
  horizon: new THREE.Color('#e0794f'),
  sun: new THREE.Color('#ffb36b'),
  // world
  rock: new THREE.Color('#1a1830'),
  rockDeep: new THREE.Color('#0b0a18'),
  ground: new THREE.Color('#2b2d55'),
  road: new THREE.Color('#1a1e3f'),
  mass: new THREE.Color('#353d78'),
  massWarm: new THREE.Color('#4a3f73'),
  trim: new THREE.Color('#8c93c4'),
  tree: new THREE.Color('#1d4a4a'),
  // light
  sodium: new THREE.Color('#ffa63d'),
  window: new THREE.Color('#ffc37a'),
  windowCool: new THREE.Color('#9fb6ff'),
  phosphor: new THREE.Color('#5ff2d3'),
  signal: new THREE.Color('#ff4d5e'),
  white: new THREE.Color('#fff4e6'),
};

/** Emissive color pushed above 1 so bloom picks it up. */
export function glow(c: THREE.Color, intensity: number): THREE.Color {
  return c.clone().multiplyScalar(intensity);
}
