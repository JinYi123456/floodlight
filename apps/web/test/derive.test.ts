import { describe, expect, it } from 'vitest';
import type { MatchEvent, MatchMeta } from '@floodlight/core';
import type { InsightCandidate } from '@floodlight/engine';
import type { NarratedMoment } from '@floodlight/agents';
import type { PreparedMatch } from '../src/pipeline/protocol';
import {
  buildFeed,
  deskAt,
  matchesPreferences,
  retractionAt,
  scoreAt,
  textForViewer,
  tickerAt,
  type ViewerSelection,
} from '../src/state/derive';

const home = { id: 'h', name: 'Home FC', abbr: 'HOM', primary: '#d00', secondary: '#111', onPrimary: '#fff' };
const away = { id: 'a', name: 'Away FC', abbr: 'AWY', primary: '#00d', secondary: '#111', onPrimary: '#fff' };
const meta: MatchMeta = {
  id: 'm1', seed: 1, scenario: null, competition: 'Test League',
  venue: { id: 'v', name: 'Test Ground', city: 'Test', capacity: 1000 },
  kickoffISO: '2026-01-01T00:00:00Z', home, away,
  homeManager: 'H', awayManager: 'A', referee: 'R',
};

const prefs: ViewerSelection = { persona: 'analyst', lang: 'en', clubId: null, playerId: null, metric: null };

function candidate(over: Partial<InsightCandidate> & Pick<InsightCandidate, 'id' | 't' | 'kind'>): InsightCandidate {
  return {
    minuteLabel: `${Math.floor(over.t / 60) + 1}'`, salience: 0.8, team: 'home', playerId: null,
    facts: {}, evidenceEventIds: [], window: null, provisional: false, overturned: false, ...over,
  };
}

function moment(c: InsightCandidate, over: Partial<NarratedMoment> = {}): NarratedMoment {
  return {
    candidate: c,
    air: { air: true, reason: 'selected', priority: 80, ttlSeconds: 60, slots: ['lower_third'] },
    headline: `Headline ${c.id}`, body: `Body ${c.id}`, lang: 'en', persona: 'analyst',
    provider: 'template', source: 'template', ticker: `Ticker ${c.id}`, tickerSource: 'template',
    verification: { approved: true, issues: [] } as unknown as NarratedMoment['verification'],
    variants: [
      { persona: 'analyst', lang: 'es', headline: `Titular ${c.id}`, body: `Cuerpo ${c.id}`, source: 'template' },
    ],
    ...over,
  };
}

const goal = candidate({ id: 'g1', t: 100, kind: 'goal', facts: { goals: 1 }, evidenceEventIds: ['e-goal'], provisional: true, overturned: true });
const decision = candidate({ id: 'v1', t: 130, kind: 'var_overturn', evidenceEventIds: ['e-goal', 'e-var'] });
const shotEvent = { id: 'e-goal', index: 1, t: 100, period: 1, type: 'shot', team: 'home', playerId: 'p1', at: { x: 40, y: 0 }, endAt: null, outcome: 'goal', xg: 0.2 } as unknown as MatchEvent;
const varEvent = { id: 'e-var', index: 2, t: 130, period: 1, type: 'var_check', team: 'none', playerId: null, at: { x: 0, y: 0 }, endAt: null, detail: 'Overturned — foul in the build-up', relatedEventId: 'e-goal' } as unknown as MatchEvent;
const passEvent = { id: 'e-pass', index: 3, t: 250, period: 1, type: 'pass', team: 'home', playerId: 'p2', recipientId: 'p3', at: { x: 0, y: 0 }, endAt: { x: 10, y: 0 } } as unknown as MatchEvent;
const chance = candidate({ id: 'c1', t: 250, kind: 'big_chance', team: 'home', playerId: 'p2', evidenceEventIds: ['e-pass'], facts: { xg: 0.3 } });
const moments = [moment(goal), moment(decision), moment(chance)];
const match = {
  meta,
  timing: { halfTimeT: 2700, fullTimeT: 5400 },
  lineups: { home: [{ id: 'p1', name: 'One', shirt: 9, role: 'FW', team: 'home' }], away: [] },
  bench: { home: [], away: [] },
  formations: { home: '4-4-2', away: '4-3-3' },
  events: [shotEvent, varEvent, passEvent],
  cues: { version: '1.0', matchId: 'm1', cues: [], meta: { homeAbbr: 'HOM', awayAbbr: 'AWY', competition: 'Test League', generatedBy: 'test' } },
  moments, candidates: [goal, decision, chance],
  players: [], traces: [],
  scoreTimeline: [{ t: 0, home: 0, away: 0 }, { t: 100, home: 1, away: 0 }, { t: 130, home: 0, away: 0 }],
  providerSummary: { completed: 0, fallback: 0, failed: 0, recorded: false },
} as unknown as PreparedMatch;

describe('chronological score and retraction', () => {
  it('counts a provisional goal until the exact review decision', () => {
    expect(scoreAt(match, 99)).toEqual({ home: 0, away: 0 });
    expect(scoreAt(match, 120)).toEqual({ home: 1, away: 0 });
    expect(scoreAt(match, 130)).toEqual({ home: 0, away: 0 });
  });

  it('finds the linked decision, not a neighbouring story', () => {
    expect(retractionAt(match, goal)).toBe(130);
    expect(retractionAt(match, chance)).toBe(Infinity);
  });
});

describe('spoiler-safe desk and rundown', () => {
  it('never selects a future moment', () => {
    expect(deskAt(match, 20, null, prefs)).toBeNull();
    expect(deskAt(match, 105, null, prefs)?.type).toBe('moment');
  });

  it('does not open a future selected moment', () => {
    expect(deskAt(match, 20, 'c1', prefs)).toBeNull();
  });

  it('turns a pulled goal into a retraction only after the decision', () => {
    expect(deskAt(match, 120, 'g1', prefs)?.type).toBe('moment');
    expect(deskAt(match, 135, 'g1', prefs)?.type).toBe('retracted');
  });

  it('hides future rows and retractions until they are reached', () => {
    const early = buildFeed(match, 50, 0, prefs);
    expect(early).toHaveLength(0);
    const beforeReview = buildFeed(match, 110, 0, prefs);
    expect(beforeReview.some((item) => item.state === 'retracted')).toBe(false);
    const afterReview = buildFeed(match, 135, 0, prefs);
    expect(afterReview.find((item) => item.state === 'retracted')?.t).toBe(130);
    expect(afterReview.some((item) => item.candidateId === 'g1' && item.state !== 'retracted')).toBe(false);
  });

  it('keeps the latest aired ticker and drops retracted stories', () => {
    expect(tickerAt(match, 20, 25, prefs)).toBeNull();
    expect(tickerAt(match, 110, 25, prefs)).toContain('Ticker g1');
    expect(tickerAt(match, 135, 25, prefs)).not.toContain('Ticker g1');
  });
});

describe('viewer focus', () => {
  it('filters non-score stories by club but always keeps score events', () => {
    const awayFan: ViewerSelection = { ...prefs, clubId: 'a' };
    expect(matchesPreferences(match, goal, awayFan)).toBe(true);
    expect(matchesPreferences(match, chance, awayFan)).toBe(false);
    expect(matchesPreferences(match, chance, { ...prefs, clubId: 'h' })).toBe(true);
  });

  it('filters by a selected player through the evidence trail', () => {
    expect(matchesPreferences(match, chance, { ...prefs, playerId: 'p2' })).toBe(true);
    expect(matchesPreferences(match, chance, { ...prefs, playerId: 'p1' })).toBe(false);
  });

  it('filters by the chosen metric', () => {
    expect(matchesPreferences(match, chance, { ...prefs, metric: 'passes' })).toBe(true);
    expect(matchesPreferences(match, chance, { ...prefs, metric: 'speed' })).toBe(false);
    expect(matchesPreferences(match, goal, { ...prefs, metric: 'speed' })).toBe(true);
  });

  it('uses the matching language variant and never labels a template as model output', () => {
    const text = textForViewer(match, moments[0]!, { ...prefs, lang: 'es' });
    expect(text.headline).toContain('Titular');
    expect(text.source).toBe('template');
  });

  it('does not celebrate an opponent goal for a club-heart viewer', () => {
    const clubMoment = moment(goal, {
      variants: [
        { persona: 'club', lang: 'es', headline: 'Nuestro gol', body: '...', source: 'template' },
        { persona: 'analyst', lang: 'es', headline: 'Análisis', body: '...', source: 'template' },
      ],
    });
    expect(textForViewer(match, clubMoment, { ...prefs, persona: 'club', lang: 'es', clubId: 'h' }).headline).toBe('Nuestro gol');
    expect(textForViewer(match, clubMoment, { ...prefs, persona: 'club', lang: 'es', clubId: 'a' }).headline).toBe('Análisis');
  });
});
