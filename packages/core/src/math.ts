/**
 * Small deterministic math utilities shared across packages.
 * No external dependencies, no floating-point surprises in comparisons:
 * anything that feeds a hash is rounded through `roundTo`.
 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function magnitude(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function normalize2(x: number, y: number): { x: number; y: number } {
  const m = magnitude(x, y);
  if (m < 1e-9) return { x: 0, y: 0 };
  return { x: x / m, y: y / m };
}

/** Angle in degrees of vector (x, y), 0° pointing along +x. */
export function angleDeg(x: number, y: number): number {
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Mean of a non-empty array. Throws on empty input to surface bugs early. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('mean: empty array');
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

/** Simple exponential moving average helper. */
export function ema(previous: number | undefined, value: number, alpha: number): number {
  if (previous === undefined) return value;
  return previous + alpha * (value - previous);
}

/**
 * FNV-1a hash over a JSON-serialized value with sorted keys.
 * Used for reproducibility tests and content-addressed ids.
 */
export function stableHash(value: unknown): string {
  const json = JSON.stringify(sortKeysDeep(value));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Format seconds as match clock, e.g. 4231 -> "70:31". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** Format match-time as a broadcast minute label, e.g. 4231 -> "70'". */
export function formatMinute(seconds: number): string {
  return `${Math.max(1, Math.ceil(seconds / 60))}'`;
}
