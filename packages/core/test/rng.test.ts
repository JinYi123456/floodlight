import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '@floodlight/core';

describe('rng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('float/int respect bounds', () => {
    const rng = createRng(3);
    for (let i = 0; i < 1_000; i++) {
      const f = rng.float(-5, 5);
      expect(f).toBeGreaterThanOrEqual(-5);
      expect(f).toBeLessThan(5);
      const n = rng.int(2, 4);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('chance(p) approximates p', () => {
    const rng = createRng(11);
    let hits = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) if (rng.chance(0.3)) hits++;
    expect(Math.abs(hits / n - 0.3)).toBeLessThan(0.01);
  });

  it('gaussian has plausible moments', () => {
    const rng = createRng(13);
    const values = Array.from({ length: 50_000 }, () => rng.gaussian(10, 2));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean - 10)).toBeLessThan(0.1);
    expect(Math.abs(Math.sqrt(variance) - 2)).toBeLessThan(0.1);
  });

  it('weighted picks honour weights', () => {
    const rng = createRng(17);
    const items = ['a', 'b'] as const;
    let aCount = 0;
    for (let i = 0; i < 20_000; i++) {
      if (rng.weighted(items, (item) => (item === 'a' ? 3 : 1)) === 'a') aCount++;
    }
    expect(Math.abs(aCount / 20_000 - 0.75)).toBeLessThan(0.02);
  });

  it('shuffle keeps elements and does not mutate input', () => {
    const rng = createRng(19);
    const input = [1, 2, 3, 4, 5];
    const output = rng.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...output].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('deriveSeed is stable and sensitive to labels', () => {
    expect(deriveSeed(100, 'sim')).toBe(deriveSeed(100, 'sim'));
    expect(deriveSeed(100, 'sim')).not.toBe(deriveSeed(100, 'tracking'));
    expect(deriveSeed(100, 'sim')).not.toBe(deriveSeed(101, 'sim'));
  });

  it('exposes deterministic state', () => {
    const a = createRng(5);
    const b = createRng(5);
    a.next();
    a.next();
    b.next();
    b.next();
    expect(a.state()).toBe(b.state());
  });
});
