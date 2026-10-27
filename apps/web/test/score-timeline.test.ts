import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '@floodlight/core';
import { buildScoreTimeline } from '../src/pipeline/scoreTimeline';

function event(over: Partial<MatchEvent> & Pick<MatchEvent, 'id' | 't' | 'type'>): MatchEvent {
  return {
    index: 1, period: 1, team: 'none', playerId: null,
    at: { x: 0, y: 0 }, endAt: null, ...over,
  } as MatchEvent;
}

const goal = event({ id: 'g1', t: 600, type: 'shot', team: 'home', outcome: 'goal', playerId: 'p1' } as Partial<MatchEvent> & Pick<MatchEvent, 'id' | 't' | 'type'>);
const awayGoal = event({ id: 'g2', t: 1200, type: 'shot', team: 'away', outcome: 'goal', playerId: 'p2' } as Partial<MatchEvent> & Pick<MatchEvent, 'id' | 't' | 'type'>);
const overturn = event({
  id: 'v1', t: 720, type: 'var_check', detail: 'Overturned — foul in the build-up',
  relatedEventId: 'g1',
} as Partial<MatchEvent> & Pick<MatchEvent, 'id' | 't' | 'type'>);
const unrelatedReview = event({
  id: 'v2', t: 1300, type: 'var_check', detail: 'Overturned — offside',
  relatedEventId: 'some-other-shot',
} as Partial<MatchEvent> & Pick<MatchEvent, 'id' | 't' | 'type'>);

describe('score timeline visibility', () => {
  it('counts the goal provisionally, rolls back only at the linked decision, then counts the next goal', () => {
    const timeline = buildScoreTimeline([goal, awayGoal, overturn]);
    expect(timeline).toEqual([
      { t: 0, home: 0, away: 0 },
      { t: 600, home: 1, away: 0 },
      { t: 720, home: 0, away: 0 },
      { t: 1200, home: 0, away: 1 },
    ]);
  });

  it('does not roll back a goal for an unrelated review', () => {
    const timeline = buildScoreTimeline([goal, unrelatedReview]);
    expect(timeline.at(-1)).toEqual({ t: 600, home: 1, away: 0 });
  });

  it('does not reveal events after the requested as-of time', () => {
    expect(buildScoreTimeline([goal, overturn], 700).at(-1)).toEqual({ t: 600, home: 1, away: 0 });
    expect(buildScoreTimeline([goal, overturn], 720).at(-1)).toEqual({ t: 720, home: 0, away: 0 });
    expect(buildScoreTimeline([goal, overturn], 100).at(-1)).toEqual({ t: 0, home: 0, away: 0 });
  });

  it('ignores a duplicate overturn instead of subtracting twice', () => {
    const timeline = buildScoreTimeline([goal, overturn, { ...overturn, id: 'v1b', index: 2 }]);
    expect(timeline.at(-1)).toEqual({ t: 720, home: 0, away: 0 });
  });
});
