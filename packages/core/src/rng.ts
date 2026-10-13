/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic choice in the pipeline flows through `Rng`. Given the same
 * seed and the same call order, results are byte-for-byte identical across
 * runs, platforms and processes — this is what makes matches reproducible.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Standard normal (Box–Muller). */
  gaussian(mean?: number, stdDev?: number): number;
  /** Pick one element uniformly. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights must be non-negative and not all zero. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  /** Fisher–Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Current internal state — useful in tests and snapshots. */
  state(): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;

  const next = (): number => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    gaussian: (mean = 0, stdDev = 1) => {
      const u = Math.max(next(), Number.EPSILON);
      const v = next();
      return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      return items[Math.floor(next() * items.length)]!;
    },
    weighted: (items, weight) => {
      if (items.length === 0) throw new Error('rng.weighted: empty array');
      const weights = items.map(weight);
      const total = weights.reduce((a, b) => a + b, 0);
      if (!(total > 0)) throw new Error('rng.weighted: total weight must be positive');
      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i]!;
        if (roll <= 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = copy[i]!;
        copy[i] = copy[j]!;
        copy[j] = tmp;
      }
      return copy;
    },
    state: () => s,
  };
  return rng;
}

/** Derive a stable child seed from a parent seed and a label. */
export function deriveSeed(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h === 0 ? 0x9e3779b9 : h;
}
