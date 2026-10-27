/**
 * One immutable, analytic trajectory per SimulationResult. Event coordinates
 * constrain the ball and its actors; formation anchors only guide off-ball runs.
 * Sampling never advances simulation state, so seeks, chunks and frame rates
 * cannot change positions. Compact motion segments avoid replaying from kickoff.
 */
import { clamp, roundTo, type MatchEvent, type TeamSide, type TrackingFrame, type Vec2 } from '@floodlight/core';
import { anchorPosition, formationSlotFor, goalkeeperAnchor } from './positions';
import type { SimulationResult } from './simulator';
import type { SquadPlayer } from './squad';

const EPS = 1e-8;
const ACCEL = 4.6;
const BRAKE = 7;
const ORIGIN: Vec2 = { x: 0, y: 0 };
const separation = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const mix = (a: Vec2, b: Vec2, k: number): Vec2 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const onField = (p: Vec2): Vec2 => ({ x: clamp(p.x, -52.5, 52.5), y: clamp(p.y, -34, 34) });

interface Motion {
  fromT: number;
  toT: number;
  from: Vec2;
  to: Vec2;
  /** Absent for linear ball flight; players use a rest-to-rest speed profile. */
  profile?: { peak: number; up: number; cruise: number; down: number; duration: number };
}
interface Constraint {
  t: number;
  pos: Vec2;
  eventId: string;
}
interface PlayerTrack {
  player: SquadPlayer;
  side: TeamSide;
  slot: number;
  entryT: number;
  exitT: number;
  replaces?: string;
  initial: Vec2;
  motions: Motion[];
  constraints: Constraint[];
}

export interface TrackingIssue {
  kind: 'simultaneous_ball_events' | 'ball_speed' | 'player_event_miss' | 'inactive_actor';
  eventId: string;
  t: number;
  playerId?: string;
  errorM: number;
  /** Uncapped lower bound (or actual linear ball speed), never a cosmetic cap. */
  requiredSpeedKph?: number;
}
interface Timeline {
  ball: Motion[];
  players: PlayerTrack[];
  issues: TrackingIssue[];
}
const timelines = new WeakMap<SimulationResult, Timeline>();

/** Last item whose time is <= t, including an exact event boundary. */
function before<T>(items: T[], t: number, time: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time(items[mid]!) <= t + EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function position(motions: Motion[], t: number, initial: Vec2): Vec2 {
  const i = before(motions, t, (m) => m.fromT);
  const m = motions[i];
  if (!m) return initial;
  if (t >= m.toT - EPS) return m.to;
  const k = clamp((t - m.fromT) / (m.toT - m.fromT), 0, 1);
  if (!m.profile) return mix(m.from, m.to, k);
  const p = m.profile;
  const elapsed = k * p.duration;
  let travelled: number;
  if (elapsed < p.up) travelled = 0.5 * ACCEL * elapsed ** 2;
  else if (elapsed < p.up + p.cruise) travelled = 0.5 * p.peak * p.up + (elapsed - p.up) * p.peak;
  else {
    const remaining = p.duration - elapsed;
    travelled = separation(m.from, m.to) - 0.5 * BRAKE * remaining ** 2;
  }
  const d = separation(m.from, m.to);
  return mix(m.from, m.to, d > EPS ? clamp(travelled / d, 0, 1) : 1);
}

/** Hard physical cap applies to displacement, not just the displayed label. */
function speedCap(track: PlayerTrack, t: number): number {
  const base = track.player.role === 'GK' ? 21 : (23.5 + track.player.ability.pace * 9.5) * 1.12;
  const fatigue = 1 - 0.1 * clamp((t - track.entryT) / 5400, 0, 1);
  return Math.min(36, base * fatigue) / 3.6;
}

function profile(d: number, cap: number): NonNullable<Motion['profile']> {
  const peak = Math.min(cap, Math.sqrt(2 * d / (1 / ACCEL + 1 / BRAKE)));
  const up = peak / ACCEL;
  const down = peak / BRAKE;
  const cruise = peak > EPS ? Math.max(0, d / peak - (up + down) / 2) : 0;
  return { peak, up, cruise, down, duration: up + cruise + down };
}

/** Reachable distance with zero velocity at both ends of the interval. */
function reachable(span: number, cap: number): number {
  const peak = Math.min(cap, Math.max(0, span) / (1 / ACCEL + 1 / BRAKE));
  return peak * Math.max(0, span - peak * (1 / ACCEL + 1 / BRAKE) / 2);
}

function playerMotion(fromT: number, toT: number, from: Vec2, target: Vec2, cap: number): Motion {
  const d = separation(from, target);
  const fraction = d > EPS ? Math.min(1, reachable(toT - fromT, cap) / d) : 1;
  const to = mix(from, target, fraction);
  return { fromT, toT, from, to, profile: profile(separation(from, to), cap) };
}

const ballEvent = (e: MatchEvent): boolean =>
  !['half_time', 'second_half', 'full_time', 'yellow_card', 'red_card', 'substitution', 'var_check', 'pressure_phase'].includes(e.type);

function buildTimeline(result: SimulationResult): Timeline {
  // Sorting a copy also tolerates scheduled events emitted out of time order.
  const events = [...result.events].sort((a, b) => a.t - b.t || a.index - b.index);
  const issues: TrackingIssue[] = [];
  const players: PlayerTrack[] = [];
  const byId = new Map<string, PlayerTrack>();
  const squad = new Map<string, SquadPlayer>();
  const active = new Map<string, PlayerTrack>();
  const dismissed = new Set<string>();
  const endT = Math.max(result.timing.fullTimeT, events.at(-1)?.t ?? 0);
  const addPlayer = (player: SquadPlayer, side: TeamSide, slot: number, entryT: number, replaces?: string) => {
    const track: PlayerTrack = { player, side, slot, entryT, exitT: Infinity, replaces, initial: ORIGIN, motions: [], constraints: [] };
    players.push(track);
    byId.set(player.id, track);
    active.set(player.id, track);
  };
  for (const side of ['home', 'away'] as const) {
    for (const p of [...result.lineups[side].starters, ...result.lineups[side].bench]) squad.set(p.id, p);
    // The starting XI order is the formation order, not the squad's role index.
    result.lineups[side].starters.forEach((p, slot) => addPlayer(p, side, slot, 0));
  }
  for (const e of events) {
    if (e.type === 'red_card') {
      dismissed.add(e.playerId);
      const off = active.get(e.playerId);
      if (off) off.exitT = e.t;
      active.delete(e.playerId);
    } else if (e.type === 'substitution') {
      const off = active.get(e.playerOffId);
      const on = squad.get(e.playerOnId);
      // A malformed substitution must not revive a dismissed/off-pitch player.
      if (!off || !on || byId.has(on.id) || dismissed.has(on.id) || off.side !== e.team) continue;
      off.exitT = e.t;
      active.delete(e.playerOffId);
      addPlayer(on, off.side, off.slot, e.t, off.player.id);
    }
  }
  const constrain = (id: string | null, t: number, pos: Vec2, eventId: string) => {
    if (!id) return;
    const track = byId.get(id);
    if (!track || t < track.entryT - EPS || t >= track.exitT - EPS) {
      issues.push({ kind: 'inactive_actor', eventId, playerId: id, t, errorM: 0 });
      return;
    }
    track.constraints.push({ t, pos, eventId });
  };

  const actions = events.filter(ballEvent);
  const knots: MatchEvent[] = [];
  for (const e of actions) {
    const last = knots.at(-1);
    if (last && Math.abs(last.t - e.t) < EPS) {
      // A release and receipt at different coordinates at the same timestamp
      // are contradictory input. Keep the first physical action, report the
      // conflict; never silently push either event later in time.
      if (last.type === 'possession_change' && e.type !== 'possession_change') {
        knots[knots.length - 1] = e;
      }
    } else knots.push(e);
  }
  const ball: Motion[] = [];
  const appendBall = (fromT: number, toT: number, from: Vec2, to: Vec2, eventId: string, motion?: Motion) => {
    if (toT <= fromT + EPS) return;
    const m = motion ?? { fromT, toT, from, to };
    ball.push(m);
    const speed = separation(from, to) / (toT - fromT) * 3.6;
    if (speed > 130) issues.push({ kind: 'ball_speed', eventId, t: fromT, errorM: 0, requiredSpeedKph: speed });
  };
  const first = knots[0];
  if (first && first.t > 0) appendBall(0, first.t, ORIGIN, first.at, first.id);
  for (let i = 0; i < knots.length; i++) {
    const e = knots[i]!;
    const next = knots[i + 1];
    const until = next?.t ?? Math.max(endT, e.t + 10);
    const end = e.endAt ?? e.at;
    const travel = separation(e.at, end);
    const bridge = next ? separation(end, next.at) : 0;
    const gap = until - e.t;
    const actor = e.playerId ? byId.get(e.playerId) : undefined;
    const cap = actor ? speedCap(actor, until) : 8;
    const natural = e.type === 'carry'
      ? profile(travel, cap).duration
      : travel / ((e.type === 'shot' ? e.ballSpeedKph : e.type === 'pass' ? clamp(28 + travel * 1.15, 30, 85) : 65) / 3.6);
    // Reserve time for BOTH legs. Arrival never exceeds the next event time,
    // even when the event generator leaves too little time for natural speed.
    const flight = travel > EPS ? Math.min(natural, gap * travel / (travel + bridge)) : 0;
    const arrival = e.t + flight;
    if (flight > EPS) {
      let motion: Motion | undefined;
      if (e.type === 'carry') {
        // The ball and a feasible carrier share the same acceleration profile.
        // If the allotted interval is too short, preserve ball geometry and
        // report the player's residual instead of teleporting them along it.
        const p = profile(travel, cap);
        motion = { fromT: e.t, toT: arrival, from: e.at, to: end, profile: p };
      }
      appendBall(e.t, arrival, e.at, end, e.id, motion);
      if (e.type === 'pass' && e.outcome === 'complete') constrain(e.recipientId, arrival, end, e.id);
      if (e.type === 'carry') constrain(e.playerId, arrival, end, e.id);
    }
    if (next && bridge > EPS) {
      const moveTime = Math.min(until - arrival, bridge / 8);
      appendBall(arrival, until - moveTime, end, end, e.id);
      appendBall(until - moveTime, until, end, next.at, next.id);
    } else appendBall(arrival, until, end, end, e.id);
  }
  const ballInitial = first?.t === 0 ? first.at : ORIGIN;
  if (ball.length === 0) ball.push({ fromT: 0, toT: Math.max(1, endT), from: ballInitial, to: ballInitial });
  // An exact last-event boundary must not select a previous flight endpoint.
  const last = knots.at(-1);
  if (last && !last.endAt && ball.at(-1)!.toT <= last.t + EPS) {
    ball.push({ fromT: last.t, toT: last.t + 1, from: last.at, to: last.at });
  }
  for (const e of actions) {
    const errorM = separation(position(ball, e.t, ballInitial), e.at);
    if (errorM > 0.02) issues.push({ kind: 'simultaneous_ball_events', eventId: e.id, t: e.t, errorM });
    constrain(e.playerId, e.t, e.at, e.id);
    if (e.type === 'tackle') constrain(e.opponentId, e.t, e.at, e.id);
    if (e.type === 'foul') constrain(e.fouledPlayerId, e.t, e.at, e.id);
  }

  const possessionEvents = events.filter((e) => e.team !== 'none' &&
    (e.type === 'possession_change' || e.type === 'kickoff' || e.type === 'pass' || e.type === 'carry' || e.type === 'save' || e.type === 'interception'));
  const anchor = (track: PlayerTrack, t: number): Vec2 => {
    const b = position(ball, t, ballInitial);
    const event = possessionEvents[before(possessionEvents, t, (e) => e.t)];
    const possession = event?.team === 'away' ? 'away' : 'home';
    return track.player.role === 'GK' ? goalkeeperAnchor(track.side, b)
      : anchorPosition(formationSlotFor(result.config.tactics[track.side].formation, track.slot), track.side, possession, result.config.tactics[track.side], b);
  };

  for (const track of players) {
    track.constraints.sort((a, b) => a.t - b.t);
    const firstConstraint = track.constraints[0];
    const outgoing = track.replaces ? byId.get(track.replaces) : undefined;
    track.initial = outgoing ? position(outgoing.motions, track.entryT, outgoing.initial) : anchor(track, 0);
    if (!outgoing && firstConstraint) {
      // Choose the initial formation adjustment once, at kickoff, not at every
      // requested window. Upcoming actors can already be in receiving space.
      const target = onField(firstConstraint.pos);
      const d = separation(track.initial, target);
      const reach = reachable(firstConstraint.t, speedCap(track, firstConstraint.t));
      if (d > reach) track.initial = mix(target, track.initial, d > EPS ? reach / d : 0);
    }
    let cursor = track.entryT;
    let pos = track.initial;
    const append = (t: number, target: Vec2) => {
      if (t <= cursor + EPS) return;
      const m = playerMotion(cursor, t, pos, onField(target), speedCap(track, t));
      track.motions.push(m);
      cursor = t;
      pos = m.to;
    };
    const finish = Math.min(endT, track.exitT);
    const constraints = [...track.constraints, { t: finish, pos: anchor(track, finish), eventId: '' }];
    for (const c of constraints) {
      if (c.t < cursor - EPS) continue;
      // Off-ball formation waypoints are optional: omit a detour if it would
      // prevent reaching the next authoritative actor/receipt constraint.
      while (c.t - cursor > 12) {
        const t = cursor + 6;
        const cap = speedCap(track, c.t);
        const candidate = playerMotion(cursor, t, pos, anchor(track, t), cap).to;
        if (c.eventId && profile(separation(candidate, onField(c.pos)), cap).duration > c.t - t) break;
        append(t, candidate);
      }
      append(c.t, c.pos);
    }
    for (let i = 0; i < track.constraints.length; i++) {
      const c = track.constraints[i]!;
      const errorM = separation(position(track.motions, c.t, track.initial), c.pos);
      if (errorM <= 0.05) continue;
      const prev = track.constraints[i - 1];
      const span = c.t - (prev?.t ?? track.entryT);
      const d = separation(prev?.pos ?? track.initial, c.pos);
      issues.push({ kind: 'player_event_miss', eventId: c.eventId, playerId: track.player.id, t: c.t, errorM,
        requiredSpeedKph: span > EPS ? d / span * 3.6 : d > EPS ? Infinity : 0 });
    }
  }
  return { ball, players, issues };
}

function timelineFor(result: SimulationResult): Timeline {
  let timeline = timelines.get(result);
  if (!timeline) {
    timeline = buildTimeline(result);
    timelines.set(result, timeline);
  }
  return timeline;
}

/** Inspect generator conflicts without modifying event coordinates or timing.
 * SimulationResults are treated as immutable; create a new result after edits.
 */
export function trackingDiagnostics(result: SimulationResult): TrackingIssue[] {
  return timelineFor(result).issues.map((issue) => ({ ...issue }));
}

export interface TrackingWindowOptions { hz?: number }

/**
 * Sample the match-global grid in (t0, t1], at 10 Hz by default. On aligned
 * windows the first frame is t0 + 1/hz; arbitrary chunk cuts never shift the grid.
 * Speed is the displacement over the preceding sample interval (also on the
 * first frame of a window). Different rates share positions, not average speeds.
 */
export function trackingWindow(result: SimulationResult, t0: number, t1: number, options: TrackingWindowOptions = {}): TrackingFrame[] {
  const hz = options.hz ?? 10;
  if (!Number.isFinite(hz) || hz <= 0) throw new RangeError('Tracking hz must be finite and positive');
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new RangeError('Tracking window bounds must be finite');
  if (t1 <= t0 || t1 <= 0) return [];
  const timeline = timelineFor(result);
  const first = Math.floor(Math.max(0, t0) * hz + EPS) + 1;
  const last = Math.floor(t1 * hz + EPS);
  const frames: TrackingFrame[] = [];
  const sample = (motions: Motion[], initial: Vec2, t: number, since: number) => {
    const pos = position(motions, t, initial);
    const prev = position(motions, since, initial);
    return { pos: { x: roundTo(pos.x, 6), y: roundTo(pos.y, 6) },
      speedKph: roundTo(t > since ? separation(pos, prev) / (t - since) * 3.6 : 0, 4) };
  };
  for (let tick = first; tick <= last; tick++) {
    const t = tick / hz;
    const since = (tick - 1) / hz;
    frames.push({
      t: roundTo(t, 9),
      ball: sample(timeline.ball, timeline.ball[0]!.from, t, since),
      players: timeline.players.filter((p) => t >= p.entryT - EPS && t < p.exitT - EPS).map((p) => ({
        playerId: p.player.id,
        ...sample(p.motions, p.initial, t, Math.max(since, p.entryT)),
      })),
    });
  }
  return frames;
}
