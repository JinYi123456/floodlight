/**
 * Articulated low-poly footballers built from primitives: tapered torso,
 * articulated knees/elbows, boots, gloves and varied skin/hair. The run cycle
 * is driven by tracked speed and yaw from displacement; every figure casts a
 * shadow.
 */

import * as THREE from 'three';

export interface KitLook {
  shirt: string;
  shorts: string;
  socks: string;
  /** Optional appearance seed (player id) for stable skin/hair/height. */
  id?: string;
  number?: number;
  numberColor?: string;
  skin?: string;
  hair?: string;
  keeper?: boolean;
  height?: number;
}

export interface PlayerFigure {
  group: THREE.Group;
  update(dx: number, dz: number, speedKph: number, dt: number): void;
  dispose(): void;
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>();
const skinPalette = ['#f1c7a3', '#e0ab7c', '#c98d5f', '#a96f47', '#7f5034', '#5d3b26'];
const hairPalette = ['#12100e', '#241913', '#3b2a1d', '#5a3f25', '#8c6a3f', '#d2b27c', '#1b1b1b'];

function material(color: string, roughness = 0.75, metalness = 0): THREE.MeshStandardMaterial {
  const key = `${color}:${roughness}:${metalness}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const made = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  materialCache.set(key, made);
  return made;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, cast = true): THREE.Mesh {
  const made = new THREE.Mesh(geometry, mat);
  made.castShadow = cast;
  return made;
}

function box(w: number, h: number, d: number, mat: THREE.Material, cast = true): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), mat, cast);
}

function angleLerp(from: number, to: number, k: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * k;
}

function numberTexture(number: number, shirt: string, ink: string): { texture: THREE.CanvasTexture; plane: THREE.Mesh } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = shirt;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(10, 8, 108, 112);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ink;
  ctx.font = '700 78px "Cascadia Code", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.32),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, transparent: true }),
  );
  plane.castShadow = false;
  return { texture, plane };
}

export function createPlayerFigure(look: KitLook): PlayerFigure {
  const seed = hash(look.id ?? `${look.shirt}:${look.shorts}`);
  const skin = material(look.skin ?? skinPalette[Math.floor(seed * skinPalette.length) % skinPalette.length]!, 0.8);
  const hair = material(look.hair ?? hairPalette[Math.floor(seed * 997 * hairPalette.length) % hairPalette.length]!, 0.92);
  const shirt = material(look.shirt, 0.6);
  const shorts = material(look.shorts, 0.68);
  const socks = material(look.socks, 0.78);
  const boot = material('#0c0e12', 0.42, 0.08);
  const glove = material(look.keeper ? '#e8edf4' : skin.color.getStyle(), 0.65);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Torso: a flattened capsule reads as shoulders without extra geometry.
  const torso = mesh(new THREE.CapsuleGeometry(0.2, 0.28, 4, 10), shirt);
  torso.scale.set(1.12, 1, 0.66);
  torso.position.y = 1.24;
  body.add(torso);

  const hips = box(0.38, 0.2, 0.24, shorts);
  hips.position.y = 0.94;
  body.add(hips);

  const neck = mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.11, 8), skin);
  neck.position.y = 1.61;
  body.add(neck);

  const head = mesh(new THREE.SphereGeometry(0.145, 14, 11), skin);
  head.position.y = 1.76;
  body.add(head);

  const hairCap = mesh(
    new THREE.SphereGeometry(0.151, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56),
    hair,
  );
  hairCap.position.y = 1.782;
  hairCap.scale.set(1.02, 0.82, 1.03);
  body.add(hairCap);

  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(0.035, 8, 6), skin);
    ear.position.set(side * 0.143, 1.75, 0);
    ear.scale.z = 0.6;
    body.add(ear);

    const sleeve = box(0.13, 0.18, 0.18, shirt);
    sleeve.position.set(side * 0.235, 1.42, 0);
    sleeve.rotation.z = side * -0.12;
    body.add(sleeve);
  }

  const makeLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.125, 0.92, 0);
    body.add(hip);

    const thigh = mesh(new THREE.CylinderGeometry(0.075, 0.063, 0.4, 8), skin);
    thigh.position.y = -0.2;
    hip.add(thigh);
    const shortLeg = mesh(new THREE.CylinderGeometry(0.086, 0.08, 0.2, 8), shorts);
    shortLeg.position.y = -0.1;
    hip.add(shortLeg);

    const knee = new THREE.Group();
    knee.position.y = -0.4;
    hip.add(knee);
    const shin = mesh(new THREE.CylinderGeometry(0.06, 0.046, 0.4, 8), socks);
    shin.position.y = -0.2;
    knee.add(shin);
    const bootMesh = box(0.11, 0.075, 0.3, boot);
    bootMesh.position.set(0, -0.42, 0.07);
    knee.add(bootMesh);
    return { hip, knee };
  };

  const makeArm = (side: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.28, 1.42, 0);
    body.add(shoulder);
    const upper = mesh(new THREE.CylinderGeometry(0.056, 0.048, 0.28, 8), skin);
    upper.position.y = -0.14;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.28;
    shoulder.add(elbow);
    const forearm = mesh(new THREE.CylinderGeometry(0.046, 0.038, 0.26, 8), skin);
    forearm.position.y = -0.13;
    elbow.add(forearm);
    const hand = mesh(new THREE.SphereGeometry(look.keeper ? 0.062 : 0.048, 8, 6), glove);
    hand.position.y = -0.28;
    hand.scale.z = 0.72;
    elbow.add(hand);
    return { shoulder, elbow };
  };

  const legs = { left: makeLeg(-1), right: makeLeg(1) };
  const arms = { left: makeArm(-1), right: makeArm(1) };

  let numberPlane: THREE.Mesh | null = null;
  let numberMap: THREE.CanvasTexture | null = null;
  if (look.number != null) {
    const made = numberTexture(look.number, look.shirt, look.numberColor ?? '#ffffff');
    numberPlane = made.plane;
    numberMap = made.texture;
    numberPlane.position.set(0, 1.26, -0.17);
    numberPlane.rotation.y = Math.PI;
    body.add(numberPlane);
    const shortNumber = box(0.09, 0.09, 0.012, material(look.numberColor ?? '#ffffff', 0.7), false);
    shortNumber.position.set(0.09, 0.94, -0.128);
    body.add(shortNumber);
  }

  const heightScale = look.height ?? (0.96 + seed * 0.09);
  root.scale.setScalar(heightScale);

  let phase = seed * 10;
  let yaw = 0;
  let idleTime = seed * 6;

  return {
    group: root,
    update(dx, dz, speedKph, dt): void {
      const intensity = THREE.MathUtils.clamp(speedKph / 23, 0, 1);
      idleTime += dt;
      phase += dt * (2.1 + speedKph * 0.56);
      const swing = Math.sin(phase) * intensity;
      const leftStride = swing * 0.72;
      const rightStride = -swing * 0.72;

      legs.left.hip.rotation.x = leftStride + (1 - intensity) * 0.035;
      legs.right.hip.rotation.x = rightStride - (1 - intensity) * 0.035;
      legs.left.knee.rotation.x = Math.max(0, -leftStride) * 1.15 + 0.06 + (1 - intensity) * 0.03;
      legs.right.knee.rotation.x = Math.max(0, -rightStride) * 1.15 + 0.06 + (1 - intensity) * 0.03;

      arms.left.shoulder.rotation.x = -leftStride * 0.82;
      arms.right.shoulder.rotation.x = -rightStride * 0.82;
      arms.left.shoulder.rotation.z = -0.08 - intensity * 0.04;
      arms.right.shoulder.rotation.z = 0.08 + intensity * 0.04;
      arms.left.elbow.rotation.x = 0.35 + intensity * 0.55 + Math.max(0, -leftStride) * 0.25;
      arms.right.elbow.rotation.x = 0.35 + intensity * 0.55 + Math.max(0, -rightStride) * 0.25;

      const breathing = Math.sin(idleTime * 1.7) * 0.006 * (1 - intensity);
      body.position.y = Math.abs(Math.cos(phase)) * 0.035 * intensity + breathing;
      body.rotation.x = intensity * 0.1;
      body.rotation.z = Math.sin(phase) * 0.035 * intensity;
      torso.rotation.y = Math.sin(phase) * 0.05 * intensity;
      head.rotation.y = Math.sin(idleTime * 0.55) * 0.16 * (1 - intensity);

      if (Math.hypot(dx, dz) > 0.003) {
        const target = Math.atan2(dx, dz);
        yaw = angleLerp(yaw, target, 1 - Math.exp(-10 * dt));
        root.rotation.y = yaw;
      }
    },
    dispose(): void {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      numberMap?.dispose();
      if (numberPlane) (numberPlane.material as THREE.Material).dispose();
    },
  };
}

/** The two goal frames, painted white with light netting and back stanchions. */
export function createGoalFrames(): THREE.Group {
  const goals = new THREE.Group();
  const postMaterial = new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.35, metalness: 0.1 });

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
    opacity: 0.8,
  });

  const halfWidth = 3.66;
  const height = 2.44;
  const depth = 1.9;
  for (const side of [1, -1]) {
    const goal = new THREE.Group();
    const post = (z: number) => {
      const made = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, height, 12), postMaterial);
      made.position.set(0, height / 2, z);
      made.castShadow = true;
      return made;
    };
    goal.add(post(-halfWidth), post(halfWidth));
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, halfWidth * 2, 12), postMaterial);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0, height, 0);
    bar.castShadow = true;
    goal.add(bar);

    for (const z of [-halfWidth, halfWidth]) {
      const stanchion = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.1, 8), postMaterial);
      stanchion.rotation.z = Math.PI / 2;
      stanchion.position.set(side * depth, 0.35, z);
      goal.add(stanchion);
    }

    const back = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, height), netMaterial);
    back.position.set(side * depth, height / 2, 0);
    back.rotation.y = Math.PI / 2;
    goal.add(back);
    for (const z of [-halfWidth, halfWidth]) {
      const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), netMaterial);
      sideNet.position.set((side * depth) / 2, height / 2, z);
      goal.add(sideNet);
    }
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, depth), netMaterial);
    roof.rotation.x = Math.PI / 2;
    roof.position.set(side * depth / 2, height, 0);
    goal.add(roof);

    goal.position.x = side * 52.5;
    goals.add(goal);
  }
  return goals;
}
