import { describe, expect, it } from 'vitest';
import type { MatchEvent, TrackingFrame, Vec2 } from '@floodlight/core';
import { SCENARIOS, simulateMatch, type SimulationResult } from '@floodlight/simulator';
import { trackingDiagnostics, trackingWindow } from '../src/tracking';

const seedResult = simulateMatch(12345);
const a = seedResult.lineups.home.starters[6]!.id;
const b = seedResult.lineups.home.starters[8]!.id;
const sub = seedResult.lineups.home.bench.find((p) => p.role !== 'GK')!.id;
const dist = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
const event = (index: number, t: number, type: MatchEvent['type'], at: Vec2, extra: Record<string, unknown> = {}): MatchEvent => ({
  id: `fixture-${index}`, index, t, period: 1, type, team: 'home', playerId: a, at, endAt: null, ...extra,
} as MatchEvent);
const fixture = (events: MatchEvent[], fullTimeT = 60): SimulationResult => ({
  ...seedResult, events, timing: { ...seedResult.timing, fullTimeT },
});
const sample = (r: SimulationResult, t: number): TrackingFrame => trackingWindow(r, t - 0.001, t, { hz: 1000 })[0]!;
const playerAt = (f: TrackingFrame, id: string) => f.players.find((p) => p.playerId === id)!;

function assertDerivedSpeeds(frames: TrackingFrame[], cap = true) {
  let maximumError = 0;
  let maximumSpeed = 0;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const curr = frames[i]!;
    const dt = curr.t - prev.t;
    maximumError = Math.max(maximumError, Math.abs(dist(curr.ball.pos, prev.ball.pos) / dt * 3.6 - curr.ball.speedKph));
    for (const p of curr.players) {
      const before = prev.players.find((v) => v.playerId === p.playerId);
      if (!before) continue;
      const actual = dist(p.pos, before.pos) / dt * 3.6;
      maximumSpeed = Math.max(maximumSpeed, actual);
      maximumError = Math.max(maximumError, Math.abs(actual - p.speedKph));
    }
  }
  expect(maximumError).toBeLessThan(0.001);
  if (cap) expect(maximumSpeed).toBeLessThanOrEqual(36.0001);
}

describe('one deterministic tracking timeline', () => {
  it.each([2, 10])('is partition invariant at %i Hz, including unaligned cuts and reverse seeks', (hz) => {
    const single = trackingWindow({ ...seedResult }, 0, 660, { hz });
    const other = { ...seedResult };
    const end = trackingWindow(other, 600, 660, { hz });
    const middle = trackingWindow(other, 117.037, 600, { hz });
    const beginning = trackingWindow(other, 0, 117.037, { hz });
    expect([...beginning, ...middle, ...end]).toEqual(single);
    expect(trackingWindow(other, 0, 600, { hz }).concat(end)).toEqual(single);
    const cut = hz === 10 ? 600.1 : 600.5;
    expect(end[0]!.t).toBe(cut);
    assertDerivedSpeeds(single.slice(-20));
  });

  it('shares positions between 2 Hz and 10 Hz regardless of which rate prepared the cache', () => {
    const slow = trackingWindow({ ...seedResult }, 40.037, 100.023, { hz: 2 });
    const fast = new Map(trackingWindow({ ...seedResult }, 40.037, 100.023, { hz: 10 }).map((f) => [f.t, f]));
    for (const frame of slow) {
      const other = fast.get(frame.t)!;
      expect(frame.ball.pos).toEqual(other.ball.pos);
      expect(frame.players.map((p) => [p.playerId, p.pos])).toEqual(other.players.map((p) => [p.playerId, p.pos]));
    }
  });

  it.each([2, 10])('reports displacement speeds at %i Hz, including old failure windows', (hz) => {
    assertDerivedSpeeds(trackingWindow(seedResult, 40, 45, { hz }));
    assertDerivedSpeeds(trackingWindow(seedResult, 470, 490, { hz }));
    assertDerivedSpeeds(trackingWindow(seedResult, 599, 602, { hz }));
  });

  it('does not round arbitrary-rate timestamps to tenths or lose fractional boundary frames', () => {
    const r = fixture([]);
    const whole = trackingWindow(r, 0, 1, { hz: 25 });
    expect(whole).toHaveLength(25);
    expect(new Set(whole.map((f) => f.t)).size).toBe(25);
    expect([...trackingWindow(r, 0, 0.137, { hz: 25 }), ...trackingWindow(r, 0.137, 1, { hz: 25 })]).toEqual(whole);
    expect(trackingWindow(r, 0.1, 0.3)).toHaveLength(2);
    expect(() => trackingWindow(r, 0, 1, { hz: 0 })).toThrow(RangeError);
    expect(() => trackingWindow(r, 0, 1, { hz: NaN })).toThrow(RangeError);
    expect(trackingWindow(r, 2, 1)).toEqual([]);
  });

  it('returns independent frame objects, never mutable cached positions', () => {
    const expected = trackingWindow(seedResult, 100, 101);
    const corrupt = trackingWindow(seedResult, 100, 101);
    corrupt[0]!.players[0]!.pos.x = 10000;
    corrupt[0]!.ball.pos.y = 10000;
    expect(trackingWindow(seedResult, 100, 101)).toEqual(expected);
  });
});

describe('authoritative ball and actor constraints', () => {
  const r = fixture([
    event(1, 0, 'kickoff', { x: 0, y: 0 }),
    event(2, 10, 'pass', { x: 0, y: 0 }, { endAt: { x: 12, y: 0 }, recipientId: b, outcome: 'complete' }),
    event(3, 16, 'pass', { x: 12, y: 0 }, { playerId: b, endAt: { x: 0, y: 6 }, recipientId: a, outcome: 'complete' }),
    event(4, 24, 'carry', { x: 0, y: 6 }, { endAt: { x: 6, y: 6 } }),
    event(5, 30, 'pass', { x: 6, y: 6 }, { endAt: { x: 12, y: 0 }, recipientId: b, outcome: 'complete' }),
  ]);

  it.each([2, 10])('reaches every release coordinate exactly at its event time at %i Hz', (hz) => {
    const frames = new Map(trackingWindow(r, 0, 31, { hz }).map((f) => [f.t, f]));
    for (const e of r.events.slice(1)) {
      const frame = frames.get(e.t)!;
      expect(dist(frame.ball.pos, e.at)).toBeLessThan(0.00001);
      expect(dist(playerAt(frame, e.playerId!).pos, e.at)).toBeLessThan(0.00001);
    }
    expect(trackingDiagnostics(r)).toEqual([]);
  });

  it('puts the receiver at the pass endpoint when the ball arrives, not at release', () => {
    const arrival = 10 + 12 / ((28 + 12 * 1.15) / 3.6);
    const frame = sample(r, Math.ceil(arrival * 1000) / 1000);
    expect(dist(frame.ball.pos, { x: 12, y: 0 })).toBeLessThan(0.00001);
    expect(dist(playerAt(frame, b).pos, frame.ball.pos)).toBeLessThan(0.001);
  });

  it('keeps feasible carries on the carrier and reports zero after the final ball motion', () => {
    const frames = trackingWindow(r, 24, 26.05, { hz: 20 });
    for (const frame of frames) expect(dist(frame.ball.pos, playerAt(frame, a).pos)).toBeLessThan(0.00001);
    for (const frame of trackingWindow(r, 55, 60)) expect(frame.ball.speedKph).toBe(0);
  });

  it('limits actual velocity and acceleration, without post-integration separation teleports', () => {
    const frames = trackingWindow(r, 0, 35, { hz: 20 });
    assertDerivedSpeeds(frames);
    let maxAccel = 0;
    for (let i = 2; i < frames.length; i++) {
      const before = frames[i - 2]!;
      const prev = frames[i - 1]!;
      const curr = frames[i]!;
      for (const p of curr.players) {
        const p0 = playerAt(before, p.playerId).pos;
        const p1 = playerAt(prev, p.playerId).pos;
        maxAccel = Math.max(maxAccel, Math.hypot(p.pos.x - 2 * p1.x + p0.x, p.pos.y - 2 * p1.y + p0.y) / 0.05 ** 2);
      }
    }
    expect(maxAccel).toBeLessThanOrEqual(7.002);
  });

  it('never delays an authoritative event to fit a speed heuristic', () => {
    const impossible = fixture([
      event(1, 0, 'kickoff', { x: 0, y: 0 }),
      event(2, 1, 'pass', { x: 0, y: 0 }, { endAt: { x: 50, y: 0 }, outcome: 'complete', recipientId: b }),
      event(3, 1.1, 'pass', { x: 50, y: 0 }, { playerId: b, endAt: { x: -40, y: 0 }, recipientId: a, outcome: 'complete' }),
      event(4, 1.2, 'carry', { x: -40, y: 0 }),
    ]);
    for (const e of impossible.events.slice(1)) expect(sample(impossible, e.t).ball.pos).toEqual(e.at);
    const issues = trackingDiagnostics(impossible);
    expect(issues.some((i) => i.kind === 'ball_speed' && i.requiredSpeedKph! > 1000)).toBe(true);
    expect(issues.some((i) => i.kind === 'player_event_miss' && i.errorM > 20)).toBe(true);
    assertDerivedSpeeds(trackingWindow(impossible, 0, 5));
  });

  it('reports contradictory simultaneous ball coordinates instead of hiding a teleport', () => {
    const contradictory = fixture([
      event(1, 0, 'kickoff', { x: 0, y: 0 }),
      event(2, 10, 'shot', { x: 0, y: 0 }, { endAt: { x: 50, y: 0 }, ballSpeedKph: 90 }),
      event(3, 10, 'save', { x: 50, y: 0 }, { playerId: seedResult.lineups.away.starters[0]!.id, team: 'away' }),
    ]);
    expect(sample(contradictory, 10).ball.pos).toEqual({ x: 0, y: 0 });
    expect(trackingDiagnostics(contradictory)).toContainEqual(expect.objectContaining({
      kind: 'simultaneous_ball_events', eventId: 'fixture-3', t: 10, errorM: 50,
    }));
  });

  it('aligns every non-conflicting seed-12345 physical event, quantifying the rest', () => {
    const issues = trackingDiagnostics(seedResult);
    const conflictIds = new Set(issues.filter((i) => i.kind === 'simultaneous_ball_events').map((i) => i.eventId));
    const frames = new Map(trackingWindow(seedResult, 0, seedResult.timing.fullTimeT + 10).map((f) => [f.t, f]));
    let checked = 0;
    for (const e of seedResult.events) {
      if (e.t === 0 || !['pass', 'carry', 'shot', 'save', 'block', 'interception', 'kickoff', 'tackle'].includes(e.type)) continue;
      const error = dist(frames.get(e.t)!.ball.pos, e.at);
      if (conflictIds.has(e.id)) expect(error).toBeGreaterThan(0.02);
      else expect(error, e.id).toBeLessThan(0.00001);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('roster and independent player lifetimes', () => {
  const substituted = fixture([
    event(1, 0, 'kickoff', { x: 0, y: 0 }),
    event(2, 10, 'substitution', { x: 0, y: 0 }, { playerOffId: a, playerOnId: sub }),
    event(3, 20, 'pass', { x: 4, y: 0 }, { playerId: sub }),
    event(4, 25, 'red_card', { x: 4, y: 0 }, { playerId: sub }),
    event(5, 30, 'pass', { x: 4, y: 0 }, { playerId: sub }),
    event(6, 35, 'substitution', { x: 4, y: 0 }, { playerOffId: b, playerOnId: sub }),
  ]);

  it('spawns the substitute at the outgoing position and preserves every other player', () => {
    const before = sample(substituted, 9.999);
    const after = sample(substituted, 10);
    expect(after.players.some((p) => p.playerId === a)).toBe(false);
    expect(dist(playerAt(before, a).pos, playerAt(after, sub).pos)).toBeLessThan(0.01);
    expect(after.players).toHaveLength(22);
    for (const p of after.players.filter((p) => p.playerId !== sub)) {
      expect(dist(p.pos, playerAt(before, p.playerId).pos)).toBeLessThan(0.011);
    }
    expect(trackingWindow(substituted, 10, 24)).toEqual(trackingWindow(substituted, 0, 24).filter((f) => f.t > 10));
  });

  it('never respawns dismissed players on a seek, actor event or invalid later substitution', () => {
    for (const frame of trackingWindow(substituted, 24.9, 40)) {
      expect(frame.players.some((p) => p.playerId === sub)).toBe(false);
      expect(frame.players).toHaveLength(21);
    }
    expect(trackingDiagnostics(substituted).some((i) => i.kind === 'inactive_actor' && i.eventId === 'fixture-5')).toBe(true);
  });

  it('inherits the outgoing formation slot instead of the bench squad index', () => {
    const baseline = fixture([]);
    const changed = fixture([event(1, 10, 'substitution', { x: 0, y: 0 }, { playerOffId: a, playerOnId: sub })]);
    const expected = playerAt(sample(baseline, 50), a);
    const actual = playerAt(sample(changed, 50), sub);
    expect(actual.pos).toEqual(expected.pos);
  });

  it('uses minutes played, not match time, for fresh-substitute fatigue', () => {
    const late = fixture([
      event(1, 5400, 'substitution', { x: 0, y: 0 }, { playerOffId: a, playerOnId: sub }),
      event(2, 5400, 'pass', { x: -50, y: 0 }, { playerId: sub }),
      event(3, 5408, 'pass', { x: 50, y: 0 }, { playerId: sub }),
    ], 5420);
    const fresh = fixture([
      event(1, 0, 'substitution', { x: 0, y: 0 }, { playerOffId: a, playerOnId: sub }),
      event(2, 0, 'pass', { x: -50, y: 0 }, { playerId: sub }),
      event(3, 8, 'pass', { x: 50, y: 0 }, { playerId: sub }),
    ], 20);
    const maxSpeed = (r: SimulationResult, t0: number) => Math.max(...trackingWindow(r, t0, t0 + 8).map((f) => playerAt(f, sub).speedKph));
    expect(maxSpeed(late, 5400)).toBeCloseTo(maxSpeed(fresh, 0), 3);
  });

  it('keeps real scenario red-card players off for all subsequent chunks', () => {
    const derby = simulateMatch(12345, SCENARIOS.find((s) => s.id === 'derby'));
    const reds = derby.events.filter((e) => e.type === 'red_card');
    expect(reds.length).toBeGreaterThan(0);
    for (const red of reds) {
      for (const frame of trackingWindow(derby, red.t, derby.timing.fullTimeT, { hz: 2 })) {
        expect(frame.players.some((p) => p.playerId === red.playerId)).toBe(false);
      }
    }
  });
});
