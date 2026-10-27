/**
 * The program monitor — a live 3D feed of the match rendered from 10 Hz
 * tracking frames, with the cue sheet on top.
 *
 * Everything on screen is something the cue sheet asked for: the clock and
 * tally are always on, lower thirds, stat bumpers, the momentum ribbon and
 * the goal flash are screen-fixed graphics, the player tag is anchored to a
 * tracked player, and telestration is drawn in the world itself. The camera
 * is part of the production: tactical overview, ball-follow or player focus.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import * as THREE from 'three';
import { formatClock, type TrackingFrame } from '@floodlight/core';
import { cueForSlot, matchesPreferences, textForViewer } from '../state/derive';
import { useAppStore, trackingCache } from '../state/store';
import { createPitchTexture } from './pitchTexture';
import { createGoalFrames, createPlayerFigure, type PlayerFigure } from './players3d';
import { createNightSky, createStadium } from './stadium';
import { broadcast } from './audio';
import { cuesForViewer, isCriticalMoment, PlayByPlay, recordedMomentClip, spokenLine } from './commentary';

type CameraMode = 'broadcast' | 'tactical' | 'follow' | 'player';

const SPRINT_RING = 0xffa53a;

export function ProgramMonitor() {
  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.t);
  const prefs = useAppStore((state) => state.prefs);
  const rate = useAppStore((state) => state.rate);
  const focusPlayerId = prefs.playerId;
  const setPrefs = useAppStore((state) => state.setPrefs);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tagRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<TrackingFrame | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const [mode, setMode] = useState<CameraMode>('broadcast');
  const modeRef = useRef(mode);
  const [audioOn, setAudioOn] = useState(false);
  const playByPlayRef = useRef<PlayByPlay | null>(null);
  if (!playByPlayRef.current) playByPlayRef.current = new PlayByPlay();

  // The crowd, the whistles and the commentary desk. Browsers only start
  // audio after a gesture — the last gesture was entering the studio, so a
  // resume attempt here normally sticks; the toggle is the fallback.
  useEffect(() => {
    setAudioOn(broadcast.enabled || broadcast.enable());
    const sync = (state: ReturnType<typeof useAppStore.getState>) => {
      broadcast.update(state.match?.events ?? [], state.t, state.playing && !!state.match, {
        sessionId: state.match,
        epoch: state.playbackEpoch,
        lang: state.prefs.lang,
        persona: state.prefs.persona,
        preferenceKey: JSON.stringify([state.prefs.clubId, state.prefs.playerId, state.prefs.metric]),
        rate: state.rate,
      });
    };
    sync(useAppStore.getState());
    // Synchronous store notification, not the next animation frame: pause or
    // even two seeks between frames must invalidate an in-flight decoder now.
    const unsubscribe = useAppStore.subscribe(sync);
    return () => {
      unsubscribe();
      broadcast.disable();
    };
  }, []);

  // Click a player to follow them: project every tracked player into screen
  // space and take the nearest one inside the hit radius.
  const pickPlayer = (clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    const frame = frameRef.current;
    if (!canvas || !camera || !frame) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const project = new THREE.Vector3();
    let best: string | null = null;
    let bestD = 26;
    for (const player of frame.players) {
      project.set(player.pos.x, 1.6, player.pos.y).project(camera);
      const sx = (project.x * 0.5 + 0.5) * rect.width;
      const sy = (-project.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = player.playerId;
      }
    }
    return best;
  };

  const handlePointer = (event: MouseEvent<HTMLCanvasElement>) => {
    const hit = pickPlayer(event.clientX, event.clientY);
    event.currentTarget.style.cursor = hit ? 'pointer' : '';
  };

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const hit = pickPlayer(event.clientX, event.clientY);
    if (hit) {
      setPrefs({ playerId: hit });
    } else if (focusPlayerId) {
      // Clicking away releases the focus and returns to the broadcast camera.
      setPrefs({ playerId: null });
      setMode('broadcast');
    }
  };

  useEffect(() => {
    setMode((current) => focusPlayerId ? 'player' : current === 'player' ? 'broadcast' : current);
  }, [focusPlayerId]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !match) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#04070d');
    scene.fog = new THREE.Fog('#04070d', 70, 230);
    const sky = createNightSky();
    scene.add(sky);

    const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.6, 420);
    camera.position.set(0, 15.5, 42);
    const cameraTarget = new THREE.Vector3(0, 2.6, 0);

    // Night-match lighting. The stadium adds four soft mast lights; these
    // directional/ambient lights carry the shadow and colour separation.
    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x0a1420, 0.9));
    scene.add(new THREE.AmbientLight(0x233048, 0.35));
    const key = new THREE.DirectionalLight(0xfff1d2, 2.4);
    key.position.set(55, 95, 40);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -80;
    key.shadow.camera.right = 80;
    key.shadow.camera.top = 60;
    key.shadow.camera.bottom = -60;
    key.shadow.camera.near = 10;
    key.shadow.camera.far = 260;
    key.shadow.bias = -0.0006;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd8ff, 0.6);
    fill.position.set(-70, 60, -45);
    scene.add(fill);

    // Ground + pitch + goals + the stadium bowl.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 220),
      new THREE.MeshStandardMaterial({ color: '#040910', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.25;
    ground.receiveShadow = true;
    scene.add(ground);

    const pitchTexture = new THREE.CanvasTexture(createPitchTexture());
    pitchTexture.colorSpace = THREE.SRGBColorSpace;
    pitchTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(111, 74),
      new THREE.MeshStandardMaterial({ map: pitchTexture, roughness: 0.95 }),
    );
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    scene.add(pitch);

    const goals = createGoalFrames();
    scene.add(goals);

    const stadium = createStadium(match.meta.home, match.meta.away);
    scene.add(stadium);

    // Player figures, created lazily as they appear in the feed.
    interface PlayerObject {
      figure: PlayerFigure;
      ring: THREE.Mesh;
      ownerRing: THREE.Mesh;
      teamRing: THREE.Mesh;
      number: THREE.Sprite;
      lastPos: { x: number; y: number };
    }
    const playerObjects = new Map<string, PlayerObject>();
    const numberTextureCache = new Map<string, THREE.Texture>();

    const numberTexture = (shirt: number, color: string, onColor: string): THREE.Texture => {
      const cacheKey = `${shirt}:${color}`;
      const cached = numberTextureCache.get(cacheKey);
      if (cached) return cached;
      const size = 64;
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d')!;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = size * 0.06;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.fillStyle = onColor;
      ctx.font = `700 ${size * 0.44}px 'Cascadia Code', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shirt), size / 2, size / 2 + size * 0.02);
      const texture = new THREE.CanvasTexture(c);
      texture.colorSpace = THREE.SRGBColorSpace;
      numberTextureCache.set(cacheKey, texture);
      return texture;
    };

    const roster = new Map(
      [...match.lineups.home, ...match.lineups.away, ...match.bench.home, ...match.bench.away].map((p) => [
        p.id,
        { team: p.team, shirt: p.shirt, role: p.role } as const,
      ]),
    );

    const ensurePlayer = (playerId: string): PlayerObject => {
      const existing = playerObjects.get(playerId);
      if (existing) return existing;
      const info = roster.get(playerId);
      const isHome = (info?.team ?? 'home') === 'home';
      const club = isHome ? match.meta.home : match.meta.away;
      const isKeeper = info?.role === 'GK';
      const keeperShirt = club.secondary.toLowerCase() === club.primary.toLowerCase() ? '#e7b84b' : club.secondary;
      const figure = createPlayerFigure({
        id: playerId,
        number: info?.shirt,
        numberColor: club.onPrimary,
        shirt: isKeeper ? keeperShirt : club.primary,
        shorts: isKeeper ? '#161a22' : club.secondary,
        socks: isKeeper ? keeperShirt : club.primary,
        keeper: isKeeper,
        height: isKeeper ? 1.05 : undefined,
      });
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.3, 1.65, 26),
        new THREE.MeshBasicMaterial({ color: SPRINT_RING, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      const ownerRing = new THREE.Mesh(
        new THREE.RingGeometry(1.05, 1.28, 26),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
      );
      ownerRing.rotation.x = -Math.PI / 2;
      ownerRing.position.y = 0.03;
      const teamRing = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.72, 20),
        new THREE.MeshBasicMaterial({
          color: club.primary,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.62,
          depthWrite: false,
        }),
      );
      teamRing.rotation.x = -Math.PI / 2;
      teamRing.position.y = 0.015;
      const number = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: numberTexture(info?.shirt ?? 0, club.primary, club.onPrimary),
          depthTest: true,
        }),
      );
      number.scale.setScalar(1.72);
      number.position.y = 2.2;
      const group: PlayerObject = { figure, ring, ownerRing, teamRing, number, lastPos: { x: 0, y: 0 } };
      scene.add(figure.group);
      scene.add(ring);
      scene.add(ownerRing);
      scene.add(teamRing);
      scene.add(number);
      playerObjects.set(playerId, group);
      return group;
    };

    // Ball + trail.
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.38, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, emissive: 0x222222 }),
    );
    ball.position.y = 0.38;
    scene.add(ball);
    const trailLength = 42;
    const trailPositions = new Float32Array(trailLength * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeometry.setDrawRange(0, 0);
    const trail = new THREE.Line(
      trailGeometry,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }),
    );
    scene.add(trail);
    let trailCount = 0;

    // Telestration (cue-driven, drawn in the world).
    const telePoints = 26;
    const teleGeometry = new THREE.BufferGeometry();
    teleGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(telePoints * 3), 3));
    const teleLine = new THREE.Line(
      teleGeometry,
      new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 1.6, gapSize: 1.1, linewidth: 2 }),
    );
    teleLine.visible = false;
    scene.add(teleLine);

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    resize();

    const project = new THREE.Vector3();
    let lastTick = performance.now();
    let raf = 0;
    let lastEpoch: number | undefined;
    let lastTime = Number.NaN;
    let targetFov = 35;
    const render = () => {
      const state = useAppStore.getState();
      const currentMatch = state.match;
      if (!currentMatch || currentMatch !== match) return;
      const time = state.t;
      const epoch = state.playbackEpoch;
      if (epoch !== lastEpoch || time < lastTime) trailCount = 0;
      lastEpoch = epoch;
      lastTime = time;
      const frame = trackingCache.atSmooth(time);
      frameRef.current = frame;
      cameraRef.current = camera;

      const active = cuesForViewer(currentMatch, time, state.prefs);
      const tagCue = cueForSlot(active, 'player_tag');
      const telestration = cueForSlot(active, 'telestration');

      // Audio clock/cancellation is subscribed to the store above. The render
      // loop only offers fresh lines, using the same copy as the viewer desk.
      if (state.playing) {
        const line = playByPlayRef.current?.feed(currentMatch, time, { epoch, lang: state.prefs.lang }) ?? null;
        if (line) broadcast.speak(line.id, line.text, line.priority >= 95);
        for (const moment of currentMatch.moments) {
          if (!moment.air.air || !moment.verification.approved) continue;
          const interrupt = isCriticalMoment(moment);
          if (!interrupt && !matchesPreferences(currentMatch, moment.candidate, state.prefs)) continue;
          const mt = moment.candidate.t;
          if (mt <= time && mt > time - 2.5) {
            const text = textForViewer(currentMatch, moment, state.prefs);
            const clip = recordedMomentClip(currentMatch, moment, state.prefs, state.recordingId, text.headline);
            const clipUrl = clip ? new URL(clip, document.baseURI).href : null;
            broadcast.moment(moment.candidate.id, spokenLine(text.headline), clipUrl, interrupt);
          }
        }
      }

      if (frame) {
        // Players.
        const now = performance.now();
        const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
        lastTick = now;
        const seen = new Set<string>();
        const showNumbers = modeRef.current === 'tactical' || modeRef.current === 'player';
        for (const player of frame.players) {
          seen.add(player.playerId);
          const object = ensurePlayer(player.playerId);
          const dx = player.pos.x - object.lastPos.x;
          const dz = player.pos.y - object.lastPos.y;
          object.lastPos.x = player.pos.x;
          object.lastPos.y = player.pos.y;
          object.figure.group.position.x = player.pos.x;
          object.figure.group.position.z = player.pos.y;
          object.figure.update(dx, dz, player.speedKph, dt);
          const sprinting = player.speedKph >= 25.2;
          object.ring.position.x = player.pos.x;
          object.ring.position.z = player.pos.y;
          object.ring.visible = sprinting;
          object.teamRing.position.x = player.pos.x;
          object.teamRing.position.z = player.pos.y;
          object.teamRing.visible = true;
          object.number.position.x = player.pos.x;
          object.number.position.z = player.pos.y;
        }
        for (const [id, object] of playerObjects) {
          if (!seen.has(id)) {
            object.figure.group.visible = false;
            object.ring.visible = false;
            object.ownerRing.visible = false;
            object.teamRing.visible = false;
            object.number.visible = false;
          } else {
            object.figure.group.visible = true;
            object.number.visible = showNumbers;
          }
        }

        // Ball + trail.
        ball.position.x = frame.ball.pos.x;
        ball.position.z = frame.ball.pos.y;
        for (let i = trailCount; i > 0; i--) {
          trailPositions[i * 3] = trailPositions[(i - 1) * 3]!;
          trailPositions[i * 3 + 1] = trailPositions[(i - 1) * 3 + 1]!;
          trailPositions[i * 3 + 2] = trailPositions[(i - 1) * 3 + 2]!;
        }
        trailPositions[0] = frame.ball.pos.x;
        trailPositions[1] = 0.12;
        trailPositions[2] = frame.ball.pos.y;
        trailCount = Math.min(trailCount + 1, trailLength);
        trailGeometry.attributes.position!.needsUpdate = true;
        trailGeometry.setDrawRange(0, trailCount);

        // Owner highlight.
        let owner: string | null = null;
        let bestD = 2.2;
        for (const player of frame.players) {
          const d = Math.hypot(player.pos.x - frame.ball.pos.x, player.pos.y - frame.ball.pos.y);
          if (d < bestD) {
            bestD = d;
            owner = player.playerId;
          }
        }
        for (const [id, object] of playerObjects) {
          const isOwner = id === owner;
          object.ownerRing.visible = isOwner;
          if (isOwner) {
            object.ownerRing.position.x = object.figure.group.position.x;
            object.ownerRing.position.z = object.figure.group.position.z;
          }
        }

        // Camera.
        const mode = modeRef.current;
        const focusId = state.prefs.playerId;
        const ballX = frame.ball.pos.x;
        const ballY = frame.ball.pos.y;
        const desired = new THREE.Vector3(0, 15.5, 42);
        const target = new THREE.Vector3(0, 2.6, 0);
        if (mode === 'tactical') {
          desired.set(0, 82, 48);
          target.set(0, 0, 0);
          targetFov = 40;
        } else if (mode === 'broadcast') {
          const bx = THREE.MathUtils.clamp(ballX, -28, 28);
          desired.set(bx * 0.28, 15.5, 42 + THREE.MathUtils.clamp(ballY, -12, 12) * 0.12);
          target.set(bx * 0.72, 2.6, THREE.MathUtils.clamp(ballY, -20, 20) * 0.35);
          targetFov = 35;
        } else if (mode === 'follow') {
          const bx = THREE.MathUtils.clamp(ballX, -34, 34);
          desired.set(bx * 0.5, 26, 40 + ballY * 0.35);
          target.set(bx * 0.85, 1.2, ballY * 0.65);
          targetFov = 32;
        } else if (mode === 'player') {
          const focused = frame.players.find((p) => p.playerId === focusId);
          if (focused) {
            desired.set(focused.pos.x + 5, 11, focused.pos.y + 14);
            target.set(focused.pos.x, 1.35, focused.pos.y);
            targetFov = 26;
          } else {
            // A substituted/dismissed player is not the ball. Show the wide
            // camera and its real mode; retain the viewer's analysis filter.
            modeRef.current = 'broadcast';
            setMode('broadcast');
            targetFov = 35;
          }
        }
        const smoothing = modeRef.current === 'tactical' ? 0.045 : 0.07;
        camera.position.lerp(desired, smoothing);
        cameraTarget.lerp(target, smoothing * 1.4);
        if (Math.abs(camera.fov - targetFov) > 0.01) {
          camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, smoothing * 1.2);
          camera.updateProjectionMatrix();
        }
        camera.lookAt(cameraTarget);
      }

      // Telestration grows from its anchor point.
      if (telestration?.payload.from && telestration.payload.to) {
        const from = telestration.payload.from as { x: number; y: number };
        const to = telestration.payload.to as { x: number; y: number };
        const progress = THREE.MathUtils.clamp((time - telestration.t0) / 1.1, 0.05, 1);
        const positions = teleGeometry.attributes.position!.array as Float32Array;
        for (let i = 0; i < telePoints; i++) {
          const k = (i / (telePoints - 1)) * progress;
          positions[i * 3] = from.x + (to.x - from.x) * k;
          positions[i * 3 + 1] = 0.15;
          positions[i * 3 + 2] = from.y + (to.y - from.y) * k;
        }
        teleGeometry.attributes.position!.needsUpdate = true;
        teleGeometry.computeBoundingSphere();
        teleLine.computeLineDistances();
        teleLine.visible = true;
      } else {
        teleLine.visible = false;
      }

      // Anchored player tag: project the tracked player into screen space.
      const tagElement = tagRef.current;
      if (tagElement) {
        if (tagCue && frame) {
          const playerId = String(tagCue.payload.playerId ?? '');
          const tracked = frame.players.find((p) => p.playerId === playerId);
          if (tracked) {
            project.set(tracked.pos.x, 1.6, tracked.pos.y).project(camera);
            const rect = renderer.domElement;
            const sx = (project.x * 0.5 + 0.5) * rect.clientWidth;
            const sy = (-project.y * 0.5 + 0.5) * rect.clientHeight;
            tagElement.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
            tagElement.style.opacity = '1';
          } else {
            tagElement.style.opacity = '0';
          }
        } else {
          tagElement.style.opacity = '0';
        }
      }

      renderer.render(scene, camera);
    };
    const tick = () => {
      render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    if (import.meta.env.DEV) {
      (window as unknown as { __floodlightScene?: unknown }).__floodlightScene = {
        step: () => render(),
        mode: () => modeRef.current,
        audio: () => broadcast.debugState(),
        visibleCount: () => [...playerObjects.values()].filter((o) => o.figure.group.visible).length,
        positions: () => [...playerObjects.values()].map((o) => [Math.round(o.figure.group.position.x), Math.round(o.figure.group.position.z)]),
        players: () =>
          [...playerObjects.entries()].map(([id, o]) => ({
            id,
            x: Math.round(o.figure.group.position.x * 10) / 10,
            z: Math.round(o.figure.group.position.z * 10) / 10,
            visible: o.figure.group.visible,
          })),
        frame: () => frameRef.current,
        camera: () => [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)],
        screen: () => {
          const canvas = canvasRef.current;
          const frame = frameRef.current;
          if (!canvas || !cameraRef.current || !frame) return [];
          const rect = canvas.getBoundingClientRect();
          const v = new THREE.Vector3();
          return frame.players.map((player) => {
            v.set(player.pos.x, 1.6, player.pos.y).project(cameraRef.current!);
            return {
              id: player.playerId,
              sx: (v.x * 0.5 + 0.5) * rect.width,
              sy: (-v.y * 0.5 + 0.5) * rect.height,
              left: rect.left,
              top: rect.top,
            };
          });
        },
      };
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      for (const object of playerObjects.values()) {
        scene.remove(object.figure.group, object.ring, object.ownerRing, object.teamRing, object.number);
        object.figure.dispose();
        object.ring.geometry.dispose();
        (object.ring.material as THREE.Material).dispose();
        object.ownerRing.geometry.dispose();
        (object.ownerRing.material as THREE.Material).dispose();
        object.teamRing.geometry.dispose();
        (object.teamRing.material as THREE.Material).dispose();
      }
      scene.remove(goals);
      scene.remove(stadium);
      scene.remove(sky);
      stadium.userData.dispose?.();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      for (const texture of numberTextureCache.values()) texture.dispose();
      pitchTexture.dispose();
      ball.geometry.dispose();
      (ball.material as THREE.Material).dispose();
      trailGeometry.dispose();
      teleGeometry.dispose();
      renderer.dispose();
    };
  }, [match]);

  if (!match) return null;

  const active = cuesForViewer(match, t, prefs);
  const lowerThird = cueForSlot(active, 'lower_third');
  const statBumper = cueForSlot(active, 'stat_bumper');
  const ribbon = cueForSlot(active, 'momentum_ribbon');
  const flash = cueForSlot(active, 'goal_flash');
  const tagCue = cueForSlot(active, 'player_tag');
  const focusedName = [...match.lineups.home, ...match.lineups.away, ...match.bench.home, ...match.bench.away]
    .find((p) => p.id === focusPlayerId)?.name ?? null;

  return (
    <div className="program-monitor">
      <canvas
        ref={canvasRef}
        className="monitor-canvas"
        onClick={handleClick}
        onMouseMove={handlePointer}
        title="Click a player to follow them"
      />
      <div className="monitor-cams">
        {(['broadcast', 'tactical', 'follow', 'player'] as CameraMode[]).map((value) => (
          <button
            type="button"
            key={value}
            className={mode === value ? 'active' : ''}
            onClick={() => setMode(value)}
            disabled={value === 'player' && !focusPlayerId}
            title={value === 'player' && focusedName ? `Follow ${focusedName}` : undefined}
          >
            {value === 'broadcast' ? 'Broadcast' : value === 'tactical' ? 'Tactical' : value === 'follow' ? 'Follow ball' : 'Player'}
          </button>
        ))}
        <button
          type="button"
          className={audioOn ? 'active' : ''}
          onClick={() => setAudioOn(audioOn ? (broadcast.disable(), false) : broadcast.enable())}
          title="Crowd, whistles, kicks and the commentary desk"
        >
          {audioOn ? 'audio on' : 'audio off'}
        </button>
      </div>
      <div className="overlay-layer">
        {flash && (
          <div className="cue-goal-flash" key={flash.id}>
            <span>{(flash.payload.headline as string) ?? 'GOAL'}</span>
          </div>
        )}
        {ribbon && (
          <div
            className="cue-ribbon"
            key={ribbon.id}
            style={{ borderColor: teamColor(match, String(ribbon.payload.direction ?? '')) }}
          >
            <span className="ribbon-label">MOMENTUM</span>
            <span className="ribbon-text">{ribbon.payload.headline as string}</span>
          </div>
        )}
        {lowerThird && (
          <div className="cue-lower-third" key={lowerThird.id}>
            <div className="lower-third-bar" style={{ background: teamColor(match, String(lowerThird.payload.team ?? '')) }} />
            <div className="lower-third-text">
              <span className="lower-third-minute">{lowerThird.payload.minuteLabel as string}</span>
              <strong>{lowerThird.payload.headline as string}</strong>
              <p>{lowerThird.payload.body as string}</p>
            </div>
          </div>
        )}
        {statBumper && (
          <div className="cue-stat-bumper" key={statBumper.id}>
            <span className="bumper-minute">{statBumper.payload.minuteLabel as string}</span>
            {(statBumper.payload.stats as Array<{ label: string; value: string | number }>)?.map((stat) => (
              <div className="bumper-row" key={stat.label}>
                <span className="bumper-label">{labelize(stat.label)}</span>
                <span className="bumper-value">{String(stat.value)}</span>
              </div>
            ))}
          </div>
        )}
        <div className={`cue-player-tag${tagCue ? '' : ' hidden'}`} ref={tagRef}>
          {tagCue && (
            <>
              <strong>{playerName(match, String(tagCue.payload.playerId ?? ''))}</strong>
              {tagCue.payload.speedKph != null && <span>{String(tagCue.payload.speedKph)} km/h</span>}
            </>
          )}
        </div>
      </div>
      <div className="monitor-tally">
        <span className="tally-dot" /> {formatClock(t)}
      </div>
    </div>
  );
}

function teamColor(match: NonNullable<ReturnType<typeof useAppStore.getState>['match']>, team: string): string {
  if (team === 'home') return match.meta.home.primary;
  if (team === 'away') return match.meta.away.primary;
  return '#ffd166';
}

function playerName(match: NonNullable<ReturnType<typeof useAppStore.getState>['match']>, id: string): string {
  const all = [...match.lineups.home, ...match.lineups.away];
  return all.find((p) => p.id === id)?.name ?? 'Player';
}

function labelize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
