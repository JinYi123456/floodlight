import { describe, expect, it } from 'vitest';
import { stableHash } from '@floodlight/core';
import { SCENARIOS, simulateMatch, summarizeMatch, trackingWindow } from '@floodlight/simulator';
import { MatchEngine } from '@floodlight/engine';

function runFull(seed: number, scenarioId?: string) {
  const scenario = scenarioId ? SCENARIOS.find((s) => s.id === scenarioId) : undefined;
  const result = simulateMatch(seed, scenario);
  const engine = new MatchEngine(result.meta, result.lineups);
  const candidates = result.events.flatMap((e) => engine.ingestEvent(e));
  return { result, engine, candidates };
}

describe('engine — interpret stage', () => {
  const { result, engine, candidates } = runFull(12345);

  it('final score agrees with the summary (including VAR overturns)', () => {
    const summary = summarizeMatch(result);
    const state = engine.snapshot();
    expect(state.score.home).toBe(summary.goalsHome);
    expect(state.score.away).toBe(summary.goalsAway);
  });

  it('team stats mirror the event stream', () => {
    const state = engine.snapshot();
    const passEvents = result.events.filter((e) => e.type === 'pass').length;
    expect(state.teams.home.passes + state.teams.away.passes).toBe(passEvents);
    const goals = state.teams.home.goals + state.teams.away.goals;
    expect(goals).toBe(state.score.home + state.score.away);
  });

  it('possession shares are plausible and sum to one', () => {
    const state = engine.snapshot();
    const total = state.possession.home + state.possession.away;
    expect(total).toBeCloseTo(1, 2);
    expect(state.possession.home).toBeGreaterThan(0.2);
    expect(state.possession.home).toBeLessThan(0.8);
  });

  it('control/chaos and rhythm are well-formed', () => {
    const state = engine.snapshot();
    expect(state.controlChaos.control).toBeGreaterThanOrEqual(0);
    expect(state.controlChaos.control).toBeLessThanOrEqual(1);
    expect(state.controlChaos.chaos).toBeGreaterThanOrEqual(0);
    expect(state.controlChaos.chaos).toBeLessThanOrEqual(1);
    expect(['controlled', 'balanced', 'contested', 'chaotic']).toContain(state.controlChaos.label);
    expect(typeof state.rhythm.label).toBe('string');
    expect(state.rhythm.confidence).toBeGreaterThan(0);
  });

  it('momentum series spans the match and stays bounded', () => {
    const state = engine.snapshot();
    expect(state.momentum.series.length).toBeGreaterThan(80);
    for (const point of state.momentum.series) {
      expect(point.value).toBeGreaterThanOrEqual(-1);
      expect(point.value).toBeLessThanOrEqual(1);
    }
  });

  it('records a goal candidate per goal, with structured facts', () => {
    const state = engine.snapshot();
    const goalCandidates = candidates.filter((c) => c.kind === 'goal');
    const scored = state.score.home + state.score.away;
    const overturned = goalCandidates.filter((c) => c.overturned).length;
    expect(goalCandidates.length - overturned).toBe(scored);
    for (const c of goalCandidates) {
      expect(c.facts['score']).toBeTypeOf('string');
      expect(c.evidenceEventIds.length).toBeGreaterThan(0);
      expect(c.minuteLabel).toMatch(/'$/);
    }
  });

  it('player goals reconcile with team goals', () => {
    const state = engine.snapshot();
    const playerGoals = state.players.reduce((acc, p) => acc + p.goals, 0);
    expect(playerGoals).toBe(state.score.home + state.score.away);
    const assists = state.players.reduce((acc, p) => acc + p.assists, 0);
    expect(assists).toBeLessThanOrEqual(playerGoals);
  });

  it('is deterministic end to end', () => {
    const again = runFull(12345);
    expect(stableHash(again.engine.snapshot())).toBe(stableHash(engine.snapshot()));
    expect(stableHash(again.candidates)).toBe(stableHash(candidates));
  });

  it('windowFeatures aggregates match per-team shot counts', () => {
    const state = engine.snapshot();
    const features = engine.windowFeatures(0, state.clockSeconds);
    expect(features.shots).toBe(state.teams.home.shots + state.teams.away.shots);
    expect(features.possessionHome).toBeCloseTo(state.possession.home, 1);
  });
});

describe('engine — physical metrics from tracking', () => {
  it('accumulates distance, top speed and sprints', () => {
    const result = simulateMatch(4242);
    const engine = new MatchEngine(result.meta, result.lineups);
    const frames = trackingWindow(result, 900, 1200);
    for (const frame of frames) engine.ingestFrame(frame);
    const state = engine.snapshot();
    const tracked = state.players.filter((p) => p.role !== 'GK' && p.distanceKm > 0);
    expect(tracked.length).toBeGreaterThanOrEqual(20);
    for (const p of tracked) {
      expect(p.distanceKm).toBeGreaterThan(0.1);
      expect(p.topSpeedKph).toBeGreaterThan(0);
      expect(p.topSpeedKph).toBeLessThan(37);
    }
    expect(state.teams.home.distanceCoveredKm + state.teams.away.distanceCoveredKm).toBeGreaterThan(4);
  });
});

describe('engine — storyline moments', () => {
  it('the derby produces a VAR overturn tied to a flagged goal', () => {
    const { candidates } = runFull(12345, 'derby');
    const overturn = candidates.find((c) => c.kind === 'var_overturn');
    expect(overturn).toBeDefined();
    const flagged = candidates.filter((c) => c.kind === 'goal' && c.overturned);
    expect(flagged.length).toBe(1);
    expect(candidates.some((c) => c.kind === 'red_card')).toBe(true);
    expect(candidates.some((c) => c.kind === 'penalty')).toBe(true);
  });

  it('the comeback produces comeback-trigger and late-drama moments', () => {
    const { candidates } = runFull(12345, 'comeback');
    expect(candidates.some((c) => c.kind === 'comeback_trigger')).toBe(true);
    expect(candidates.some((c) => c.kind === 'late_drama' || c.kind === 'momentum_shift')).toBe(true);
  });

  it('the siege produces a siege moment and big save', () => {
    const { candidates } = runFull(12345, 'siege');
    expect(candidates.some((c) => c.kind === 'siege')).toBe(true);
    expect(candidates.some((c) => c.kind === 'big_save')).toBe(true);
  });

  it('every candidate carries facts and a salience score', () => {
    const { candidates } = runFull(999, 'comeback');
    expect(candidates.length).toBeGreaterThan(8);
    for (const c of candidates) {
      expect(c.salience).toBeGreaterThan(0);
      expect(c.salience).toBeLessThanOrEqual(1);
      expect(Object.keys(c.facts).length).toBeGreaterThan(0);
      expect(c.id).toMatch(/^cand-\d{4}$/);
    }
  });
});
