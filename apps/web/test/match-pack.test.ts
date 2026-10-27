import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '@floodlight/core';
import type { PreparedMatch } from '../src/pipeline/protocol';
import { buildModel } from '../src/state/matchPack';

const home = { id: 'h', name: 'Home', abbr: 'HOM', primary: '#d00', secondary: '#111', onPrimary: '#fff' };
const away = { id: 'a', name: 'Away', abbr: 'AWY', primary: '#00d', secondary: '#111', onPrimary: '#fff' };
const meta = {
  id: 'm1', seed: 1, scenario: null, competition: 'Test', venue: { id: 'v', name: 'V', city: 'C', capacity: 1000 },
  kickoffISO: '2026-01-01T00:00:00Z', home, away, homeManager: 'H', awayManager: 'A', referee: 'R',
};

function shot(id: string, t: number, team: 'home' | 'away', xg: number, outcome = 'saved'): MatchEvent {
  return { id, index: 1, t, period: 1, type: 'shot', team, playerId: `${team}-p`, at: { x: 40, y: 0 }, endAt: { x: 52, y: 0 }, outcome, xg } as unknown as MatchEvent;
}
function pass(id: string, t: number, team: 'home' | 'away', x: number): MatchEvent {
  return { id, index: 1, t, period: 1, type: 'pass', team, playerId: `${team}-p`, recipientId: `${team}-q`, at: { x, y: 0 }, endAt: { x: x + 10, y: 0 }, outcome: 'complete' } as unknown as MatchEvent;
}

const events = [
  { id: 'k', index: 0, t: 0, period: 1, type: 'kickoff', team: 'home', playerId: null, at: { x: 0, y: 0 }, endAt: null },
  pass('p1', 100, 'home', 0),
  shot('s1', 600, 'home', 0.2, 'goal'),
  shot('s2', 1200, 'away', 0.3, 'goal'),
  pass('p2', 1300, 'home', 36),
  shot('s3', 2400, 'home', 0.1),
  shot('s4', 3600, 'away', 0.15, 'goal'),
  shot('s5', 4800, 'home', 0.25, 'goal'),
  shot('s6', 5000, 'home', 0.05),
  shot('s7', 5200, 'away', 0.1),
] as unknown as MatchEvent[];

const match = {
  meta,
  timing: { halfTimeT: 2700, fullTimeT: 5400 },
  lineups: { home: [], away: [] }, bench: { home: [], away: [] },
  formations: { home: '4-4-2', away: '4-3-3' },
  events,
  cues: { version: '1.0', matchId: 'm1', cues: [], meta: { homeAbbr: 'HOM', awayAbbr: 'AWY', competition: 'Test', generatedBy: 'test' } },
  moments: [], candidates: [], players: [], traces: [],
  // Home 3, away 2 at full time, with one home goal later disallowed: the
  // live pack must follow this timeline, not count raw shot outcomes.
  scoreTimeline: [
    { t: 0, home: 0, away: 0 },
    { t: 600, home: 1, away: 0 },
    { t: 1200, home: 1, away: 1 },
    { t: 2000, home: 0, away: 1 },
    { t: 3600, home: 0, away: 2 },
    { t: 4800, home: 1, away: 2 },
    { t: 5400, home: 3, away: 2 },
  ],
  providerSummary: { completed: 0, fallback: 0, failed: 0, recorded: false },
} as unknown as PreparedMatch;

describe('Match Pack model', () => {
  it('is decisive at full time and follows the corrected score timeline', () => {
    const model = buildModel(match, 5400);
    expect(model.score).toEqual({ home: 3, away: 2 });
    const last = model.winCurve.at(-1)!;
    expect(last.home).toBe(1);
    expect(last.draw).toBe(0);
    expect(last.away).toBe(0);
  });

  it('never shows events from the future', () => {
    const early = buildModel(match, 599);
    expect(early.shots).toHaveLength(0);
    expect(early.score).toEqual({ home: 0, away: 0 });
  });

  it('includes a shot that has just happened and its cumulative xG', () => {
    const model = buildModel(match, 600);
    expect(model.shots).toHaveLength(1);
    expect(model.aggregates.home.xg).toBeCloseTo(0.2, 10);
    expect(model.score).toEqual({ home: 1, away: 0 });
    const p = model.winCurve.at(-1)!;
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
  });

  it('counts a goal at the linked correction time, not retroactively', () => {
    expect(buildModel(match, 1999).score).toEqual({ home: 1, away: 1 });
    expect(buildModel(match, 2000).score).toEqual({ home: 0, away: 1 });
  });

  it('aggregates completed passes and final-third entries by side', () => {
    const model = buildModel(match, 1300);
    expect(model.aggregates.home.passes).toBe(2);
    expect(model.aggregates.home.completed).toBe(2);
    expect(model.aggregates.home.thirdEntries).toBe(1);
  });
});
