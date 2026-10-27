import type { NarrativeContext } from './templates';

/** A number is evidence only together with its subject, metric, unit and time. */
export interface NumericFact {
  id: string;
  subject: string;
  metric: string;
  value: number;
  unit: 'goals' | 'shots' | 'm' | 'km/h' | 'xG' | 'fraction' | 'index';
  asOf: number;
  window: { t0: number; t1: number } | null;
}

export interface NumericClaim extends Omit<NumericFact, 'unit'> {
  unit: NumericFact['unit'] | '%';
}

/** Explicit, one-way percent conversion. No approximate or cross-metric match. */
export function matchesNumericFact(claim: NumericClaim, fact: NumericFact): boolean {
  const value = claim.unit === '%' && fact.unit === 'fraction'
    ? Number((fact.value * 100).toFixed(8)) : fact.value;
  return claim.id === fact.id && claim.subject === fact.subject && claim.metric === fact.metric
    && claim.asOf === fact.asOf && claim.window?.t0 === fact.window?.t0 && claim.window?.t1 === fact.window?.t1
    && (claim.unit === fact.unit || (claim.unit === '%' && fact.unit === 'fraction'))
    && Number.isFinite(claim.value) && claim.value === value;
}

/** Only typed, known metrics are rendered. Free-text facts are never copy. */
export function scopedNumericFacts(ctx: NarrativeContext): NumericFact[] {
  const asOf = ctx.asOf ?? Number.parseFloat(ctx.minute) * 60;
  if (!Number.isFinite(asOf)) return [];
  const team = ctx.team;
  const player = ctx.player ?? team;
  const result: NumericFact[] = [];
  const add = (key: string, metric: string, subject: string, unit: NumericFact['unit'], window: NumericFact['window'] = null) => {
    const value = ctx.facts[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (unit !== 'index' && value < 0) return;
    if ((unit === 'fraction' || unit === 'xG') && value > 1) return;
    if ((unit === 'goals' || unit === 'shots') && !Number.isInteger(value)) return;
    result.push({ id: key, subject, metric, value, unit, asOf, window });
  };
  const window = ctx.window ?? null;
  switch (ctx.kind) {
    case 'goal':
    case 'big_chance':
      add('distanceM', 'shot distance', player, 'm');
      add('ballSpeedKph', 'ball speed', player, 'km/h');
      add('xg', 'shot xG', player, 'xG');
      break;
    case 'big_save':
      add('difficulty', 'save difficulty estimate', player, 'index');
      // The keeper did not take this shot. Keep it scoped to the opposing shot.
      add('xg', 'opposing shot xG', ctx.opponent, 'xG');
      break;
    case 'milestone': add('goals', 'goals', player, 'goals'); break;
    case 'speed_flash': add('speedKph', 'observed speed', player, 'km/h'); break;
    case 'comeback_trigger': add('deficitBefore', 'deficit before goal', team, 'goals'); break;
    case 'momentum_shift':
      add('swing', 'momentum index change', team, 'index', window);
      break;
    case 'siege':
      add('shotsLast10', 'shots in window', team, 'shots', window);
      add('opponentShotsLast10', 'shots in window', ctx.opponent, 'shots', window);
      add('possessionShare', 'possession in window', team, 'fraction', window);
      break;
  }
  if (ctx.scoreAt && [ctx.scoreAt.home, ctx.scoreAt.away].every((n) => Number.isInteger(n) && n >= 0)) {
    for (const side of ['home', 'away'] as const) {
      result.push({ id: `score.${side}`, subject: side, metric: 'score', value: ctx.scoreAt[side], unit: 'goals', asOf, window: null });
    }
  }
  return result;
}
