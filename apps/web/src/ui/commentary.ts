/**
 * The play-by-play voice — short spoken lines read straight off the event
 * stream so the commentary keeps up with the ball between the graphics
 * moments. The story desk handles colour; this is the mic that follows play.
 */

import type { MatchEvent, TeamSide } from '@floodlight/core';
import type { NarratedMoment } from '@floodlight/agents';
import type { Cue } from '@floodlight/cuesheet';
import type { PreparedMatch } from '../pipeline/protocol';
import { cuesAt, matchesPreferences, scoreAt, textForViewer } from '../state/derive';

export interface CommentaryPrefs {
  persona: string;
  lang: string;
  clubId: string | null;
  playerId: string | null;
  metric: string | null;
}

/** Same selected copy in screen-fixed graphics and on the story mic. */
export function cuesForViewer(match: PreparedMatch, t: number, prefs: CommentaryPrefs): Cue[] {
  return cuesAt(match, t).flatMap((cue) => {
    const id = cue.payload.candidateId ?? cue.source.candidateId ?? cue.source.momentId;
    const moment = match.moments.find((entry) => entry.candidate.id === id);
    if (!moment) return prefs.lang === 'en' || !cue.payload.headline ? [cue] : [];
    if (!isCriticalMoment(moment) && !matchesPreferences(match, moment.candidate, prefs)) return [];
    const text = textForViewer(match, moment, prefs);
    return [{ ...cue, payload: { ...cue.payload, headline: text.headline, body: text.body, lang: prefs.lang } }];
  });
}

export interface CommentaryPlayback {
  epoch?: number;
  lang?: string;
}

/** Critical match facts stay on air even when analysis is focused elsewhere. */
export function isCriticalMoment(moment: NarratedMoment): boolean {
  return ['goal', 'penalty', 'red_card', 'var_review', 'var_overturn', 'late_drama', 'comeback_trigger']
    .includes(moment.candidate.kind);
}

/** Keep this first-clause rule aligned with the existing static audio renderer. */
export function spokenLine(headline: string): string {
  const first = headline.split(',')[0]?.trim() ?? headline;
  return first.length >= 12 ? first : headline;
}

/** No network probe can establish provenance. Only the worker's validated
 *  recording binding may authorize a static English clip; all other copy is
 *  spoken locally in the viewer's language. */
export function recordedMomentClip(
  match: PreparedMatch,
  moment: NarratedMoment,
  prefs: { lang: string; persona: string },
  recordingId: string | null,
  headline: string,
): string | null {
  if (!recordingId || !match.providerSummary.recorded || match.meta.scenario !== recordingId ||
    prefs.lang !== 'en' || moment.lang !== prefs.lang || moment.persona !== prefs.persona ||
    moment.provider !== 'llm' || !moment.verification.approved || headline !== moment.headline) return null;
  return `recordings/audio/${encodeURIComponent(recordingId)}/${encodeURIComponent(moment.candidate.id)}.mp3`;
}

export interface SpokenLine {
  id: string;
  text: string;
  priority: number;
  /** Silence required before this line may fire (seconds of match time). */
  minGap?: number;
}

const MIN_GAP_SECONDS = 4.5;
const URGENT_GAP_SECONDS = 2.2;
const URGENT_PRIORITY = 88;
/** Filler only speaks after a long quiet spell — commentary, not chatter. */
const FILLER_GAP_SECONDS = 55;
/** Sterile possession spells earn a colour line of their own. */
const STARVATION_SECONDS = 65;

const NUMBER_WORDS = ['nil', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function word(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export class PlayByPlay {
  private match: PreparedMatch | null = null;
  private pointer = 0;
  private cursorT = Number.NEGATIVE_INFINITY;
  private lastSpokenT = Number.NEGATIVE_INFINITY;
  private names = new Map<string, string>();
  private club: Record<TeamSide, string> = { home: 'the hosts', away: 'the visitors' };
  private venue = 'the ground';
  private momentTimes: Array<{ t: number; kind: string }> = [];
  private lastSide: TeamSide = 'home';
  private epoch: number | undefined;
  private lang = 'en';

  /**
   * Called every frame while the clock runs. Consumes events up to `t` and
   * returns at most one line — the best of the window, gap-throttled so the
   * voice paces itself instead of narrating every touch.
   */
  feed(match: PreparedMatch, t: number, playback: CommentaryPlayback = {}): SpokenLine | null {
    const lang = playback.lang ?? 'en';
    if (match !== this.match || playback.epoch !== this.epoch || lang !== this.lang ||
      t < this.cursorT || (playback.epoch === undefined && t - this.cursorT > 6)) {
      this.resync(match, t);
    }
    this.epoch = playback.epoch;
    this.lang = lang;
    // The event mic is authored in English. In other languages the verified
    // localized story desk owns the mic; never read English in an ES/FR voice.
    if (lang !== 'en') {
      while (this.pointer < match.events.length && match.events[this.pointer]!.t <= t) this.pointer++;
      this.cursorT = t;
      return null;
    }

    let pick: SpokenLine | null = null;
    while (this.pointer < match.events.length && match.events[this.pointer]!.t <= t) {
      const event = match.events[this.pointer]!;
      if (event.team === 'home' || event.team === 'away') this.lastSide = event.team;
      const line = this.lineFor(match, event);
      if (line && (!pick || line.priority >= pick.priority)) pick = line;
      this.pointer++;
    }
    this.cursorT = t;

    if (!pick) {
      // A long, sterile spell — name the possession so the mic stays warm.
      if (t - this.lastSpokenT >= STARVATION_SECONDS) {
        const club = this.club[this.lastSide];
        const bucket = Math.floor(t / 40);
        this.lastSpokenT = t;
        return {
          id: `pb-pos-${bucket}`,
          text: [
            `${club} are knocking it about, probing for a way through.`,
            `${club} are enjoying a quiet spell of possession.`,
            `The tempo drops — ${club} keep the ball.`,
          ][bucket % 3]!,
          priority: 26,
          minGap: STARVATION_SECONDS,
        };
      }
      return null;
    }

    const gap = pick.minGap ?? (pick.priority >= URGENT_PRIORITY ? URGENT_GAP_SECONDS : MIN_GAP_SECONDS);
    if (t - this.lastSpokenT < gap) return null;
    this.lastSpokenT = t;
    return pick;
  }

  private resync(match: PreparedMatch, t: number): void {
    if (match !== this.match) this.bind(match);
    // Keep a hair of history so the match-opening kickoff (t ≈ 0) still
    // reaches the mic on the very first frame.
    let lo = 0;
    let hi = match.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (match.events[mid]!.t <= t - 0.25) lo = mid + 1;
      else hi = mid;
    }
    this.pointer = lo;
    this.cursorT = t;
    this.lastSide = 'home';
    for (let i = lo - 1; i >= 0; i--) {
      const side = match.events[i]!.team;
      if (side === 'home' || side === 'away') {
        this.lastSide = side;
        break;
      }
    }
    // A scrub is not a talking point — let the next real event break the
    // silence instead of dumping everything skipped.
    this.lastSpokenT = t - URGENT_GAP_SECONDS;
  }

  private bind(match: PreparedMatch): void {
    this.match = match;
    this.names.clear();
    for (const side of ['home', 'away'] as const) {
      for (const group of [match.lineups[side], match.bench[side]]) {
        for (const player of group ?? []) this.names.set(player.id, player.name);
      }
    }
    this.club = { home: match.meta.home.name.split(' ')[0]!, away: match.meta.away.name.split(' ')[0]! };
    this.venue = match.meta.venue.name;
    this.momentTimes = match.moments
      .filter((moment) => moment.air.air)
      .map((moment) => ({ t: moment.candidate.t, kind: moment.candidate.kind }));
  }

  private name(id: string | null | undefined): string {
    const full = id ? this.names.get(id) : undefined;
    return full ? full.split(' ').pop()! : 'their man';
  }

  /** True when the story desk is already talking about this moment class. */
  private nearMoment(t: number, window: number, kinds: string[]): boolean {
    for (const moment of this.momentTimes) {
      if (Math.abs(moment.t - t) <= window && kinds.includes(moment.kind)) return true;
    }
    return false;
  }

  private last(word0: string, word1: string, n: number): string {
    return word0 === word1 ? word0 : n % 2 === 0 ? word0 : word1;
  }

  private lineFor(match: PreparedMatch, event: MatchEvent): SpokenLine | null {
    const t = event.t;
    const make = (text: string, priority: number): SpokenLine => ({ id: `pb-${event.id}`, text, priority });

    switch (event.type) {
      case 'kickoff':
        return make(t < 40 ? `We're under way at ${this.venue}.` : 'Back under way.', 88);
      case 'half_time': {
        const score = scoreAt(match, t);
        return make(
          `Half time here — ${this.club.home} ${word(score.home)}, ${this.club.away} ${word(score.away)}.`,
          95,
        );
      }
      case 'full_time': {
        const score = scoreAt(match, t);
        return make(`Full time — ${this.club.home} ${word(score.home)}, ${this.club.away} ${word(score.away)}.`, 95);
      }
      case 'shot': {
        if (event.outcome === 'goal' || event.isPenalty) return null; // graphics moment reads these
        if (event.bigChance || this.nearMoment(t, 9, ['big_chance'])) return null;
        const who = this.name(event.playerId);
        if (event.outcome === 'post') return make(`Off the woodwork from ${who}!`, 90);
        if (event.outcome === 'blocked') return make(`${who} lets fly — blocked!`, 90);
        if (event.outcome === 'saved') {
          if (this.nearMoment(t, 9, ['big_save'])) return null;
          return make(`${who} forces the save!`, 90);
        }
        return make(`${who} has a go — wide.`, 88);
      }
      case 'save':
        if (this.nearMoment(t, 9, ['big_save'])) return null;
        return make(`Saved by ${this.name(event.playerId)}!`, 88);
      case 'block':
        return make(
          this.last(`${this.name(event.playerId)} blocks it!`, `Charged down — ${this.name(event.shooterId)}!`, event.index),
          78,
        );
      case 'corner':
        return make(`Corner kick — ${this.club[event.team === 'away' ? 'away' : 'home']}.`, 74);
      case 'foul':
        return make(
          this.last(
            `${this.name(event.playerId)} brings down ${this.name(event.fouledPlayerId)}.`,
            `Free kick — ${this.club[event.team === 'home' ? 'away' : 'home']}.`,
            event.index,
          ),
          58,
        );
      case 'yellow_card':
        return make(`A yellow card for ${this.name(event.playerId)}.`, 84);
      case 'red_card':
        return null; // the story desk handles dismissals
      case 'substitution':
        return make(
          `A change for ${event.team === 'away' ? this.club.away : this.club.home} — ${this.name(event.playerOnId)} on, ${this.name(event.playerOffId)} off.`,
          70,
        );
      case 'carry': {
        if (!event.endAt) return null;
        const dir = event.team === 'home' ? 1 : -1;
        const depth = event.endAt.x * dir;
        const who = this.name(event.playerId);
        if (depth >= 35 && event.lengthM >= 7) {
          return make(
            this.last(
              `${who} carries it into the final third.`,
              this.last(`${who} drives at the defence.`, `${who} pushes forward.`, event.index),
              event.index,
            ),
            40,
          );
        }
        if (depth >= 17 && event.lengthM >= 6) {
          // A line for the quiet spells — otherwise the mic goes minutes
          // without a word between the big moments.
          return { ...make(
            this.last(`${who} carries it on into midfield.`, `${who} steps out with the ball.`, event.index),
            30,
          ), minGap: FILLER_GAP_SECONDS };
        }
        return null;
      }
      case 'pass': {
        if (event.outcome !== 'complete') return null;
        const throughLines = event.lineBreak && event.lengthM >= 20;
        if (!throughLines && event.lengthM < 32) return null;
        const who = this.name(event.playerId);
        return make(
          throughLines
            ? `${who} threads it through the lines.`
            : this.last(`${who} switches the play.`, `Long from ${who}.`, event.index),
          36,
        );
      }
      default:
        return null;
    }
  }
}
