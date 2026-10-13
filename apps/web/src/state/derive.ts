/**
 * Derived view-models for the control room — pure functions over the
 * prepared match and a match-second clock.
 */

import { formatMinute } from '@floodlight/core';
import type { Cue } from '@floodlight/cuesheet';
import type { NarratedMoment } from '@floodlight/agents';
import type { PreparedMatch } from '../pipeline/protocol';

export interface Score {
  home: number;
  away: number;
}

export function scoreAt(match: PreparedMatch, t: number): Score {
  let home = 0;
  let away = 0;
  for (const entry of match.scoreTimeline) {
    if (entry.t > t) break;
    home = entry.home;
    away = entry.away;
  }
  return { home, away };
}

/**
 * Cues on air at time t. The compiler guarantees per-slot exclusivity, so
 * for exclusive slots we keep only the highest-priority cue.
 */
export function cuesAt(match: PreparedMatch, t: number): Cue[] {
  const active: Cue[] = [];
  for (const cue of match.cues.cues) {
    if (cue.t0 <= t && t < cue.t1) active.push(cue);
  }
  return active.sort((a, b) => a.priority - b.priority);
}

export function cueForSlot(active: Cue[], slot: Cue['slot']): Cue | null {
  let best: Cue | null = null;
  for (const cue of active) {
    if (cue.slot !== slot) continue;
    if (!best || cue.priority > best.priority) best = cue;
  }
  return best;
}

export interface FeedItem {
  key: string;
  t: number;
  minuteLabel: string;
  kind: string;
  headline: string;
  state: 'aired' | 'live' | 'upcoming' | 'retracted';
  moment: NarratedMoment | null;
  candidateId: string;
  /** Structural rows (subs, period markers) wear their own badge. */
  badge?: { label: string; color: string };
  /** Structural rows have no insight dossier behind them. */
  synthetic?: boolean;
}

/**
 * The gallery feed: moments that have aired (t <= clock), what is next on the
 * rundown, and the stories that were pulled — goals chalked off by VAR.
 */
export function buildFeed(match: PreparedMatch, t: number, lookahead = 150): FeedItem[] {
  const items: FeedItem[] = [];
  for (const moment of match.moments) {
    if (!moment.air.air) continue;
    const mt = moment.candidate.t;
    if (mt > t + lookahead) break;
    const ttl = mt + moment.air.ttlSeconds;
    const state: FeedItem['state'] = mt > t ? 'upcoming' : t <= ttl ? 'live' : 'aired';
    items.push({
      key: moment.candidate.id,
      t: mt,
      minuteLabel: moment.candidate.minuteLabel,
      kind: moment.candidate.kind,
      headline: moment.headline,
      state,
      moment,
      candidateId: moment.candidate.id,
    });
  }
  for (const candidate of match.candidates) {
    if (!candidate.overturned) continue;
    if (candidate.t > t + lookahead) break;
    items.push({
      key: `retracted:${candidate.id}`,
      t: candidate.t,
      minuteLabel: candidate.minuteLabel,
      kind: candidate.kind,
      headline: 'Goal chalked off — story pulled',
      state: 'retracted',
      moment: null,
      candidateId: candidate.id,
    });
  }
  items.push(...structuralRows(match, t, lookahead));
  return items.sort((a, b) => a.t - b.t);
}

function playerName(match: PreparedMatch, id: string): string {
  for (const side of ['home', 'away'] as const) {
    const found =
      match.lineups[side].find((p) => p.id === id) ?? match.bench[side].find((p) => p.id === id);
    if (found) return found.name;
  }
  return 'Unnamed';
}

/**
 * Structural rows — substitutions and period markers. They belong in the
 * running order (a producer needs the full show), but they carry no story,
 * so they render their own badge and have no insight dossier behind them.
 */
function structuralRows(match: PreparedMatch, t: number, lookahead: number): FeedItem[] {
  const rows: FeedItem[] = [];
  for (const event of match.events) {
    if (event.t > t + lookahead) continue;
    if (event.type === 'substitution') {
      const abbr = event.team === 'home' ? match.meta.home.abbr : match.meta.away.abbr;
      rows.push({
        key: `sub:${event.id}`,
        t: event.t,
        minuteLabel: formatMinute(event.t),
        kind: 'substitution',
        headline: `${abbr} — ${playerName(match, event.playerOnId)} on for ${playerName(match, event.playerOffId)}`,
        state: event.t > t ? 'upcoming' : 'aired',
        moment: null,
        candidateId: event.id,
        badge: { label: 'SUB', color: '#94a3b8' },
        synthetic: true,
      });
    } else if (event.type === 'half_time' || event.type === 'full_time') {
      rows.push({
        key: `phase:${event.id}`,
        t: event.t,
        minuteLabel: formatMinute(event.t),
        kind: event.type,
        headline: event.detail,
        state: event.t > t ? 'upcoming' : 'aired',
        moment: null,
        candidateId: event.id,
        badge: { label: event.type === 'half_time' ? 'HALF TIME' : 'FULL TIME', color: '#cbd5e1' },
        synthetic: true,
      });
    }
  }
  return rows;
}

/** The most recent aired ticker line (ticker persists ~25s on screen). */
export function tickerAt(match: PreparedMatch, t: number, linger = 25): string | null {
  let line: string | null = null;
  for (const moment of match.moments) {
    if (moment.candidate.t > t) break;
    if (!moment.ticker) continue;
    if (t - moment.candidate.t <= linger) line = moment.ticker;
    else if (line && t - moment.candidate.t > linger) break;
  }
  return line;
}

/** Pick the variant text nearest to the viewer's persona + language. */
export function viewerText(
  moment: NarratedMoment,
  persona: string,
  lang: string,
): { headline: string; body: string; source: string } {
  const exact = moment.variants.find((v) => v.persona === persona && v.lang === lang);
  if (exact) return { headline: exact.headline, body: exact.body, source: 'model' };
  const sameLang = moment.variants.find((v) => v.lang === lang);
  if (sameLang) return { headline: sameLang.headline, body: sameLang.body, source: 'model' };
  return { headline: moment.headline, body: moment.body, source: moment.provider };
}
