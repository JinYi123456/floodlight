import { formatMinute } from '@floodlight/core';
import type { Cue } from '@floodlight/cuesheet';
import type { NarratedMoment } from '@floodlight/agents';
import type { InsightCandidate } from '@floodlight/engine';
import type { PreparedMatch } from '../pipeline/protocol';

export interface Score {
  home: number;
  away: number;
}

export interface ViewerSelection {
  persona: string;
  lang: string;
  clubId: string | null;
  playerId: string | null;
  metric: string | null;
}

export function scoreAt(match: PreparedMatch, t: number): Score {
  let score = { home: 0, away: 0 };
  for (const entry of match.scoreTimeline) {
    if (entry.t > t) break;
    score = { home: entry.home, away: entry.away };
  }
  return score;
}

export function retractionAt(match: PreparedMatch, candidate: InsightCandidate): number {
  const correction = match.candidates.find((c) =>
    c.kind === 'var_overturn' && c.t >= candidate.t &&
    c.evidenceEventIds.some((id) => candidate.evidenceEventIds.includes(id)),
  );
  return correction?.t ?? Infinity;
}

export function cuesAt(match: PreparedMatch, t: number): Cue[] {
  return match.cues.cues.filter((cue) => cue.t0 <= t && t < cue.t1 && t < cue.expiresAt)
    .sort((a, b) => a.priority - b.priority);
}

export function cueForSlot(active: Cue[], slot: Cue['slot']): Cue | null {
  let best: Cue | null = null;
  for (const cue of active) {
    if (cue.slot === slot && (!best || cue.priority > best.priority)) best = cue;
  }
  return best;
}

const SCORE_EVENTS = new Set(['goal', 'var_review', 'var_overturn', 'penalty', 'red_card']);

export function matchesPreferences(match: PreparedMatch, candidate: InsightCandidate, prefs: ViewerSelection): boolean {
  if (SCORE_EVENTS.has(candidate.kind)) return true;
  const side = prefs.clubId === match.meta.home.id ? 'home' : prefs.clubId === match.meta.away.id ? 'away' : null;
  if (side && candidate.team !== side) return false;
  if (prefs.playerId && candidate.playerId !== prefs.playerId &&
    !candidate.evidenceEventIds.some((id) => {
      const event = match.events.find((e) => e.id === id);
      return event?.playerId === prefs.playerId || (event?.type === 'pass' && event.recipientId === prefs.playerId);
    })) return false;
  const metric = String(candidate.facts['metric'] ?? '').toLowerCase();
  switch (prefs.metric) {
    case 'xg': return ['big_chance', 'big_save', 'siege'].includes(candidate.kind) || 'xg' in candidate.facts;
    case 'passes': return metric.includes('pass') || candidate.evidenceEventIds.some((id) => match.events.find((e) => e.id === id)?.type === 'pass');
    case 'speed': return candidate.kind === 'speed_flash' || 'speedKph' in candidate.facts;
    case 'distance': return metric.includes('distance') || 'distanceM' in candidate.facts || 'distanceKm' in candidate.facts;
    case 'momentum': return ['momentum_shift', 'siege', 'comeback_trigger', 'late_drama', 'tactical_pressure'].includes(candidate.kind);
    default: return true;
  }
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
  badge?: { label: string; color: string };
  synthetic?: boolean;
}

export function buildFeed(match: PreparedMatch, t: number, lookahead = 150, prefs?: ViewerSelection): FeedItem[] {
  const items: FeedItem[] = [];
  for (const moment of match.moments) {
    if (!moment.air.air || (prefs && !matchesPreferences(match, moment.candidate, prefs))) continue;
    const mt = moment.candidate.t;
    if (mt > t + lookahead) continue;
    if (moment.candidate.overturned && retractionAt(match, moment.candidate) <= t) continue;
    items.push({
      key: moment.candidate.id,
      t: mt,
      minuteLabel: moment.candidate.minuteLabel,
      kind: moment.candidate.kind,
      headline: prefs ? textForViewer(match, moment, prefs).headline : moment.headline,
      state: mt > t ? 'upcoming' : t < mt + moment.air.ttlSeconds ? 'live' : 'aired',
      moment,
      candidateId: moment.candidate.id,
    });
  }
  for (const candidate of match.candidates) {
    if (!candidate.overturned || candidate.kind !== 'goal') continue;
    const decisionT = retractionAt(match, candidate);
    if (decisionT > t) continue;
    items.push({
      key: `retracted:${candidate.id}`,
      t: decisionT,
      minuteLabel: formatMinute(decisionT),
      kind: candidate.kind,
      headline: 'Goal chalked off — story pulled',
      state: 'retracted',
      moment: null,
      candidateId: candidate.id,
    });
  }
  for (const event of match.events) {
    if (event.t > t + lookahead) continue;
    if (event.type === 'substitution') {
      const abbr = event.team === 'home' ? match.meta.home.abbr : match.meta.away.abbr;
      items.push({
        key: `sub:${event.id}`, t: event.t, minuteLabel: formatMinute(event.t), kind: event.type,
        headline: `${abbr} — ${playerName(match, event.playerOnId)} on for ${playerName(match, event.playerOffId)}`,
        state: event.t > t ? 'upcoming' : 'aired', moment: null, candidateId: event.id,
        badge: { label: 'SUB', color: '#94a3b8' }, synthetic: true,
      });
    } else if (event.type === 'half_time' || event.type === 'full_time') {
      items.push({
        key: `phase:${event.id}`, t: event.t, minuteLabel: formatMinute(event.t), kind: event.type,
        headline: event.detail, state: event.t > t ? 'upcoming' : 'aired', moment: null, candidateId: event.id,
        badge: { label: event.type === 'half_time' ? 'HALF TIME' : 'FULL TIME', color: '#cbd5e1' }, synthetic: true,
      });
    }
  }
  return items.sort((a, b) => a.t - b.t);
}

function playerName(match: PreparedMatch, id: string): string {
  return [...match.lineups.home, ...match.lineups.away, ...match.bench.home, ...match.bench.away]
    .find((p) => p.id === id)?.name ?? 'Unnamed';
}

export function tickerAt(match: PreparedMatch, t: number, linger = 25, prefs?: ViewerSelection): string | null {
  const moment = match.moments.filter((m) => m.air.air && m.candidate.t <= t && t - m.candidate.t <= linger &&
    (!m.candidate.overturned || retractionAt(match, m.candidate) > t) &&
    (!prefs || matchesPreferences(match, m.candidate, prefs))).at(-1);
  if (!moment) return null;
  if (!prefs) return moment.ticker ?? moment.headline;
  if (prefs.lang === moment.lang && moment.ticker) return moment.ticker;
  const { headline } = textForViewer(match, moment, prefs);
  const first = headline.split(/[,.;:—]/)[0]?.trim() ?? headline;
  return first.length >= 12 ? first : headline;
}

export function viewerText(moment: NarratedMoment, persona: string, lang: string): { headline: string; body: string; source: string } {
  const variant = moment.variants.find((v) => v.persona === persona && v.lang === lang)
    ?? moment.variants.find((v) => v.lang === lang);
  if (variant) return { headline: variant.headline, body: variant.body, source: variant.source ?? 'template' };
  return { headline: moment.headline, body: moment.body, source: moment.provider };
}

export function textForViewer(match: PreparedMatch, moment: NarratedMoment, prefs: ViewerSelection): { headline: string; body: string; source: string } {
  const side = prefs.clubId === match.meta.home.id ? 'home' : prefs.clubId === match.meta.away.id ? 'away' : null;
  const persona = prefs.persona === 'club' && (!side || moment.candidate.team !== side) ? 'analyst' : prefs.persona;
  return viewerText(moment, persona, prefs.lang);
}

export type DeskView = { type: 'moment'; moment: NarratedMoment } | { type: 'retracted'; candidate: InsightCandidate } | null;

export function deskAt(match: PreparedMatch, t: number, selectedId: string | null, prefs: ViewerSelection): DeskView {
  if (selectedId) {
    const candidate = match.candidates.find((c) => c.id === selectedId);
    if (candidate?.overturned && retractionAt(match, candidate) <= t) return { type: 'retracted', candidate };
    const moment = match.moments.find((m) => m.candidate.id === selectedId && m.candidate.t <= t);
    if (moment && matchesPreferences(match, moment.candidate, prefs)) return { type: 'moment', moment };
  }
  const moment = match.moments.filter((m) => m.air.air && m.candidate.t <= t &&
    (!m.candidate.overturned || retractionAt(match, m.candidate) > t) && matchesPreferences(match, m.candidate, prefs)).at(-1);
  return moment ? { type: 'moment', moment } : null;
}
