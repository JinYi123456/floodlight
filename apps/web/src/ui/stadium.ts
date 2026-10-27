/**
 * Procedural night stadium: four raked stands with an instanced crowd, roof
 * lip lighting, LED perimeter boards and floodlight masts. No
 * external assets or sponsor marks — every surface is drawn from code.
 */

import * as THREE from 'three';
import type { Club } from '@floodlight/core';

const CROWD_COLORS = ['#131a24', '#1a2330', '#232e3d', '#303c4d', '#465364', '#66738a'];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function clubSeed(club: Club): number {
  let h = 2166136261;
  for (const ch of club.id) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function adTexture(home: Club, away: Club): THREE.CanvasTexture {
  return canvasTexture(2048, 128, (ctx) => {
    ctx.fillStyle = '#060d16';
    ctx.fillRect(0, 0, 2048, 128);
    const segments = [home.primary, '#0d1926', away.primary, '#0d1926'];
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = segments[i % segments.length]!;
      ctx.globalAlpha = 0.2;
      ctx.fillRect(i * 256, 0, 256, 128);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e8f0fb';
    ctx.font = '700 58px "Bahnschrift", "Cascadia Code", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FLOODLIGHT', 420, 66);
    ctx.font = '500 42px "Bahnschrift", "Cascadia Code", sans-serif';
    ctx.fillStyle = '#7ea6c9';
    ctx.fillText('MATCH  INTELLIGENCE', 1060, 68);
    ctx.fillStyle = '#e8f0fb';
    ctx.font = '700 58px "Bahnschrift", "Cascadia Code", sans-serif';
    ctx.fillText('EVERY  MOMENT', 1690, 66);
  });
}

export function createNightSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color('#01040a') },
      horizon: { value: new THREE.Color('#0a1a2a') },
      glow: { value: new THREE.Color('#1c3446') },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vPos = normalize(world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 glow;
      varying vec3 vPos;
      void main() {
        float h = clamp(vPos.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 color = mix(horizon, top, pow(h, 0.75));
        float band = smoothstep(0.42, 0.55, h) * (1.0 - smoothstep(0.55, 0.72, h));
        color += glow * band * 0.55;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(290, 32, 20), material);
  sky.renderOrder = -10;
  return sky;
}

export function createStadium(home: Club, away: Club): THREE.Group {
  const stadium = new THREE.Group();
  stadium.name = 'stadium';
  const random = seeded(clubSeed(home) ^ clubSeed(away));
  const crowdMatrices: THREE.Matrix4[] = [];
  const crowdColors: THREE.Color[] = [];
  const homePalette = [home.primary, home.secondary, home.primary, '#aab5c6', '#1a2330'];
  const awayPalette = [away.primary, away.secondary, away.primary, '#aab5c6', '#1a2330'];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();
  const color = new THREE.Color();

  const concrete = new THREE.MeshStandardMaterial({ color: '#0a1018', roughness: 0.95 });
  const roofMaterial = new THREE.MeshStandardMaterial({ color: '#0c131c', roughness: 0.82, metalness: 0.18 });
  const lipMaterial = new THREE.MeshStandardMaterial({
    color: '#cfe3ff',
    emissive: '#a9c9ff',
    emissiveIntensity: 2.4,
    roughness: 0.4,
  });

  const pushCrowd = (x: number, y: number, z: number, rotation: number, palette: string[], homeShare: number) => {
    if (random() < 0.13) return;
    position.set(x, y + 0.26, z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
    scale.set(0.9 + random() * 0.24, 0.92 + random() * 0.22, 0.9 + random() * 0.2);
    matrix.compose(position, quat, scale);
    crowdMatrices.push(matrix.clone());
    const pick = random();
    const paletteColor = pick < homeShare * 0.5 ? homePalette[Math.floor(random() * homePalette.length)]!
      : pick < homeShare ? homePalette[Math.floor(random() * homePalette.length)]!
      : pick < 0.52 ? awayPalette[Math.floor(random() * awayPalette.length)]!
      : CROWD_COLORS[Math.floor(random() * CROWD_COLORS.length)]!;
    crowdColors.push(color.set(paletteColor).clone());
  };

  const endStand = (sign: number, homeShare: number) => {
    const rows = 17;
    for (let row = 0; row < rows; row++) {
      const y = 2.1 + row * 0.56;
      const z = sign * (37.6 + row * 0.88);
      const step = new THREE.Mesh(new THREE.BoxGeometry(118, 0.56, 0.9), concrete);
      step.position.set(0, y - 0.28, z);
      step.receiveShadow = true;
      stadium.add(step);
      for (let x = -57.5; x <= 57.5; x += 0.72) {
        if (Math.abs(((x + 57.5) % 19) - 9.5) > 8.4) continue;
        pushCrowd(x, y, z, sign < 0 ? 0 : Math.PI, homeShare > 0.5 ? homePalette : awayPalette, homeShare);
      }
    }
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(122, 12, 0.8), concrete);
    backWall.position.set(0, 7.2, sign * (37.6 + rows * 0.88));
    stadium.add(backWall);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(126, 0.45, 17), roofMaterial);
    roof.position.set(0, 16.4, sign * 46.8);
    stadium.add(roof);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(118, 0.24, 0.4), lipMaterial);
    lip.position.set(0, 16.1, sign * 38.3);
    stadium.add(lip);
  };

  const sideStand = (sign: number, homeShare: number) => {
    const rows = 15;
    for (let row = 0; row < rows; row++) {
      const y = 2.1 + row * 0.56;
      const x = sign * (58.8 + row * 0.88);
      const step = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.56, 69), concrete);
      step.position.set(x, y - 0.28, 0);
      step.receiveShadow = true;
      stadium.add(step);
      for (let z = -33.5; z <= 33.5; z += 0.72) {
        if (Math.abs(((z + 33.5) % 17) - 8.5) > 7.4) continue;
        pushCrowd(x, y, z, sign < 0 ? Math.PI / 2 : -Math.PI / 2, homeShare > 0.5 ? homePalette : awayPalette, homeShare);
      }
    }
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(0.8, 11, 73), concrete);
    backWall.position.set(sign * (58.8 + rows * 0.88), 6.6, 0);
    stadium.add(backWall);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(15, 0.45, 78), roofMaterial);
    roof.position.set(sign * 66.2, 15.1, 0);
    stadium.add(roof);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.24, 69), lipMaterial);
    lip.position.set(sign * 59.4, 14.8, 0);
    stadium.add(lip);
  };

  endStand(-1, 0.82);
  endStand(1, 0.3);
  sideStand(-1, 0.62);
  sideStand(1, 0.22);

  const crowdGeometry = new THREE.BoxGeometry(0.34, 0.5, 0.24);
  const crowdMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92 });
  const crowd = new THREE.InstancedMesh(crowdGeometry, crowdMaterial, crowdMatrices.length);
  for (let i = 0; i < crowdMatrices.length; i++) {
    crowd.setMatrixAt(i, crowdMatrices[i]!);
    crowd.setColorAt(i, crowdColors[i]!);
  }
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  crowd.castShadow = false;
  crowd.receiveShadow = false;
  stadium.add(crowd);

  // LED perimeter boards.
  const boards = adTexture(home, away);
  boards.wrapS = THREE.RepeatWrapping;
  boards.repeat.set(3, 1);
  const boardMaterial = new THREE.MeshBasicMaterial({ map: boards, toneMapped: false, side: THREE.DoubleSide });
  const addBoard = (width: number, x: number, z: number, rotation: number) => {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, 1.25), boardMaterial);
    screen.position.set(x, 0.78, z);
    screen.rotation.y = rotation;
    stadium.add(screen);
    const base = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, 0.24), new THREE.MeshStandardMaterial({ color: '#04090f' }));
    base.position.set(x, 0.25, z);
    base.rotation.y = rotation;
    stadium.add(base);
  };
  addBoard(112, 0, -36.25, 0);
  addBoard(112, 0, 36.25, Math.PI);
  addBoard(69, -56.4, 0, Math.PI / 2);
  addBoard(69, 56.4, 0, -Math.PI / 2);

  // Floodlight masts, panels and soft light cones.
  const mastMaterial = new THREE.MeshStandardMaterial({ color: '#1a2330', roughness: 0.55, metalness: 0.55 });
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: '#eaf3ff',
    emissive: '#cfe4ff',
    emissiveIntensity: 4,
    roughness: 0.3,
  });
  const coneMaterial = new THREE.MeshBasicMaterial({
    color: '#9fc6ff',
    transparent: true,
    opacity: 0.026,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const center = new THREE.Vector3(0, 0, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const base = new THREE.Vector3(sx * 68, 0, sz * 45);
      const top = new THREE.Vector3(sx * 68, 27, sz * 45);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 27, 8), mastMaterial);
      mast.position.set(base.x, 13.5, base.z);
      stadium.add(mast);
      const panelLamp = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.2, 0.55), lampMaterial);
      panelLamp.position.set(base.x, 27.6, base.z);
      panelLamp.lookAt(center);
      stadium.add(panelLamp);
      const toPitch = new THREE.Vector3(center.x - top.x, 0 - top.y, center.z - top.z);
      const length = toPitch.length();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(23, length, 20, 1, true), coneMaterial);
      cone.position.copy(top).addScaledVector(toPitch, 0.5);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toPitch.clone().normalize().negate());
      stadium.add(cone);
      const light = new THREE.SpotLight('#dbeaff', 550, 190, 0.62, 0.7, 1.7);
      light.position.copy(top);
      light.target.position.copy(center);
      stadium.add(light, light.target);
    }
  }

  // Corner flags.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), mastMaterial);
      pole.position.set(sx * 52.4, 0.8, sz * 33.9);
      stadium.add(pole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.05, 0.62),
        new THREE.MeshBasicMaterial({ color: sz < 0 ? home.primary : away.primary, side: THREE.DoubleSide }),
      );
      flag.position.set(sx * 52.4, 1.42, sz * 33.9 + 0.54);
      flag.rotation.y = Math.PI / 2;
      stadium.add(flag);
    }
  }

  // Dugouts on the near touchline.
  for (const sign of [-1, 1]) {
    const dugout = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(7.4, 0.12, 1.45),
      new THREE.MeshStandardMaterial({ color: '#cfe0f2', transparent: true, opacity: 0.28, roughness: 0.15 }),
    );
    canopy.position.y = 2.1;
    dugout.add(canopy);
    for (const x of [-3.4, 3.4]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.1, 6), mastMaterial);
      leg.position.set(x, 1.05, 0.6);
      dugout.add(leg);
    }
    const bench = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.35, 0.55), roofMaterial);
    bench.position.set(0, 0.55, 0.35);
    dugout.add(bench);
    dugout.position.set(sign * 17, 0, 37.3);
    stadium.add(dugout);
  }

  stadium.userData.dispose = () => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    stadium.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const mats = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of mats) materials.add(mat);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const mat of materials) mat.dispose();
    boards.dispose();
  };

  return stadium;
}
