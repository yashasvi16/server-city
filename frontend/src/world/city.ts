// Loads the baked city (built and lit in Blender, see tools/blender) and
// gives it one cheap material: palette(uv0) x baked light, plus glowing
// windows/neon from an emissive mask. Ground and nature carry their light in
// lightmaps (uv1); buildings and props carry it per vertex corner (COLOR_0). No lights, no shadow maps: the
// lighting was computed offline by Cycles.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Imported as URLs: hashed files in the normal build, inlined in the single-file build.
import glbUrl from '../assets/city/city.glb?url';
import paletteUrl from '../assets/city/palette.png?url';
import emissiveUrl from '../assets/city/emissive.png?url';
import lmGroundUrl from '../assets/city/lm-ground.jpg?url';
import lmNatureUrl from '../assets/city/lm-nature.jpg?url';

/** Must match bake.py SCALE (irradiance was stored divided by it). */
const LM_SCALE = 2.0;

export interface CityLook {
  exposure: number; // multiplies the baked light
  emissive: number; // window / neon glow (HDR, feeds bloom)
}

export const DEFAULT_LOOK: CityLook = { exposure: 1.35, emissive: 3.6 };

function tex(loader: THREE.TextureLoader, url: string, srgb: boolean, nearest = false): Promise<THREE.Texture> {
  return new Promise((res, rej) =>
    loader.load(url, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.flipY = false;
      if (nearest) {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
      } else {
        // Lightmap atlases are packed tight; mipmaps would bleed the black
        // gaps between charts into every face at a distance.
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
      }
      res(t);
    }, undefined, rej),
  );
}

export class City {
  readonly group = new THREE.Group();
  private lmMats: THREE.MeshBasicMaterial[] = [];
  private vcMats: THREE.MeshBasicMaterial[] = [];
  private uniforms = {
    uEmit: { value: DEFAULT_LOOK.emissive },
    // Violet fill added to every surface so baked shadows read as dusk-tinted
    // rather than black (the folio-2025 trick of tinting, not darkening, shade).
    uShade: { value: new THREE.Color('#4a2f8a').multiplyScalar(0.22) },
  };

  static async load(onProgress?: (what: string) => void): Promise<City> {
    const city = new City();
    const tl = new THREE.TextureLoader();
    const gl = new GLTFLoader();
    gl.setMeshoptDecoder(MeshoptDecoder);
    const [gltf, palette, emissive, ...lms] = await Promise.all([
      gl.loadAsync(glbUrl).then((g) => (onProgress?.('city.glb'), g)),
      tex(tl, paletteUrl, true, true),
      tex(tl, emissiveUrl, false, true),
      ...[lmGroundUrl, lmNatureUrl].map((u) => tex(tl, u, true)),
    ]);
    const byChunk: Record<string, THREE.Texture> = { ground: lms[0], nature: lms[1] };
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const chunk = m.name.match(/lm_(\w+)/)?.[1] ?? '';
      m.material = m.geometry.hasAttribute('color')
        ? city.material(palette, emissive, null)
        : city.material(palette, emissive, byChunk[chunk] ?? lms[0]);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
    });
    city.group.add(gltf.scene);
    return city;
  }

  private material(palette: THREE.Texture, emissive: THREE.Texture, lightmap: THREE.Texture | null) {
    const m = new THREE.MeshBasicMaterial({ map: palette });
    if (lightmap) {
      lightmap.channel = 1;
      m.lightMap = lightmap;
      this.lmMats.push(m);
    } else {
      m.vertexColors = true;
      this.vcMats.push(m);
    }
    const u = this.uniforms;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uEmissiveMask = { value: emissive };
      sh.uniforms.uEmit = u.uEmit;
      sh.uniforms.uShade = u.uShade;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uEmissiveMask;\nuniform float uEmit;\nuniform vec3 uShade;')
        .replace(
          '#include <opaque_fragment>',
          `vec3 albedo = texture2D(map, vMapUv).rgb;
          outgoingLight += albedo * (uShade + texture2D(uEmissiveMask, vMapUv).r * uEmit);
          #include <opaque_fragment>`,
        );
    };
    m.customProgramCacheKey = () => (lightmap ? 'city-lm' : 'city-vc');
    this.setLook({ exposure: DEFAULT_LOOK.exposure });
    return m;
  }

  setLook(l: Partial<CityLook>) {
    if (l.emissive !== undefined) this.uniforms.uEmit.value = l.emissive;
    if (l.exposure !== undefined) {
      // three's basic material scales lightmaps by 1/π; vertex colours aren't.
      for (const m of this.lmMats) m.lightMapIntensity = LM_SCALE * Math.PI * l.exposure;
      for (const m of this.vcMats) m.color.setScalar(LM_SCALE * l.exposure);
    }
  }
}
