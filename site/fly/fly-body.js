import * as THREE from './vendor/three.module.min.js';
import { clamp } from './body-controller.js';
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const quat = a => new THREE.Quaternion(a[1], a[2], a[3], a[0]);
const TAU = Math.PI * 2;

// FlyBody anatomical joint frames; this is forward/inverse kinematics, not
// MuJoCo. Planted feet stay on the surface while swing legs change foothold.
export async function createFlyBody(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101e19');
  scene.fog = new THREE.Fog('#101e19', 2.8, 5);
  const camera = new THREE.PerspectiveCamera(30, 1, .01, 12);
  const cameraBase = V(); let cameraFollow = 0;
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight('#e6f4e9', '#4d3020', 1.3));
  const key = new THREE.DirectionalLight('#ffdfb8', 2.5);
  key.position.set(.2, -.8, 1.4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -.9, right: .9, top: .9, bottom: -.9, near: .01, far: 4 });
  key.shadow.bias = -.001;
  key.shadow.normalBias = .001;
  scene.add(key);
  const rim = new THREE.DirectionalLight('#b0dfd4', 2.4); rim.position.set(-.6, .9, .5); scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: '#0c1912', roughness: .94 }));
  floor.position.z = -.132; floor.receiveShadow = true; scene.add(floor);
  // Fine specimen-stage rings give a stationary reference for travel and height.
  for (const radius of [.34, .62, .94]) {
    const points = Array.from({ length: 129 }, (_, i) => V(radius * Math.cos(i * TAU / 128), radius * Math.sin(i * TAU / 128), -.1318));
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: '#657969', transparent: true, opacity: .18 })));
  }
  const [rigResponse, meshResponse] = await Promise.all([
    fetch(new URL('./assets/body/rig.json', import.meta.url)), fetch(new URL('./assets/body/meshes.bin', import.meta.url))
  ]);
  if (!rigResponse.ok || !meshResponse.ok) throw Error('Body assets unavailable');
  const rig = await rigResponse.json(), binary = await meshResponse.arrayBuffer();
  const geometries = rig.meshes.map(m => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(binary, m.position.offset, m.position.length), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(binary, m.index.offset, m.index.length), 1));
    g.computeVertexNormals(); return g;
  });
  const root = new THREE.Group(); scene.add(root);
  const bodies = new Map([[0, root]]), names = new Map(), joints = new Map();
  for (const b of rig.bodies) {
    const frame = new THREE.Group(); frame.position.fromArray(b.pos); frame.quaternion.copy(quat(b.quat));
    bodies.get(b.parent).add(frame);
    let tail = frame;
    for (const j of b.joints) {
      const pivot = new THREE.Group(); pivot.position.fromArray(j.pos); tail.add(pivot);
      const child = new THREE.Group(); child.position.fromArray(j.pos).negate(); pivot.add(child);
      joints.set(j.name, { ...j, pivot, axis: V(...j.axis), value: 0 }); tail = child;
    }
    bodies.set(b.id, tail); names.set(b.name, tail);
    for (const g of b.geoms) {
      const name = rig.meshes[g.mesh].name;
      const membrane = name.includes('membrane'), eye = name === 'head_red', black = name.includes('black');
      const colour = eye ? '#ad261a' : black ? '#241c13' : new THREE.Color(...g.rgba.slice(0, 3));
      const material = new THREE.MeshPhysicalMaterial({ color: colour,
        roughness: membrane ? .25 : eye ? .3 : .67, metalness: 0,
        clearcoat: eye ? .38 : membrane ? .5 : .08,
        transparent: membrane, opacity: membrane ? .34 : 1, depthWrite: !membrane,
        side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometries[g.mesh], material);
      mesh.position.fromArray(g.pos); mesh.quaternion.copy(quat(g.quat));
      mesh.castShadow = !membrane; mesh.receiveShadow = false; tail.add(mesh);
    }
  }
  function joint(name, angle) {
    const j = joints.get(name); if (!j) return;
    j.value = clamp(angle, j.range[0], j.range[1]);
    j.pivot.quaternion.setFromAxisAngle(j.axis, j.value - j.rest);
  }
  scene.updateMatrixWorld(true);
  const feet = [];
  for (const side of ['left', 'right']) for (let segment = 1; segment <= 3; segment++) {
    const suffix = `T${segment}_${side}`, tip = names.get(`claw_${suffix}`);
    const home = tip.getWorldPosition(V()); home.z = -.131;
    const chain = [`tibia_${suffix}`, `femur_${suffix}`, `coxa_${suffix}`, `coxa_twist_${suffix}`, `coxa_abduct_${suffix}`].map(n => joints.get(n));
    feet.push({ suffix, segment, side, tip, home, planted: home.clone(), from: home.clone(), target: home.clone(), swing: false, chain,
      offset: (segment + (side === 'left' ? 0 : 1)) % 2 * .5 });
  }
  function solve(foot, target) {
    // Cyclic coordinate descent in each anatomical hinge plane.
    for (let pass = 0; pass < 4; pass++) for (const j of foot.chain) {
      j.pivot.updateWorldMatrix(true, true);
      const origin = j.pivot.getWorldPosition(V());
      const axis = j.axis.clone().applyQuaternion(j.pivot.getWorldQuaternion(new THREE.Quaternion())).normalize();
      const a = foot.tip.getWorldPosition(V()).sub(origin), b = target.clone().sub(origin);
      a.addScaledVector(axis, -a.dot(axis)); b.addScaledVector(axis, -b.dot(axis));
      if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) continue;
      a.normalize(); b.normalize();
      const angle = Math.atan2(axis.dot(a.clone().cross(b)), clamp(a.dot(b), -1, 1));
      joint(j.name, j.value + clamp(angle, -.25, .25));
    }
  }
  const drop = new THREE.Mesh(new THREE.SphereGeometry(.009, 24, 16), new THREE.MeshPhysicalMaterial({ color: '#dfb748', roughness: .13, metalness: .06, clearcoat: 1 }));
  drop.visible = false; scene.add(drop);
  let lastPhase = 0, lastAir = 0;
  let lastPose = '';
  function pose(body, time, { share = 0, groom = false } = {}) {
    // A macro camera follows travel on narrow screens so the head and feet
    // remain visible at touchdown. The stage rings still show displacement.
    camera.position.copy(cameraBase).add(V(body.x * cameraFollow, body.y * cameraFollow));
    camera.lookAt(body.x * cameraFollow, body.y * cameraFollow, .1);
    const moving = body.air > .015 || body.song || Math.abs(body.speed) > .002 || groom;
    const key = [body.x, body.y, body.z, body.heading, body.bank, body.pitch, body.phase, body.feed, body.air, body.song, share, groom, moving ? time : 0].join(',');
    if (key === lastPose) { renderer.render(scene, camera); return; }
    lastPose = key;
    root.position.set(body.x, body.y, body.z);
    root.rotation.set(body.bank, body.pitch, body.heading, 'ZYX');
    root.updateMatrixWorld(true);
    for (const foot of feet) {
      const phase = (body.phase + foot.offset) % 1;
      const swing = phase >= .62 && Math.abs(body.speed) > .002 && body.air < .12;
      const home = foot.home.clone().applyAxisAngle(V(0, 0, 1), body.heading).add(V(body.x, body.y));
      if (body.air > .12) {
        // Tuck each leg separately during ascent, extend ahead of touchdown.
        for (const j of foot.chain) joint(j.name, j.rest);
        const target = home.clone().add(V(0, 0, body.z + .04 * body.air));
        target.x += (body.x - home.x) * body.air * .4;
        target.y += (body.y - home.y) * body.air * .4;
        solve(foot, target); foot.planted.copy(home); foot.swing = false;
        continue;
      }
      if (lastAir > .12 || Math.abs(body.phase - lastPhase) > 1 || foot.planted.distanceTo(home) > .09) foot.planted.copy(home);
      if (swing && !foot.swing) {
        foot.from.copy(foot.planted);
        const direction = Math.sign(body.speed);
        foot.target.copy(home).add(V(Math.cos(body.heading), Math.sin(body.heading)).multiplyScalar(.022 * direction));
      }
      let target = foot.planted.clone();
      if (swing) {
        const p = (phase - .62) / .38, ease = p * p * (3 - 2 * p);
        target.copy(foot.from).lerp(foot.target, ease); target.z += Math.sin(p * Math.PI) * .023;
      } else if (foot.swing) { foot.planted.copy(foot.target); target.copy(foot.planted); }
      if (groom && foot.segment === 1) {
        target.copy(V(.105, foot.side === 'left' ? .027 : -.027, -.005 + Math.sin(time * 13) * .015).applyAxisAngle(V(0, 0, 1), body.heading)).add(root.position);
      }
      solve(foot, target); foot.swing = swing;
    }
    lastPhase = body.phase; lastAir = body.air;
    for (const side of ['left', 'right']) {
      const flying = body.air > .015;
      // Display wing cycles at a readable rate; real Drosophila beats are much
      // faster. This is an explicit display controller, not measured kinematics.
      const beat = Math.sin(time * TAU * 21 + (side === 'left' ? 0 : .08));
      joint(`wing_yaw_${side}`, flying ? .1 + beat * 1.15 : 1.5);
      joint(`wing_roll_${side}`, flying ? .35 + Math.cos(time * TAU * 21) * .55 : .7);
      joint(`wing_pitch_${side}`, flying ? .8 + beat * 1.15 : -1);
      if (!flying && body.song && side === 'left') joint(`wing_yaw_${side}`, .25 + Math.sin(time * 80) * body.song * .3);
      joint(`antenna_${side}`, Math.abs(body.speed) > .002 ? Math.sin(time * 9 + (side === 'left' ? 0 : 1)) * .04 : 0);
    }
    const feed = Math.max(body.feed, share > 0 ? 1 : 0);
    joint('rostrum', feed * .75); joint('haustellum', feed * 1.3);
    joint('head', feed * .12); joint('abdomen', body.air * -.1);
    drop.visible = share > 0 || body.feed > .08;
    if (drop.visible) {
      root.updateMatrixWorld(true);
      drop.position.copy(names.get('labrum_left').getWorldPosition(V()));
      drop.position.z = -.124;
      const amount = share > 0 ? share : Math.max(.12, 1 - body.feed * .7);
      drop.scale.setScalar(Math.cbrt(amount));
    }
    renderer.render(scene, camera);
  }
  function resize(width, height) {
    renderer.setSize(width, height, false); camera.aspect = width / height;
    const distance = camera.aspect < 1 ? 1.65 : 1.12;
    cameraBase.set(distance * .32, -distance, distance * .53);
    cameraFollow = camera.aspect < 1.4 ? .8 : .25;
    camera.position.copy(cameraBase);
    camera.lookAt(0, 0, .1); camera.updateProjectionMatrix();
  }
  function framed() {
    const bounds = new THREE.Box3().setFromObject(root);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const p = V(x, y, z).project(camera);
      if (Math.abs(p.x) > .99 || Math.abs(p.y) > .99) return false;
    }
    return true;
  }
  return { pose, resize, renderer, framed, debug: () => ({ joints: joints.size, feet: feet.map(f => ({ actual: f.tip.getWorldPosition(V()).toArray(), planted: f.planted.toArray(), swing: f.swing })) }) };
}
