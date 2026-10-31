import * as THREE from 'three';

// Materials for the few moving things on top of the baked city. The city
// itself is unlit (lighting was baked in Blender); these use Lambert under a
// purple sky fill and a warm key light so they sit in the same dusk, with
// shadow sides tinted violet rather than greyed out (the trick Bruno Simon's
// folio uses for its stylised look).

/** Plain unlit colour for bloom sources (lamps, rails, signs). */
export function emissive(color: THREE.Color, intensity = 3): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(intensity), toneMapped: false });
}

const cache = new Map<string, THREE.MeshLambertMaterial>();
/** Flat-shaded matte surface; shared per colour. */
export function solid(color: THREE.Color): THREE.MeshLambertMaterial {
  const key = color.getHexString();
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    cache.set(key, m);
  }
  return m;
}
