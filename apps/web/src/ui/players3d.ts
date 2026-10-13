/**
 * Low-poly players — a small rig of primitives per figure with a run cycle
 * driven by the tracked speed and a yaw smoothed from movement. No external
 * assets: shirts, shorts, limbs and heads are all boxes and spheres, and
 * every figure casts a shadow so the floodlit pitch reads in 3D.
 */

import * as THREE from 'three';

export interface KitLook {
  shirt: string;
  shorts: string;
  socks: string;
}

export interface PlayerFigure {
  group: THREE.Group;
  /**
   * Pose the figure for this frame.
   * @param dx movement since the last frame (pitch metres, x)
   * @param dz movement since the last frame (pitch metres, z)
   * @param speedKph tracked speed — drives the stride rate and amplitude
   * @param dt seconds since the last frame
   */
  update(dx: number, dz: number, speedKph: number, dt: number): void;
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function material(color: string, roughness = 0.75): THREE.MeshStandardMaterial {
  const key = `${color}:${roughness}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const made = new THREE.MeshStandardMaterial({ color, roughness });
  materialCache.set(key, made);
  return made;
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.castShadow = true;
  return mesh;
}

function angleLerp(from: number, to: number, k: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * k;
}

export function createPlayerFigure(look: KitLook): PlayerFigure {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const skin = material('#d8a077', 0.85);
  const shirt = material(look.shirt, 0.65);
  const shorts = material(look.shorts, 0.7);
  const socks = material(look.socks, 0.8);

  // Torso and hips.
  const torso = box(0.44, 0.52, 0.26, shirt);
  torso.position.y = 1.24;
  body.add(torso);
  const hips = box(0.4, 0.2, 0.24, shorts);
  hips.position.y = 0.92;
  body.add(hips);

  // Head.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 10), skin);
  head.castShadow = true;
  head.position.y = 1.65;
  body.add(head);

  // Legs pivot at the hip; arms at the shoulder.
  const makeLimb = (mat: THREE.Material, length: number, thickness: number): THREE.Group => {
    const pivot = new THREE.Group();
    const limb = box(thickness, length, thickness, mat);
    limb.position.y = -length / 2;
    pivot.add(limb);
    body.add(pivot);
    return pivot;
  };
  const legL = makeLimb(socks, 0.82, 0.15);
  legL.position.set(0.12, 0.86, 0);
  const legR = makeLimb(socks, 0.82, 0.15);
  legR.position.set(-0.12, 0.86, 0);
  const armL = makeLimb(skin, 0.56, 0.1);
  armL.position.set(0.27, 1.46, 0);
  const armR = makeLimb(skin, 0.56, 0.1);
  armR.position.set(-0.27, 1.46, 0);

  let phase = 0;
  let yaw = 0;

  return {
    group,
    update(dx: number, dz: number, speedKph: number, dt: number): void {
      const intensity = Math.min(1, speedKph / 22);
      phase += dt * (2.4 + speedKph * 0.68);
      const swing = Math.sin(phase) * intensity * 0.82;
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.7;
      armR.rotation.x = swing * 0.7;
      body.position.y = Math.abs(Math.cos(phase)) * 0.045 * intensity;
      if (Math.hypot(dx, dz) > 0.005) {
        const target = Math.atan2(dx, dz);
        yaw = angleLerp(yaw, target, 1 - Math.exp(-9 * dt));
        group.rotation.y = yaw;
      }
    },
  };
}

/** The two goal frames, painted white with light netting. */
export function createGoalFrames(): THREE.Group {
  const goals = new THREE.Group();
  const postMaterial = new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.4 });

  const netCanvas = document.createElement('canvas');
  netCanvas.width = 64;
  netCanvas.height = 64;
  const ctx = netCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(235,240,245,0.55)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i <= 64; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 64);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(64, i);
    ctx.stroke();
  }
  const netTexture = new THREE.CanvasTexture(netCanvas);
  netTexture.wrapS = THREE.RepeatWrapping;
  netTexture.wrapT = THREE.RepeatWrapping;
  const netMaterial = new THREE.MeshBasicMaterial({
    map: netTexture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const halfWidth = 3.66;
  const height = 2.44;
  const depth = 1.9;
  for (const side of [1, -1]) {
    const goal = new THREE.Group();
    const post = (z: number) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, height, 10), postMaterial);
      mesh.position.set(0, height / 2, z);
      mesh.castShadow = true;
      return mesh;
    };
    goal.add(post(-halfWidth), post(halfWidth));
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, halfWidth * 2, 10), postMaterial);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0, height, 0);
    bar.castShadow = true;
    goal.add(bar);

    const back = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, height), netMaterial);
    back.position.set(side * depth, height / 2, 0);
    back.rotation.y = Math.PI / 2;
    goal.add(back);
    for (const z of [-halfWidth, halfWidth]) {
      const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), netMaterial);
      sideNet.position.set((side * depth) / 2, height / 2, z);
      goal.add(sideNet);
    }
    goal.position.x = side * 52.5;
    goals.add(goal);
  }
  return goals;
}
