// Dev-only scene lab: /lab.html?cam=x,y,z,tx,ty,tz&exp=1.3&emit=2.6
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { City } from './world/city';
import { pickTier, Stage } from './world/stage';

const q = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById('stage')!, pickTier());
const city = await City.load();
stage.scene.add(city.group);
city.setLook({ exposure: Number(q.get('exp') ?? 1.35), emissive: Number(q.get('emit') ?? 2.6) });
const cam = (q.get('cam') ?? '74,64,122,2,-4,2').split(',').map(Number);
stage.camera.position.set(cam[0], cam[1], cam[2]);
const controls = new OrbitControls(stage.camera, stage.renderer.domElement);
controls.target.set(cam[3], cam[4], cam[5]);
controls.update();
const timer = new THREE.Timer();
stage.renderer.setAnimationLoop(() => {
  timer.update();
  controls.update();
  stage.render(Math.min(timer.getDelta(), 0.1), timer.getElapsed());
  (window as any).__frames = ((window as any).__frames ?? 0) + 1;
});
