import * as THREE from 'three';
import {
  BlendFunction, BloomEffect, EffectComposer, EffectPass, KernelSize, NoiseEffect, RenderPass,
  SMAAEffect, TiltShiftEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';
import { P } from './palette';
import { makeCloudSea, makeSky, SUN_DIR } from './sky';

export interface Tier {
  low: boolean;
  pixelRatio: number;
  shadows: boolean;
  bloom: boolean;
  msaa: number;
}

export function pickTier(): Tier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const forced = new URLSearchParams(location.search).get('quality');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const low = forced ? forced === 'low' : coarse || (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  return {
    low,
    pixelRatio: Math.min(devicePixelRatio || 1, low ? 1.25 : 2),
    shadows: false, // the city's shadows are baked
    bloom: true, // mipmap bloom is cheap enough; strength is reduced on low
    msaa: low ? 0 : 4,
  };
}

/** Renderer, post-processing, lights, sky. Everything else adds to `scene`. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly key: THREE.DirectionalLight;
  private skyUpdate: (t: number) => void;
  private bloom: BloomEffect;
  private tilt: TiltShiftEffect | null = null;
  private tiltAmount = 1;

  constructor(host: HTMLElement, readonly tier: Tier) {
    const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    r.setPixelRatio(tier.pixelRatio);
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.NoToneMapping; // done in post
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = tier.shadows;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(r.domElement);
    this.renderer = r;

    this.camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 1, 2400);

    this.scene.fog = new THREE.FogExp2(P.mid.clone().lerp(P.upper, 0.4), 0.0024);
    this.scene.background = P.zenith.clone();

    const sky = makeSky();
    const sea = makeCloudSea();
    this.scene.add(sky.mesh, sky.stars, sea.mesh);
    this.skyUpdate = (t) => {
      sky.update(t);
      sea.update(t);
    };

    // Light for the live layer only (trains, jets, balls, the bull). The city
    // is unlit; these match the baked dusk: violet sky fill, warm low sun.
    this.scene.add(new THREE.HemisphereLight(new THREE.Color('#8a7cff'), new THREE.Color('#5a2a3a'), 1.5));
    const key = new THREE.DirectionalLight(new THREE.Color('#ffa070'), 2.6);
    key.position.copy(SUN_DIR).multiplyScalar(140);
    this.scene.add(key, key.target);
    this.key = key;

    // Post: bloom on everything that glows above 1.0, filmic tone mapping,
    // a little vignette and grain so it reads as a photograph, not a render.
    this.composer = new EffectComposer(r, { multisampling: tier.msaa, frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({
      mipmapBlur: true, luminanceThreshold: 0.9, luminanceSmoothing: 0.3,
      intensity: tier.low ? 1.0 : 1.25, radius: 0.72,
    });
    if (tier.low) this.bloom.resolution.scale = 0.5; // half-res bloom on phones
    const effects: ConstructorParameters<typeof EffectPass>[1][] = [this.bloom];
    // Miniature look: a soft blur band at the top and bottom of the frame.
    if (!tier.low) {
      this.tilt = new TiltShiftEffect({ focusArea: 0.55, feather: 0.35, kernelSize: KernelSize.MEDIUM, resolutionScale: 0.5 });
      effects.push(this.tilt);
    }
    if (tier.msaa === 0 && !tier.low) effects.push(new SMAAEffect());
    effects.push(
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
      new VignetteEffect({ offset: 0.32, darkness: 0.62 }),
    );
    if (!tier.low) {
      const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
      noise.blendMode.opacity.value = 0.07;
      effects.push(noise);
    }
    this.composer.addPass(new EffectPass(this.camera, ...effects));

    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }

  /**
   * The miniature blur band suits wide views of the whole island. Up close (a
   * landmark, the game) it hides what the visitor is looking at, so it fades
   * out: 1 = full blur, 0 = none.
   */
  setTiltShift(k: number) {
    if (!this.tilt || Math.abs(k - this.tiltAmount) < 0.004) return;
    this.tiltAmount = k;
    this.tilt.blendMode.opacity.value = k;
  }

  setPixelRatio(pr: number) {
    this.renderer.setPixelRatio(pr);
    this.composer.setSize(innerWidth, innerHeight);
  }

  render(dt: number, t: number) {
    this.skyUpdate(t);
    this.composer.render(dt);
  }
}
