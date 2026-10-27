import type { MatchEvent, TeamSide } from '@floodlight/core';

export interface ScorePoint { t: number; home: number; away: number }

/** Consume only events known at asOf. A provisional goal counts until its exact
 * linked decision, never until a nearby/future VAR timestamp guessed from cues.
 */
export function buildScoreTimeline(events: readonly MatchEvent[], asOf = Infinity): ScorePoint[] {
  const timeline: ScorePoint[] = [{ t: 0, home: 0, away: 0 }];
  const goals = new Map<string, TeamSide>();
  const seen = new Set<string>();
  let home = 0;
  let away = 0;
  for (const event of [...events].sort((a, b) => a.t - b.t || a.index - b.index)) {
    if (event.t > asOf) break;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.type === 'shot' && event.outcome === 'goal' && event.team !== 'none') {
      goals.set(event.id, event.team);
      if (event.team === 'home') home++;
      else away++;
      timeline.push({ t: event.t, home, away });
    } else if (event.type === 'var_check' && /^Overturned\b/i.test(event.detail)) {
      const linkedId = (event as MatchEvent & { relatedEventId?: string }).relatedEventId;
      const side = linkedId ? goals.get(linkedId) : undefined;
      if (!side) continue; // Unbound/duplicate/future decisions cannot change score.
      goals.delete(linkedId!);
      if (side === 'home') home--;
      else away--;
      timeline.push({ t: event.t, home, away });
    }
  }
  return timeline;
}
