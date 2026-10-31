import * as THREE from 'three';
import { P } from './palette';

/** Direction of the setting sun (low in the west-south-west). */
export const SUN_DIR = new THREE.Vector3(-0.72, 0.16, 0.55).normalize(); // matches the bake's sun azimuth

/** Gradient dome with a warm horizon band toward the sun and twinkling stars. */
export function makeSky(): { mesh: THREE.Mesh; stars: THREE.Points; update(t: number): void } {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: P.zenith }, uUpper: { value: P.upper }, uMid: { value: P.mid },
      uHorizon: { value: P.horizon }, uSun: { value: P.sun }, uSunDir: { value: SUN_DIR },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uZenith, uUpper, uMid, uHorizon, uSun, uSunDir;
      void main(){
        float y = vDir.y;
        float sunAmt = max(dot(normalize(vec3(vDir.x, 0.0, vDir.z)), normalize(vec3(uSunDir.x,0.0,uSunDir.z))), 0.0);
        vec3 c = mix(uMid, uUpper, smoothstep(0.05, 0.35, y));
        c = mix(c, uZenith, smoothstep(0.35, 0.9, y));
        // horizon glow, strongest toward the sun
        float band = exp(-max(y + 0.02, 0.0) * mix(14.0, 5.0, pow(sunAmt, 3.0)));
        c = mix(c, uHorizon, band * (0.35 + 0.65 * pow(sunAmt, 2.0)));
        float sun = pow(max(dot(vDir, uSunDir), 0.0), 600.0) * 3.0 + pow(max(dot(vDir, uSunDir), 0.0), 18.0) * 0.35;
        c += uSun * sun;
        // below horizon: fade into the cloud sea tint
        c = mix(c, uMid * 0.55, smoothstep(0.0, -0.25, y));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  mesh.renderOrder = -10;

  // Stars: only in the upper sky, away from the sunset.
  const N = 1400;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  let i = 0;
  while (i < N) {
    const v = new THREE.Vector3().randomDirection();
    if (v.y < 0.18 || v.dot(SUN_DIR) > 0.55) continue;
    v.multiplyScalar(850);
    pos.set([v.x, v.y, v.z], i * 3);
    seed[i] = Math.random();
    i++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const sMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPR: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: `attribute float seed; uniform float uTime, uPR; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
        float tw = 0.55 + 0.45 * sin(uTime * (0.6 + seed * 2.0) + seed * 40.0);
        vA = tw * (0.35 + 0.65 * seed) * smoothstep(0.15, 0.5, normalize(position).y);
        gl_PointSize = (1.0 + seed * 1.8) * uPR; }`,
    fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vec3(0.85,0.9,1.0) * 1.6, a * vA); }`,
  });
  const stars = new THREE.Points(g, sMat);
  stars.renderOrder = -9;
  return { mesh, stars, update: (t) => (sMat.uniforms.uTime.value = t) };
}

/** A sea of clouds far below the island. */
export function makeCloudSea(): { mesh: THREE.Mesh; update(t: number): void } {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uTint: { value: P.mid }, uGlow: { value: P.horizon }, uSunDir: { value: SUN_DIR } },
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      varying vec2 vUv; varying vec3 vW; uniform float uTime; uniform vec3 uTint, uGlow, uSunDir;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i=0;i<5;i++){ v += a*n(p); p *= 2.03; a *= 0.5; } return v; }
      void main(){
        vec2 p = vW.xz * 0.012;
        float d = fbm(p + vec2(uTime*0.006, uTime*0.003)) * 0.65 + fbm(p*2.3 - uTime*0.01) * 0.35;
        float r = length(vW.xz);
        float edge = smoothstep(820.0, 300.0, r);
        float toward = max(dot(normalize(vec3(vW.x,0.0,vW.z)), normalize(vec3(uSunDir.x,0.0,uSunDir.z))), 0.0);
        vec3 c = mix(uTint * 0.45, uTint * 1.1, smoothstep(0.35, 0.8, d));
        c += uGlow * pow(toward, 3.0) * 0.55 * smoothstep(0.4, 0.9, d) * smoothstep(80.0, 600.0, r);
        gl_FragColor = vec4(c, smoothstep(0.28, 0.7, d) * edge * 0.95);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -70;
  mesh.renderOrder = -8;
  return { mesh, update: (t) => (mat.uniforms.uTime.value = t) };
}
