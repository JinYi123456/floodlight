export interface OutcomeProbabilities {
  home: number;
  draw: number;
  away: number;
}

export function poissonPmf(k: number, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0 || k < 0) return 0;
  let acc = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) acc = (acc * lambda) / i;
  return acc;
}

/** P(home/draw/away) from the current goal difference, each side's xG edge,
 *  and the time left. At full time the score is decisive. */
export function poissonOutcomes(
  diff: number,
  xgHome: number,
  xgAway: number,
  t: number,
  full: number,
): OutcomeProbabilities {
  if (full <= 0 || t >= full) return { home: Number(diff > 0), draw: Number(diff === 0), away: Number(diff < 0) };
  const remaining = Math.max(0, Math.min(1, 1 - Math.max(0, t) / full));
  const edge = Math.max(-0.6, Math.min(0.6, (xgHome - xgAway) * 0.25));
  const lambdaHome = (1.35 + edge) * remaining;
  const lambdaAway = (1.35 - edge) * remaining;
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i <= 16; i++) {
    for (let j = 0; j <= 16; j++) {
      const p = poissonPmf(i, lambdaHome) * poissonPmf(j, lambdaAway);
      if (diff + i - j > 0) home += p;
      else if (diff + i - j === 0) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: away / total };
}
