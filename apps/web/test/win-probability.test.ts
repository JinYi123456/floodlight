import { describe, expect, it } from 'vitest';
import { poissonOutcomes, poissonPmf } from '../src/state/winProbability';

describe('Poisson win probability', () => {
  it('uses the correct PMF including the first goal term', () => {
    expect(poissonPmf(0, 2)).toBeCloseTo(Math.exp(-2), 10);
    expect(poissonPmf(1, 2)).toBeCloseTo(2 * Math.exp(-2), 10);
    expect(poissonPmf(2, 2)).toBeCloseTo(2 * Math.exp(-2), 10);
  });

  it('returns summable Poisson mass', () => {
    const mass = Array.from({ length: 101 }, (_, k) => poissonPmf(k, 1.7)).reduce((a, b) => a + b, 0);
    expect(mass).toBeCloseTo(1, 6);
  });

  it('normalises home, draw and away to one at every minute', () => {
    for (const t of [0, 900, 2700, 4500, 5200]) {
      const p = poissonOutcomes(0, 0.8, 0.9, t, 5400);
      expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
      expect(p.home).toBeGreaterThanOrEqual(0);
      expect(p.draw).toBeGreaterThanOrEqual(0);
      expect(p.away).toBeGreaterThanOrEqual(0);
    }
  });

  it('is symmetric at level scores and level xG', () => {
    const p = poissonOutcomes(0, 1.1, 1.1, 1800, 5400);
    expect(p.home).toBeCloseTo(p.away, 10);
  });

  it('is decisive at full time', () => {
    expect(poissonOutcomes(1, 5, 0, 5400, 5400)).toEqual({ home: 1, draw: 0, away: 0 });
    expect(poissonOutcomes(0, 5, 0, 5400, 5400)).toEqual({ home: 0, draw: 1, away: 0 });
    expect(poissonOutcomes(-2, 0, 4, 5400, 5400)).toEqual({ home: 0, draw: 0, away: 1 });
  });

  it('does not give a losing side a majority of the win mass after full time', () => {
    const p = poissonOutcomes(-1, 2, 1, 5400, 5400);
    expect(p.home).toBe(0);
    expect(p.away).toBe(1);
  });

  it('moves toward the current leader as time runs out', () => {
    const early = poissonOutcomes(1, 1, 1, 900, 5400);
    const late = poissonOutcomes(1, 1, 1, 5200, 5400);
    expect(late.home).toBeGreaterThan(early.home);
    expect(late.draw).toBeLessThan(early.draw);
  });
});
