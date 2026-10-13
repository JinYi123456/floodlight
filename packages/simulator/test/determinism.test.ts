import { describe, expect, it } from 'vitest';
import { stableHash } from '@floodlight/core';
import { SCENARIOS, simulateMatch, summarizeMatch } from '@floodlight/simulator';

describe('simulator determinism', () => {
  it('produces identical event streams for identical seeds', () => {
    const a = simulateMatch(424242);
    const b = simulateMatch(424242);
    expect(stableHash(a.events)).toBe(stableHash(b.events));
    expect(a.meta.id).toBe(b.meta.id);
  });

  it('produces different streams for different seeds', () => {
    const a = simulateMatch(1);
    const b = simulateMatch(2);
    expect(stableHash(a.events)).not.toBe(stableHash(b.events));
  });

  it('is deterministic for scripted scenarios', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'derby')!;
    const a = simulateMatch(777, scenario);
    const b = simulateMatch(777, scenario);
    expect(stableHash(a.events)).toBe(stableHash(b.events));
  });

  it('event indexes are strictly increasing and ids unique', () => {
    const result = simulateMatch(99);
    const ids = new Set<string>();
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i]!.index).toBeGreaterThan(result.events[i - 1]!.index);
      ids.add(result.events[i]!.id);
    }
    expect(ids.size).toBe(result.events.length - 1);
  });

  it('time is monotonically non-decreasing', () => {
    const result = simulateMatch(1616);
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i]!.t).toBeGreaterThanOrEqual(result.events[i - 1]!.t);
    }
  });

  it('kickoff opens the match and full time closes it', () => {
    const result = simulateMatch(2024);
    expect(result.events[0]!.type).toBe('kickoff');
    expect(result.events[result.events.length - 1]!.type).toBe('full_time');
    expect(result.events.some((e) => e.type === 'half_time')).toBe(true);
    expect(result.events.some((e) => e.type === 'second_half')).toBe(false);
  });
});

describe('scripted scenario shape', () => {
  const find = (id: string) => SCENARIOS.find((s) => s.id === id)!;

  it('the comeback: away side scores exactly two early goals, home fights back', () => {
    const result = simulateMatch(12345, find('comeback'));
    const summary = summarizeMatch(result);
    expect(summary.goalsAway).toBe(2);
    const awayGoals = result.events.filter(
      (e) => e.type === 'shot' && (e as { outcome: string }).outcome === 'goal' && e.team === 'away',
    );
    expect(awayGoals.every((g) => g.t <= 33 * 60)).toBe(true);
    expect(summary.goalsHome).toBeGreaterThanOrEqual(2);
    const homeGoals = result.events.filter(
      (e) => e.type === 'shot' && (e as { outcome: string }).outcome === 'goal' && e.team === 'home',
    );
    expect(homeGoals.some((g) => g.t >= 45 * 60)).toBe(true);
  });

  it('the siege: no goals before the 84th minute, then a late winner', () => {
    for (const seed of [11, 12345, 999]) {
      const result = simulateMatch(seed, find('siege'));
      const summary = summarizeMatch(result);
      const allGoals = result.events.filter((e) => e.type === 'shot' && (e as { outcome: string }).outcome === 'goal');
      expect(allGoals.every((g) => g.t >= 84 * 60)).toBe(true);
      expect(summary.goalsHome).toBeGreaterThanOrEqual(1);
    }
  });

  it('the derby: exact 4-3, a red card and a VAR overturn', () => {
    const result = simulateMatch(12345, find('derby'));
    const summary = summarizeMatch(result);
    expect(summary.goalsHome).toBe(4);
    expect(summary.goalsAway).toBe(3);
    expect(summary.redCards).toBeGreaterThanOrEqual(1);
    const overturn = result.events.some(
      (e) => e.type === 'var_check' && (e as { detail: string }).detail.includes('Overturned'),
    );
    expect(overturn).toBe(true);
    const pen = result.events.some((e) => e.type === 'penalty');
    expect(pen).toBe(true);
  });
});

describe('match data integrity', () => {
  it('goals are only recorded via shots with outcome goal', () => {
    const result = simulateMatch(31337);
    for (const e of result.events) {
      if (e.type === 'shot') {
        const shot = e as { xg: number; ballSpeedKph: number; distanceM: number };
        expect(shot.xg).toBeGreaterThan(0);
        expect(shot.xg).toBeLessThanOrEqual(1);
        expect(shot.ballSpeedKph).toBeGreaterThan(30);
        expect(shot.ballSpeedKph).toBeLessThan(130);
        expect(shot.distanceM).toBeGreaterThan(0);
      }
    }
  });

  it('passes carry full quality metrics', () => {
    const result = simulateMatch(5150);
    const passes = result.events.filter((e) => e.type === 'pass') as Array<{
      lengthM: number;
      difficulty: number;
      xtSwing: number;
      outcome: string;
      pressureAtRelease: number;
    }>;
    expect(passes.length).toBeGreaterThan(600);
    for (const p of passes) {
      expect(p.difficulty).toBeGreaterThanOrEqual(0);
      expect(p.difficulty).toBeLessThanOrEqual(1);
      expect(p.lengthM).toBeGreaterThan(0);
      expect(p.lengthM).toBeLessThan(90);
      expect(['complete', 'incomplete', 'out']).toContain(p.outcome);
      expect(p.pressureAtRelease).toBeGreaterThanOrEqual(0);
    }
  });

  it('all event coordinates lie on the pitch', () => {
    const result = simulateMatch(606);
    for (const e of result.events) {
      expect(Math.abs(e.at.x)).toBeLessThanOrEqual(54);
      expect(Math.abs(e.at.y)).toBeLessThanOrEqual(35.5);
      if (e.endAt) {
        expect(Math.abs(e.endAt.x)).toBeLessThanOrEqual(54.5);
        expect(Math.abs(e.endAt.y)).toBeLessThanOrEqual(36);
      }
    }
  });

  it('both lineups field eleven players with unique names', () => {
    const result = simulateMatch(808);
    const names = new Set<string>();
    for (const side of ['home', 'away'] as const) {
      expect(result.lineups[side].starters).toHaveLength(11);
      for (const p of result.lineups[side].starters) {
        expect(names.has(p.name)).toBe(false);
        names.add(p.name);
      }
    }
  });
});
