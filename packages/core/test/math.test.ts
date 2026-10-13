import { describe, expect, it } from 'vitest';
import {
  clamp,
  distance,
  ema,
  formatClock,
  formatMinute,
  lerp,
  mean,
  roundTo,
  stableHash,
  stdDev,
} from '@floodlight/core';

describe('math', () => {
  it('clamp bounds values', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('lerp interpolates', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('roundTo rounds decimal places', () => {
    expect(roundTo(1.23456, 2)).toBe(1.23);
    expect(roundTo(1.23456, 3)).toBe(1.235);
    expect(roundTo(41.9876, 1)).toBe(42);
    expect(roundTo(-1.23456, 2)).toBe(-1.23);
  });

  it('distance computes euclidean length', () => {
    expect(distance(0, 0, 3, 4)).toBe(5);
  });

  it('mean and stdDev', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdDev([2, 4, 6])).toBeCloseTo(2, 5);
    expect(stdDev([5])).toBe(0);
    expect(() => mean([])).toThrow();
  });

  it('ema smooths', () => {
    expect(ema(undefined, 10, 0.5)).toBe(10);
    expect(ema(10, 20, 0.5)).toBe(15);
  });

  it('stableHash ignores key order but not values', () => {
    const a = stableHash({ x: 1, y: [2, 3] });
    const b = stableHash({ y: [2, 3], x: 1 });
    const c = stableHash({ x: 1, y: [2, 4] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('formats clocks', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(4231)).toBe('70:31');
    expect(formatMinute(0)).toBe("1'");
    expect(formatMinute(4231)).toBe("71'");
  });
});
