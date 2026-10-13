/**
 * Calibration — the quantitative honesty layer.
 *
 * Runs batches of simulated matches and checks the aggregate texture against
 * football-realistic ranges (shot volume, conversion, pass accuracy, cards,
 * corners, possession spread). The data card and demo both quote these
 * numbers, so they must be produced by code, not by hand.
 */

import type { MatchEvent, TeamSide } from '@floodlight/core';
import { mean, stdDev } from '@floodlight/core';
import { simulateMatch, type SimulationResult } from './simulator';
import type { Scenario } from './scenarios';

export interface MatchSummary {
  seed: number;
  goalsHome: number;
  goalsAway: number;
  shots: number;
  shotsOnTarget: number;
  passes: number;
  passAccuracy: number;
  completedPasses: number;
  progressivePasses: number;
  xgTotal: number;
  tackles: number;
  interceptions: number;
  fouls: number;
  corners: number;
  offsides: number;
  yellowCards: number;
  redCards: number;
  substitutions: number;
  possessionHome: number;
  events: number;
  varChecks: number;
}

export function summarizeMatch(result: SimulationResult): MatchSummary {
  const events = result.events;
  const count = (type: MatchEvent['type']) => events.filter((e) => e.type === type).length;
  const passes = events.filter((e) => e.type === 'pass') as Array<MatchEvent & { outcome: string; progressive?: boolean }>;
  const completed = passes.filter((p) => p.outcome === 'complete').length;
  const shots = events.filter((e) => e.type === 'shot') as Array<MatchEvent & { outcome: string; xg: number; isPenalty?: boolean; id: string }>;

  // Goals that were overturned by VAR do not count.
  const overturnedShotIds = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'var_check' && (e as MatchEvent & { detail: string }).detail.includes('Overturned')) {
      for (let j = i - 1; j >= 0; j--) {
        const s = events[j]!;
        if (s.type === 'shot' && (s as MatchEvent & { outcome: string }).outcome === 'goal' && e.t - s.t < 200) {
          overturnedShotIds.add(s.id);
          break;
        }
      }
    }
  }
  const goals = shots.filter((s) => s.outcome === 'goal' && !overturnedShotIds.has(s.id));
  const onTarget = shots.filter((s) => (s.outcome === 'goal' && !overturnedShotIds.has(s.id)) || s.outcome === 'saved');

  // Possession from in-play share (excluding dead-ball phases is approximated
  // by counting completed-pass seconds; we use pass counts as the proxy that
  // the engine also reports for live possession).
  const homeCompleted = passes.filter((p) => p.outcome === 'complete' && p.team === 'home').length;
  const awayCompleted = passes.filter((p) => p.outcome === 'complete' && p.team === 'away').length;
  const totalCompleted = Math.max(homeCompleted + awayCompleted, 1);

  const redCards = count('red_card');
  const varChecks = events.filter((e) => e.type === 'var_check' && (e as MatchEvent & { detail: string }).detail.includes('under review')).length;

  return {
    seed: result.meta.seed,
    goalsHome: goals.filter((g) => g.team === 'home').length,
    goalsAway: goals.filter((g) => g.team === 'away').length,
    shots: shots.length,
    shotsOnTarget: onTarget.length,
    passes: passes.length,
    completedPasses: completed,
    passAccuracy: passes.length > 0 ? completed / passes.length : 0,
    progressivePasses: passes.filter((p) => p.progressive).length,
    xgTotal: shots.reduce((acc, s) => acc + (s.isPenalty ? 0 : s.xg), 0) + goals.length * 0,
    tackles: count('tackle'),
    interceptions: count('interception'),
    fouls: count('foul'),
    corners: count('corner'),
    offsides: count('offside'),
    yellowCards: count('yellow_card'),
    redCards,
    substitutions: count('substitution'),
    possessionHome: homeCompleted / totalCompleted,
    events: events.length,
    varChecks,
  };
}

export interface CalibrationAggregate {
  matches: number;
  goalsPerMatch: number;
  goalsStdDev: number;
  shotsPerMatch: number;
  shotsOnTargetPerMatch: number;
  passAccuracy: number;
  passesPerMatch: number;
  progressivePerMatch: number;
  foulsPerMatch: number;
  cornersPerMatch: number;
  tacklesPerMatch: number;
  interceptionsPerMatch: number;
  cardsPerMatch: number;
  redCardsPerMatch: number;
  varChecksPerMatch: number;
  possessionSpread: number;
  eventsPerMatch: number;
}

export function aggregate(summaries: MatchSummary[]): CalibrationAggregate {
  const goals = summaries.map((s) => s.goalsHome + s.goalsAway);
  const possessionHome = summaries.map((s) => s.possessionHome);
  return {
    matches: summaries.length,
    goalsPerMatch: mean(goals),
    goalsStdDev: stdDev(goals),
    shotsPerMatch: mean(summaries.map((s) => s.shots)),
    shotsOnTargetPerMatch: mean(summaries.map((s) => s.shotsOnTarget)),
    passAccuracy: mean(summaries.map((s) => s.passAccuracy)),
    passesPerMatch: mean(summaries.map((s) => s.passes)),
    progressivePerMatch: mean(summaries.map((s) => s.progressivePasses)),
    foulsPerMatch: mean(summaries.map((s) => s.fouls)),
    cornersPerMatch: mean(summaries.map((s) => s.corners)),
    tacklesPerMatch: mean(summaries.map((s) => s.tackles)),
    interceptionsPerMatch: mean(summaries.map((s) => s.interceptions)),
    cardsPerMatch: mean(summaries.map((s) => s.yellowCards + s.redCards)),
    redCardsPerMatch: mean(summaries.map((s) => s.redCards)),
    varChecksPerMatch: mean(summaries.map((s) => s.varChecks)),
    possessionSpread: stdDev(possessionHome),
    eventsPerMatch: mean(summaries.map((s) => s.events)),
  };
}

export interface CalibrationCheck {
  name: string;
  value: number;
  min: number;
  max: number;
  pass: boolean;
}

export const CALIBRATION_RANGES = {
  goalsPerMatch: { min: 2.0, max: 3.8 },
  shotsPerMatch: { min: 18, max: 36 },
  passAccuracy: { min: 0.76, max: 0.9 },
  passesPerMatch: { min: 700, max: 1350 },
  foulsPerMatch: { min: 13, max: 30 },
  cornersPerMatch: { min: 6, max: 16 },
  cardsPerMatch: { min: 1.5, max: 7 },
  possessionSpread: { min: 0.02, max: 0.2 },
  eventsPerMatch: { min: 900, max: 2600 },
  shotsOnTargetPerMatch: { min: 6, max: 16 },
} as const;

export function verifyCalibration(agg: CalibrationAggregate): CalibrationCheck[] {
  return Object.entries(CALIBRATION_RANGES).map(([name, range]) => {
    const value = agg[name as keyof CalibrationAggregate] as number;
    return {
      name,
      value,
      min: range.min,
      max: range.max,
      pass: value >= range.min && value <= range.max,
    };
  });
}

export function runCalibrationBatch(count: number, seedBase: number, scenario?: Scenario): {
  summaries: MatchSummary[];
  aggregate: CalibrationAggregate;
  checks: CalibrationCheck[];
} {
  const summaries: MatchSummary[] = [];
  for (let i = 0; i < count; i++) {
    const result = simulateMatch(seedBase + i * 7919, scenario);
    summaries.push(summarizeMatch(result));
  }
  const agg = aggregate(summaries);
  return { summaries, aggregate: agg, checks: verifyCalibration(agg) };
}

export function goalsBySide(summary: MatchSummary): Record<TeamSide, number> {
  return { home: summary.goalsHome, away: summary.goalsAway };
}
