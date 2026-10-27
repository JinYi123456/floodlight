import type { MatchEvent } from '@floodlight/core';
import type { PreparedMatch } from '../pipeline/protocol';
import { scoreAt } from './derive';
import { poissonOutcomes } from './winProbability';

export type Side = 'home' | 'away';

export interface TeamAggregate {
  possession: number;
  passes: number;
  completed: number;
  shots: number;
  onTarget: number;
  xg: number;
  thirdEntries: number;
}

export interface PackModel {
  aggregates: Record<Side, TeamAggregate>;
  shots: Array<{ t: number; team: Side; x: number; y: number; xg: number; outcome: string }>;
  subs: Array<{ t: number; team: Side; off: string; on: string }>;
  usedOn: Set<string>;
  score: { home: number; away: number };
  winCurve: Array<{ t: number; home: number; draw: number; away: number }>;
  avgPos: Record<Side, Map<string, { x: number; y: number; count: number }>>;
}

const EMPTY_AGGREGATE: TeamAggregate = {
  possession: 0, passes: 0, completed: 0, shots: 0, onTarget: 0, xg: 0, thirdEntries: 0,
};

export function buildModel(match: PreparedMatch, t: number): PackModel {
  const aggregates: Record<Side, TeamAggregate> = { home: { ...EMPTY_AGGREGATE }, away: { ...EMPTY_AGGREGATE } };
  let holder: Side | null = null;
  let since = 0;
  const possessionSeconds: Record<Side, number> = { home: 0, away: 0 };
  for (const event of match.events) {
    if (event.t > t) break;
    if (event.type === 'kickoff' || event.type === 'possession_change') {
      if (holder && event.team !== 'none') possessionSeconds[holder] += event.t - since;
      holder = event.team === 'none' ? holder : (event.team as Side);
      since = event.t;
    }
  }
  if (holder) possessionSeconds[holder] += Math.max(0, t - since);
  const total = possessionSeconds.home + possessionSeconds.away;

  const shots: PackModel['shots'] = [];
  const subs: PackModel['subs'] = [];
  const usedOn = new Set<string>();
  const score = scoreAt(match, t);
  const xgSoFar: Record<Side, number> = { home: 0, away: 0 };
  const xgTimeline: Array<{ t: number; xgHome: number; xgAway: number }> = [];
  const avgPos: PackModel['avgPos'] = { home: new Map(), away: new Map() };

  for (const event of match.events) {
    if (event.t > t) break;
    const side = event.team === 'home' || event.team === 'away' ? (event.team as Side) : null;
    if (!side) continue;
    if (event.playerId) {
      const entry = avgPos[side].get(event.playerId) ?? { x: 0, y: 0, count: 0 };
      entry.x += event.at.x;
      entry.y += event.at.y;
      entry.count++;
      avgPos[side].set(event.playerId, entry);
    }
    const xg = (event as { xg?: number }).xg ?? 0;
    switch (event.type) {
      case 'pass': {
        aggregates[side].passes++;
        if ((event as { outcome?: string }).outcome === 'complete') aggregates[side].completed++;
        if ((side === 'home' && event.at.x >= 35) || (side === 'away' && event.at.x <= -35)) aggregates[side].thirdEntries++;
        break;
      }
      case 'carry': {
        if ((side === 'home' && event.at.x >= 35) || (side === 'away' && event.at.x <= -35)) aggregates[side].thirdEntries++;
        break;
      }
      case 'shot': {
        const outcome = String((event as { outcome?: string }).outcome ?? '');
        aggregates[side].shots++;
        if (outcome === 'goal' || outcome === 'saved') aggregates[side].onTarget++;
        aggregates[side].xg += xg;
        xgSoFar[side] += xg;
        shots.push({ t: event.t, team: side, x: event.at.x, y: event.at.y, xg, outcome });
        xgTimeline.push({ t: event.t, xgHome: xgSoFar.home, xgAway: xgSoFar.away });
        break;
      }
      case 'substitution': {
        const sub = event as MatchEvent & { playerOffId: string; playerOnId: string };
        subs.push({ t: event.t, team: side, off: sub.playerOffId, on: sub.playerOnId });
        usedOn.add(sub.playerOnId);
        break;
      }
      default:
        break;
    }
  }

  aggregates.home.possession = total > 0 ? possessionSeconds.home / total : 0.5;
  aggregates.away.possession = total > 0 ? possessionSeconds.away / total : 0.5;

  const winCurve: PackModel['winCurve'] = [];
  const full = match.timing.fullTimeT;
  let sample = -1;
  for (let at = 0; at <= t + 1e-6; at += 60) {
    while (sample + 1 < xgTimeline.length && xgTimeline[sample + 1]!.t <= at) sample++;
    const xgH = sample >= 0 ? xgTimeline[sample]!.xgHome : 0;
    const xgA = sample >= 0 ? xgTimeline[sample]!.xgAway : 0;
    let h = 0;
    let a = 0;
    for (const point of match.scoreTimeline) {
      if (point.t > at) break;
      h = point.home;
      a = point.away;
    }
    winCurve.push({ t: at, ...poissonOutcomes(h - a, xgH, xgA, at, full) });
  }
  winCurve.push({ t, ...poissonOutcomes(score.home - score.away, xgSoFar.home, xgSoFar.away, t, full) });
  return { aggregates, shots, subs, usedOn, score, winCurve, avgPos };
}
