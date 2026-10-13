/**
 * The detector — connected-component analysis over the rendered feed.
 *
 * Grass is recognised by chroma, whites by luminance, players by everything
 * else. Blob colours are clustered into two kit palettes (learned from the
 * feed itself, no ground truth), and every blob becomes an entity in pitch
 * metres via the known camera projection.
 */

import type { Projection } from './raster';
import { toPitch } from './raster';

export interface DetectedEntity {
  cls: 'ball' | 'home' | 'away';
  /** Pitch metres. */
  x: number;
  y: number;
  /** Blob pixel area (for diagnostics). */
  size: number;
  color: [number, number, number];
}

export interface KitPalettes {
  home: [number, number, number];
  away: [number, number, number];
}

interface Blob {
  area: number;
  sumR: number;
  sumG: number;
  sumB: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sumX: number;
  sumY: number;
  /** Raw pixels [x, y, r, g, b] for blobs that may need splitting. */
  slices?: Array<[number, number, number, number, number]>;
}

const MAX_BLOBS = 400;

function isGrass(r: number, g: number, b: number): boolean {
  return g > r + 12 && g > b + 8 && g > 45;
}

function isWhite(r: number, g: number, b: number): boolean {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return min > 185 && max - min < 46;
}

/**
 * The ball is rendered brighter than the painted markings, so a high
 * brightness band separates it from line fragments even before shape
 * filtering.
 */
function isBallWhite(r: number, g: number, b: number): boolean {
  return Math.min(r, g, b) > 233;
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Learn the two kit palettes with a tiny 2-means over blob colours. Blobs
 * that are neither white nor grass are candidate shirts. Deterministic.
 */
export function learnPalettes(frame: { width: number; height: number; rgba: Uint8ClampedArray }): KitPalettes {
  const colors = collectBlobs(frame).map((blob) => blobColor(blob));
  if (colors.length < 2) {
    return { home: [214, 38, 61], away: [31, 78, 156] };
  }
  // Initialise with the two most distant colours.
  let a = colors[0]!;
  let b = colors[0]!;
  let best = -1;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const d = colorDistance(colors[i]!, colors[j]!);
      if (d > best) {
        best = d;
        a = colors[i]!;
        b = colors[j]!;
      }
    }
  }
  for (let iteration = 0; iteration < 6; iteration++) {
    const groupA: Array<[number, number, number]> = [];
    const groupB: Array<[number, number, number]> = [];
    for (const color of colors) {
      if (colorDistance(color, a) <= colorDistance(color, b)) groupA.push(color);
      else groupB.push(color);
    }
    a = meanColor(groupA, a);
    b = meanColor(groupB, b);
  }
  return { home: a, away: b };
}

function meanColor(
  group: Array<[number, number, number]>,
  fallback: [number, number, number],
): [number, number, number] {
  if (group.length === 0) return fallback;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const color of group) {
    r += color[0];
    g += color[1];
    b += color[2];
  }
  return [r / group.length, g / group.length, b / group.length];
}

function blobColor(blob: Blob): [number, number, number] {
  return [blob.sumR / blob.area, blob.sumG / blob.area, blob.sumB / blob.area];
}

function collectBlobs(frame: { width: number; height: number; rgba: Uint8ClampedArray }): Blob[] {
  const { width, height, rgba } = frame;
  const visited = new Uint8Array(width * height);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < width * height; start++) {
    if (visited[start]) continue;
    const i = start * 4;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    if (isGrass(r, g, b) || isWhite(r, g, b)) {
      visited[start] = 1;
      continue;
    }
    // Flood fill this non-grass, non-white region.
    let area = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    const slices: Array<[number, number, number, number, number]> = [];
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      const pi = p * 4;
      const pr = rgba[pi]!;
      const pg = rgba[pi + 1]!;
      const pb = rgba[pi + 2]!;
      area++;
      sumR += pr;
      sumG += pg;
      sumB += pb;
      sumX += x;
      sumY += y;
      if (slices.length < 600 && area <= 460) slices.push([x, y, pr, pg, pb]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ];
      for (const np of neighbors) {
        if (np < 0 || visited[np]) continue;
        const ni = np * 4;
        const nr = rgba[ni]!;
        const ng = rgba[ni + 1]!;
        const nb = rgba[ni + 2]!;
        if (isGrass(nr, ng, nb) || isWhite(nr, ng, nb)) continue;
        visited[np] = 1;
        stack.push(np);
      }
      if (area > 600) break; // region way too big to be entities
    }
    if (area >= 4) {
      blobs.push({
        area,
        sumR,
        sumG,
        sumB,
        minX,
        maxX,
        minY,
        maxY,
        sumX,
        sumY,
        slices: area <= 460 ? slices : undefined,
      });
      if (blobs.length >= MAX_BLOBS) break;
    }
  }
  return blobs;
}

/** Ball-bright blobs: the ball itself, never markings. */
function collectWhiteBlobs(frame: { width: number; height: number; rgba: Uint8ClampedArray }): Blob[] {
  const { width, height, rgba } = frame;
  const visited = new Uint8Array(width * height);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < width * height; start++) {
    if (visited[start]) continue;
    const i = start * 4;
    if (!isBallWhite(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)) continue;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      const pi = p * 4;
      area++;
      sumX += x;
      sumY += y;
      sumR += rgba[pi]!;
      sumG += rgba[pi + 1]!;
      sumB += rgba[pi + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ];
      for (const np of neighbors) {
        if (np < 0 || visited[np]) continue;
        const ni = np * 4;
        if (!isBallWhite(rgba[ni]!, rgba[ni + 1]!, rgba[ni + 2]!)) continue;
        visited[np] = 1;
        stack.push(np);
      }
      if (area > 4000) break; // sanity cap
    }
    if (area >= 2) {
      blobs.push({ area, sumR, sumG, sumB, minX, maxX, minY, maxY, sumX, sumY });
    }
  }
  return blobs;
}

export interface DetectOptions {
  projection: Projection;
  palettes: KitPalettes;
  /** Where the ball was last frame (pitch metres), to disambiguate. */
  ballHint?: { x: number; y: number } | null;
}

export function detectEntities(
  frame: { width: number; height: number; rgba: Uint8ClampedArray },
  options: DetectOptions,
): DetectedEntity[] {
  const { projection, palettes, ballHint } = options;
  const entities: DetectedEntity[] = [];

  // Ball: small, round white blobs only — line fragments are rejected by
  // fill ratio. Among survivors prefer the one nearest the last known spot.
  const whiteBlobs = collectWhiteBlobs(frame).filter((blob) => {
    const w = blob.maxX - blob.minX + 1;
    const h = blob.maxY - blob.minY + 1;
    if (blob.area < 4 || blob.area > 42) return false;
    if (w > 9 || h > 9) return false;
    if (blob.area / (w * h) < 0.5) return false;
    return true;
  });
  let ball: Blob | null = null;
  let ballScore = -Infinity;
  for (const blob of whiteBlobs) {
    const cx = blob.sumX / blob.area;
    const cy = blob.sumY / blob.area;
    const pitchPos = toPitch(projection, cx, cy);
    let score = blob.area * 0.5;
    if (ballHint) {
      const d = Math.hypot(pitchPos.x - ballHint.x, pitchPos.y - ballHint.y);
      score += 30 - Math.min(d, 30);
    }
    if (score > ballScore) {
      ballScore = score;
      ball = blob;
    }
  }
  if (ball) {
    const pitchPos = toPitch(projection, ball.sumX / ball.area, ball.sumY / ball.area);
    entities.push({
      cls: 'ball',
      x: pitchPos.x,
      y: pitchPos.y,
      size: ball.area,
      color: [246, 249, 249],
    });
  }

  // Players: non-grass, non-white blobs. Players in contact merge into one
  // blob — split those into roughly one entity per shirt area.
  const PLAYER_AREA = 58;
  for (const blob of collectBlobs(frame)) {
    if (blob.area < 12 || blob.area > 420) continue;
    const w = blob.maxX - blob.minX + 1;
    const h = blob.maxY - blob.minY + 1;
    const count = Math.max(1, Math.round(blob.area / PLAYER_AREA));
    if (count === 1) {
      if (w > 17 || h > 17) continue;
      entities.push(blobEntity(blob, blob.sumX / blob.area, blob.sumY / blob.area, blobColor(blob), palettes, projection));
      continue;
    }
    // Split along the longer axis into `count` equal-width slices.
    const slices = blob.slices;
    if (!slices) continue;
    const byX = w >= h;
    const min = byX ? blob.minX : blob.minY;
    const max = byX ? blob.maxX : blob.maxY;
    const width = Math.max(1, (max - min + 1) / count);
    const buckets: Array<{ count: number; sumX: number; sumY: number; sumR: number; sumG: number; sumB: number }> =
      Array.from({ length: count }, () => ({ count: 0, sumX: 0, sumY: 0, sumR: 0, sumG: 0, sumB: 0 }));
    for (const [x, y, r, g, b] of slices) {
      const key = byX ? x : y;
      const index = Math.min(count - 1, Math.floor((key - min) / width));
      const bucket = buckets[index]!;
      bucket.count++;
      bucket.sumX += x;
      bucket.sumY += y;
      bucket.sumR += r;
      bucket.sumG += g;
      bucket.sumB += b;
    }
    for (const bucket of buckets) {
      if (bucket.count < 10) continue;
      const color: [number, number, number] = [
        bucket.sumR / bucket.count,
        bucket.sumG / bucket.count,
        bucket.sumB / bucket.count,
      ];
      entities.push(
        blobEntity(blob, bucket.sumX / bucket.count, bucket.sumY / bucket.count, color, palettes, projection),
      );
    }
  }

  return entities;
}

function blobEntity(
  _blob: Blob,
  cx: number,
  cy: number,
  color: [number, number, number],
  palettes: KitPalettes,
  projection: Projection,
): DetectedEntity {
  const dHome = colorDistance(color, palettes.home);
  const dAway = colorDistance(color, palettes.away);
  const pitchPos = toPitch(projection, cx, cy);
  return {
    cls: dHome <= dAway ? 'home' : 'away',
    x: pitchPos.x,
    y: pitchPos.y,
    size: 0,
    color,
  };
}
