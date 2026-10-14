/**
 * The rendered feed — a software rasterizer that draws the match to RGBA
 * pixels the way a tactical camera would see it: mow stripes, lines, kit
 * coloured players, a white ball and faint fixed-pattern sensor grain.
 *
 * The rasterizer consumes precomputed tracking frames, so both the batch
 * analyser and the live vision lab render exactly the same pixels. Nothing
 * but pixels leaves the detector — ids and ground truth stay on the
 * scoring side of the wall.
 */

import type { SimulationResult } from '@floodlight/simulator';
import { trackingWindow } from '@floodlight/simulator';
import type { TrackingFrame } from '@floodlight/core';
import { createRng, deriveSeed } from '@floodlight/core';

export interface RenderedFrame {
  width: number;
  height: number;
  /** RGBA pixels, row-major. */
  rgba: Uint8ClampedArray;
  /** Ground-truth positions in pitch metres (for scoring only). */
  truth: {
    ball: { x: number; y: number; speedKph: number };
    players: Array<{ playerId: string; x: number; y: number; speedKph: number; team: 'home' | 'away' }>;
  };
}

export interface Projection {
  scale: number;
  ox: number;
  oy: number;
  width: number;
  height: number;
}

const MARGIN_PX = 6;
const GRASS_STRIPES: Array<[number, number, number]> = [
  [23, 89, 54],
  [20, 80, 47],
];

export function projection(width: number, height: number): Projection {
  const scale = Math.min((width - MARGIN_PX * 2) / 105, (height - MARGIN_PX * 2) / 68);
  return {
    scale,
    ox: (width - 105 * scale) / 2,
    oy: (height - 68 * scale) / 2,
    width,
    height,
  };
}

export function px(projection: Projection, x: number): number {
  return projection.ox + (x + 52.5) * projection.scale;
}
export function py(projection: Projection, y: number): number {
  return projection.oy + (y + 34) * projection.scale;
}

/** Inverse: pixel → pitch metres. */
export function toPitch(projection: Projection, pxv: number, pyv: number): { x: number; y: number } {
  return {
    x: (pxv - projection.ox) / projection.scale - 52.5,
    y: (pyv - projection.oy) / projection.scale - 34,
  };
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * Fixed-pattern sensor grain: the same faint speck sits on the same pixel
 * every frame, like a real sensor — per-frame random specks made the feed
 * look like it was snowing. Dark specks read as dirty pixels on a projector
 * feed, so the grain only ever *brightens* a pixel slightly.
 */
interface SensorMap {
  noise: Array<{ index: number; jitter: number }>;
}

const sensorMaps = new Map<string, SensorMap>();

function sensorMapFor(width: number, height: number): SensorMap {
  const key = `${width}x${height}`;
  const cached = sensorMaps.get(key);
  if (cached) return cached;
  const rng = createRng(0x5e05_eed);
  const noise: Array<{ index: number; jitter: number }> = [];
  const noiseCount = Math.round(width * height * 0.0016);
  for (let n = 0; n < noiseCount; n++) {
    noise.push({ index: (rng.int(0, height - 1) * width + rng.int(0, width - 1)) * 4, jitter: rng.int(2, 7) });
  }
  const map = { noise };
  sensorMaps.set(key, map);
  return map;
}

export interface RasterOptions {
  width?: number;
  height?: number;
  homePrimary: string;
  awayPrimary: string;
  /** Which player ids belong to the home side. */
  homeIds: Set<string>;
}

/**
 * Draw one frame of the feed from its tracking frame plus a short trail.
 * Pixels only — no ids in the output.
 */
export function renderPixels(current: TrackingFrame, trail: TrackingFrame[], options: RasterOptions): RenderedFrame {
  const width = options.width ?? 320;
  const height = options.height ?? 208;
  const proj = projection(width, height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const rng = createRng(deriveSeed(0x5eed_f33d, `t${Math.round(current.t * 10)}`));

  const homeRgb = parseHex(options.homePrimary);
  const awayRgb = parseHex(options.awayPrimary);
  const flicker = 0.97 + rng.next() * 0.06;

  const put = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r * flicker;
    rgba[i + 1] = g * flicker;
    rgba[i + 2] = b * flicker;
    rgba[i + 3] = 255;
  };

  // Background and grass stripes.
  const pitchLeft = Math.round(proj.ox);
  const pitchTop = Math.round(proj.oy);
  const pitchRight = Math.round(proj.ox + 105 * proj.scale);
  const pitchBottom = Math.round(proj.oy + 68 * proj.scale);
  const stripeW = (105 * proj.scale) / 10;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= pitchLeft && x < pitchRight && y >= pitchTop && y < pitchBottom) {
        const band = Math.min(9, Math.floor((x - pitchLeft) / stripeW));
        const [r, g, b] = GRASS_STRIPES[band % 2]!;
        put(x, y, r, g, b);
      } else {
        put(x, y, 10, 16, 23);
      }
    }
  }

  // Markings.
  const drawLine = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2);
    for (let s = 0; s <= steps; s++) {
      const k = s / steps;
      put(Math.round(x0 + (x1 - x0) * k), Math.round(y0 + (y1 - y0) * k), 226, 236, 226);
    }
  };
  const drawRect = (x0: number, y0: number, x1: number, y1: number) => {
    drawLine(x0, y0, x1, y0);
    drawLine(x1, y0, x1, y1);
    drawLine(x1, y1, x0, y1);
    drawLine(x0, y1, x0, y0);
  };
  const PX = (x: number) => px(proj, x);
  const PY = (y: number) => py(proj, y);
  drawRect(PX(-52.5), PY(-34), PX(52.5), PY(34));
  drawLine(PX(0), PY(-34), PX(0), PY(34));
  const circleSteps = 46;
  for (let s = 0; s < circleSteps; s++) {
    const a0 = (s / circleSteps) * Math.PI * 2;
    const a1 = ((s + 1) / circleSteps) * Math.PI * 2;
    drawLine(
      PX(Math.cos(a0) * 9.15),
      PY(Math.sin(a0) * 9.15),
      PX(Math.cos(a1) * 9.15),
      PY(Math.sin(a1) * 9.15),
    );
  }
  for (const s of [-1, 1]) {
    drawRect(PX(s * 52.5), PY(-20.15), PX(s * 36), PY(20.15));
    drawRect(PX(s * 52.5), PY(-9.16), PX(s * 47), PY(9.16));
    drawLine(PX(s * 52.5), PY(-3.66), PX(s * 52.5), PY(3.66));
  }

  // Fixed-pattern sensor grain (same pixels every frame, brightening only).
  const sensor = sensorMapFor(width, height);
  for (const { index, jitter } of sensor.noise) {
    rgba[index] = rgba[index]! + jitter;
    rgba[index + 1] = rgba[index + 1]! + jitter;
    rgba[index + 2] = rgba[index + 2]! + jitter;
  }

  // Ball trail (a short smear, dimmer than the ball).
  const trailDot = Math.max(1, Math.round(proj.scale * 0.4));
  for (const past of trail) {
    const bx = Math.round(PX(past.ball.pos.x));
    const by = Math.round(PY(past.ball.pos.y));
    for (let dy = -trailDot; dy <= trailDot; dy++) {
      for (let dx = -trailDot; dx <= trailDot; dx++) put(bx + dx, by + dy, 202, 208, 208);
    }
  }

  // Players: kit-coloured discs with a bright rim, capped below the ball's
  // white so adjacent players never read as one blob (or as the ball).
  const radiusPx = Math.max(2, Math.round(1.05 * proj.scale));
  for (const player of current.players) {
    const isHome = options.homeIds.has(player.playerId);
    const [r, g, b] = isHome ? homeRgb : awayRgb;
    const rim: [number, number, number] = [Math.min(210, r * 0.5 + 120), Math.min(210, g * 0.5 + 120), Math.min(210, b * 0.5 + 120)];
    const cx = Math.round(PX(player.pos.x));
    const cy = Math.round(PY(player.pos.y));
    for (let dy = -radiusPx - 1; dy <= radiusPx + 1; dy++) {
      for (let dx = -radiusPx - 1; dx <= radiusPx + 1; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= radiusPx - 0.4) put(cx + dx, cy + dy, r, g, b);
        else if (d <= radiusPx + 0.6) put(cx + dx, cy + dy, rim[0], rim[1], rim[2]);
      }
    }
  }

  // Ball: white disc on top of everything (scales with the sensor so it
  // stays visible at higher resolutions).
  const ballRadius = Math.max(1.6, 0.5 * proj.scale);
  const bx = Math.round(PX(current.ball.pos.x));
  const by = Math.round(PY(current.ball.pos.y));
  const br = Math.ceil(ballRadius);
  for (let dy = -br; dy <= br; dy++) {
    for (let dx = -br; dx <= br; dx++) {
      if (Math.hypot(dx, dy) <= ballRadius) put(bx + dx, by + dy, 246, 249, 249);
    }
  }

  return {
    width,
    height,
    rgba,
    truth: {
      ball: {
        x: current.ball.pos.x,
        y: current.ball.pos.y,
        speedKph: current.ball.speedKph,
      },
      players: current.players.map((player) => ({
        playerId: player.playerId,
        x: player.pos.x,
        y: player.pos.y,
        speedKph: player.speedKph,
        team: options.homeIds.has(player.playerId) ? ('home' as const) : ('away' as const),
      })),
    },
  };
}

/** Home-side player ids for a match result. */
export function homeIdSet(result: SimulationResult): Set<string> {
  return new Set([
    ...result.lineups.home.starters.map((p) => p.id),
    ...result.lineups.home.bench.map((p) => p.id),
  ]);
}

/**
 * Convenience wrapper for a single live frame: integrates a short warm-up
 * window ending at t and renders the final frame.
 */
export function renderFeedFrame(
  result: SimulationResult,
  t: number,
  width = 320,
  height = 208,
): RenderedFrame {
  const frames = trackingWindow(result, Math.max(0, t - 1.8), t + 0.11, { hz: 10 });
  const current = frames[frames.length - 1];
  if (!current) {
    // Fallback: render an empty frame at the kickoff state.
    const kickoff = trackingWindow(result, 0, 0.11, { hz: 10 });
    return renderPixels(kickoff[kickoff.length - 1]!, [], {
      width,
      height,
      homePrimary: result.meta.home.primary,
      awayPrimary: result.meta.away.primary,
      homeIds: homeIdSet(result),
    });
  }
  return renderPixels(current, frames.slice(-6, -1), {
    width,
    height,
    homePrimary: result.meta.home.primary,
    awayPrimary: result.meta.away.primary,
    homeIds: homeIdSet(result),
  });
}
