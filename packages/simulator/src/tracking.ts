/**
 * Tracking generation — the 10 Hz positional feed.
 *
 * The feed is derived from the event stream plus the shared positional
 * model: every player seeks a deterministic target (formation anchor, noise,
 * ball pursuit) and is speed-limited by their own pace and match fatigue.
 * Ball paths follow the governing event — passes fly at plausible speeds,
 * carries roll with the carrier, shots arrive fast. Windowed generation
 * keeps memory flat: ask for any [t0, t1] slice of the match, any time.
 */

import {
  clamp,
  createRng,
  deriveSeed,
  distance,
  roundTo,
  type MatchEvent,
  type TeamSide,
  type TrackingFrame,
  type TrackingPlayer,
  type Vec2,
} from '@floodlight/core';
import { anchorPosition, formationSlotFor, goalkeeperAnchor } from './positions';
import type { SimulationResult } from './simulator';
import type { SquadPlayer } from './squad';

interface RosterChange {
  t: number;
  side: TeamSide;
  out: string[];
  in: string[];
}

interface BallSegment {
  fromT: number;
  toT: number;
  from: Vec2;
  to: Vec2;
  speedKph: number;
}

interface PlayerRuntime {
  player: SquadPlayer;
  team: TeamSide;
  pos: Vec2;
  /** Velocity in m/s — motion is acceleration-limited, so this persists. */
  vel: Vec2;
  /** Formation slot 0..10 — substitutes inherit the slot they replace. */
  slot: number;
}

interface NoiseCache {
  get(playerId: string, second: number): Vec2;
}

function makeNoise(seed: number): NoiseCache {
  const cache = new Map<string, Vec2>();
  return {
    get(playerId, second) {
      const key = `${playerId}|${second}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const rng = createRng(deriveSeed(deriveSeed(seed, playerId), `n${second}`));
      const value = { x: rng.gaussian(0, 0.7), y: rng.gaussian(0, 0.6) };
      cache.set(key, value);
      return value;
    },
  };
}

/** Ball speed heuristic by pass length (km/h). */
function passSpeedKph(lengthM: number): number {
  return clamp(28 + lengthM * 1.15, 30, 85);
}

export interface TrackingWindowOptions {
  hz?: number;
}

/**
 * Generate tracking frames for the window [t0, t1] of a simulation.
 * Frames are at 10 Hz by default; the first frame is at t0 + dt.
 */
export function trackingWindow(
  result: SimulationResult,
  t0: number,
  t1: number,
  options: TrackingWindowOptions = {},
): TrackingFrame[] {
  const hz = options.hz ?? 10;
  const dt = 1 / hz;
  const seed = result.meta.seed;
  const noise = makeNoise(deriveSeed(seed, 'tracking-noise'));
  const events = result.events;

  /* ---------------- roster reconstruction ---------------- */

  const rosterChanges: RosterChange[] = [];
  for (const e of events) {
    if (e.type === 'substitution') {
      const sub = e as MatchEvent & { playerOffId: string; playerOnId: string };
      rosterChanges.push({ t: e.t, side: e.team as TeamSide, out: [sub.playerOffId], in: [sub.playerOnId] });
    } else if (e.type === 'red_card' && e.playerId) {
      rosterChanges.push({ t: e.t, side: e.team as TeamSide, out: [e.playerId], in: [] });
    }
  }
  rosterChanges.sort((a, b) => a.t - b.t);

  const playerIndex = new Map<string, SquadPlayer>();
  for (const side of ['home', 'away'] as const) {
    for (const p of result.lineups[side].starters) playerIndex.set(p.id, p);
    for (const p of result.lineups[side].bench) playerIndex.set(p.id, p);
  }

  const onPitch: Record<TeamSide, Set<string>> = {
    home: new Set(result.lineups.home.starters.map((p) => p.id)),
    away: new Set(result.lineups.away.starters.map((p) => p.id)),
  };
  // Formation slots by player id. Starters keep their own; substitutes
  // inherit the slot of the player they replace — otherwise slot % 11
  // collisions put two players on the exact same anchor.
  const slotOf = new Map<string, number>();
  for (const side of ['home', 'away'] as const) {
    for (const p of result.lineups[side].starters) slotOf.set(p.id, p.slot % 11);
  }
  let changePointer = 0;
  const applyChangesUntil = (t: number) => {
    while (changePointer < rosterChanges.length && rosterChanges[changePointer]!.t <= t) {
      const change = rosterChanges[changePointer]!;
      const inherited = change.out.map((id) => slotOf.get(id)).find((slot) => slot !== undefined);
      for (const id of change.out) onPitch[change.side].delete(id);
      for (const id of change.in) {
        onPitch[change.side].add(id);
        if (inherited !== undefined) slotOf.set(id, inherited);
      }
      changePointer++;
    }
  };
  applyChangesUntil(t0);

  /* ---------------- ball path segments ---------------- */

  // Events that move the ball. Period markers, possession changes, cards,
  // substitutions and fouls do not touch it — parking the ball on every
  // marker left it sitting at a stale spot and jumping metres when play
  // resumed. The path model below is continuous by construction: the ball
  // rolls or flies from wherever it is to wherever the next real event
  // needs it, arriving when that event happens.
  const ballMoves = (e: MatchEvent): boolean =>
    e.type === 'pass' ||
    e.type === 'carry' ||
    e.type === 'shot' ||
    e.type === 'save' ||
    e.type === 'block' ||
    e.type === 'interception' ||
    e.type === 'tackle' ||
    e.type === 'clearance' ||
    e.type === 'penalty' ||
    e.type === 'corner' ||
    e.type === 'goal_kick' ||
    e.type === 'throw_in' ||
    e.type === 'kickoff';
  const path = events.filter(ballMoves);

  const segments: BallSegment[] = [];
  let cursorPos: Vec2 = { x: 0, y: 0 };
  let cursorT = 0;
  const push = (fromT: number, toT: number, from: Vec2, to: Vec2, speedKph: number) => {
    const span = toT - fromT;
    if (span <= 1e-6) {
      if (distance(from.x, from.y, to.x, to.y) <= 0.01) return;
      toT = fromT + 1e-6;
    }
    segments.push({ fromT, toT, from: { ...from }, to: { ...to }, speedKph });
    cursorPos = { ...to };
    cursorT = toT;
  };
  const rest = (toT: number) => {
    if (toT > cursorT + 1e-6) push(cursorT, toT, cursorPos, cursorPos, 0);
  };
  /** Roll the ball to `target` so it gets there as close to `byT` as the
   *  schedule allows — just in time for the event that needs it there. */
  const moveIn = (target: Vec2, byT: number, minKph: number, maxKph: number) => {
    const d = distance(cursorPos.x, cursorPos.y, target.x, target.y);
    if (d <= 0.5) return;
    const span = byT - cursorT;
    const speed = clamp(span > 0.3 ? (d / span) * 3.6 : maxKph, minKph, maxKph);
    push(cursorT, cursorT + d / (speed / 3.6), cursorPos, target, roundTo(speed, 1));
  };

  for (let i = 0; i < path.length; i++) {
    const e = path[i]!;
    const next = path[i + 1];
    const from = e.at;
    const to = e.endAt ?? e.at;
    const travel = distance(from.x, from.y, to.x, to.y);
    const gap = Math.max((next?.t ?? e.t + 6) - e.t, 0.05);

    // Get the ball to where this event happens, by the time it happens.
    moveIn(from, e.t, 8, 30);

    let speed = 0;
    if (e.type === 'pass') {
      speed = passSpeedKph(travel) * (e.outcome === 'complete' ? 1 : 1.15);
    } else if (e.type === 'shot') {
      speed = (e as MatchEvent & { ballSpeedKph: number }).ballSpeedKph ?? 80;
    } else if (e.type === 'carry') {
      speed = clamp((travel / gap) * 3.6, 6, 30);
    } else if (e.type === 'save' || e.type === 'block') {
      speed = 45;
    } else if (e.type === 'clearance') {
      speed = 65;
    }

    if (next?.type === 'kickoff') {
      // After a goal: the ball finishes its flight into the net, holds for
      // the celebration, is walked back to the centre and waits there — no
      // ball frozen in the net for half a minute. When there is no time to
      // pace it (the compressed half-time kickoff), the ball simply rolls
      // to the centre instead of teleporting.
      const centre = { x: 0, y: 0 };
      const natural = speed > 0 && travel > 0.3 ? clamp((travel / speed) * 3.6, 0.2, 2.5) : 0;
      rest(Math.max(e.t, cursorT));
      if (natural > 0.05) push(cursorT, cursorT + natural, cursorPos, to, speed);
      if (next.t > cursorT + 5) {
        rest(cursorT + 3.5);
        const d = distance(cursorPos.x, cursorPos.y, centre.x, centre.y);
        const avail = next.t - 1 - cursorT;
        if (d > 0.5 && avail > 0.5) {
          const walkKph = clamp((d / avail) * 3.6, 6, 14);
          push(cursorT, cursorT + d / (walkKph / 3.6), cursorPos, centre, roundTo(walkKph, 1));
        } else {
          moveIn(centre, next.t, 8, 30);
        }
        rest(next.t);
      } else {
        moveIn(centre, Math.max(next.t, cursorT + 0.5), 8, 30);
      }
      continue;
    }

    if (speed > 0 && travel > 0.3) {
      // Wait until the action moment, then fly at the governed speed.
      rest(e.t);
      const flight = clamp((travel / speed) * 3.6, 0.2, 2.5);
      push(cursorT, cursorT + flight, cursorPos, to, speed);
    }
  }

  let segmentPointer = 0;
  const ballAt = (t: number): { pos: Vec2; speedKph: number } => {
    while (segmentPointer < segments.length - 1 && segments[segmentPointer + 1]!.fromT <= t) segmentPointer++;
    const seg = segments[segmentPointer];
    if (!seg || t < seg.fromT) return { pos: { x: 0, y: 0 }, speedKph: 0 };
    const span = Math.max(seg.toT - seg.fromT, 1e-6);
    const k = clamp((t - seg.fromT) / span, 0, 1);
    return {
      pos: { x: seg.from.x + (seg.to.x - seg.from.x) * k, y: seg.from.y + (seg.to.y - seg.from.y) * k },
      speedKph: seg.speedKph,
    };
  };

  /* ---------------- possession & owner ---------------- */

  let possession: TeamSide = 'home';
  let possessionPointer = 0;
  const eventPointerInit = events.findIndex((e) => e.t > t0);
  let eventPointer = eventPointerInit === -1 ? events.length : Math.max(0, eventPointerInit - 1);

  const updateGlobalState = (t: number) => {
    while (eventPointer + 1 < events.length && events[eventPointer + 1]!.t <= t) {
      eventPointer++;
    }
    while (possessionPointer < events.length && events[possessionPointer]!.t <= t) {
      const e = events[possessionPointer]!;
      if (e.type === 'kickoff' || e.type === 'possession_change') possession = e.team === 'none' ? possession : (e.team as TeamSide);
      possessionPointer++;
    }
  };
  // Prime state at t0.
  for (const e of events) {
    if (e.t > t0) break;
    if (e.type === 'kickoff' || e.type === 'possession_change') possession = e.team === 'none' ? possession : (e.team as TeamSide);
  }

  const ownerAt = (t: number): { playerId: string | null; receiveBlend: number } => {
    const e = events[eventPointer];
    if (!e) return { playerId: null, receiveBlend: 0 };
    if (e.type === 'pass') {
      const pass = e as MatchEvent & { outcome: string; recipientId: string | null; lengthM: number };
      if (pass.outcome === 'complete' && pass.recipientId) {
        const flight = clamp(distance(e.at.x, e.at.y, (e.endAt ?? e.at).x, (e.endAt ?? e.at).y) / (passSpeedKph(pass.lengthM) / 3.6), 0.4, 4);
        if (t >= e.t + flight) return { playerId: pass.recipientId, receiveBlend: 1 };
        return { playerId: e.playerId, receiveBlend: 0 };
      }
      return { playerId: e.playerId, receiveBlend: 0 };
    }
    if (e.type === 'carry' || e.type === 'shot' || e.type === 'kickoff' || e.type === 'save') {
      return { playerId: e.playerId, receiveBlend: 0 };
    }
    return { playerId: null, receiveBlend: 0 };
  };

  const nextActorId = (): string | null => {
    for (let k = eventPointer + 1; k < events.length; k++) {
      const next = events[k]!;
      if (next.type === 'pass' || next.type === 'carry' || next.type === 'shot') return next.playerId;
      // Markers don't touch the ball — keep looking for the next real actor
      // so the player scheduled on the ball is drawn to it as it rolls.
      if (ballMoves(next)) return null;
    }
    return null;
  };

  /** The next pass in the stream — who it is for, where it lands, when. */
  const nextPass = (): { recipientId: string | null; endAt: Vec2 | null; t: number } | null => {
    for (let k = eventPointer + 1; k < events.length; k++) {
      const next = events[k]!;
      if (next.type === 'pass') {
        const pass = next as MatchEvent & { recipientId: string | null; endAt: Vec2 | null };
        return { recipientId: pass.recipientId, endAt: pass.endAt, t: pass.t };
      }
      if (next.type === 'carry' || next.type === 'shot') return null;
      if (ballMoves(next)) return null;
    }
    return null;
  };

  /* ---------------- player integration ---------------- */

  const runtime = new Map<string, PlayerRuntime>();
  const spawn = (playerId: string, team: TeamSide, ballPos: Vec2, possessionTeam: TeamSide) => {
    const player = playerIndex.get(playerId)!;
    const tactics = result.config.tactics[team];
    const slot = slotOf.get(playerId) ?? player.slot % 11;
    const base =
      player.role === 'GK'
        ? goalkeeperAnchor(team, ballPos)
        : anchorPosition(formationSlotFor(tactics.formation, slot), team, possessionTeam, tactics, ballPos);
    runtime.set(playerId, { player, team, pos: base, vel: { x: 0, y: 0 }, slot });
  };

  const ball0 = ballAt(t0 + dt).pos;
  for (const side of ['home', 'away'] as const) {
    for (const id of onPitch[side]) spawn(id, side, ball0, possession);
  }
  // Whoever is on the ball starts on the ball — no dashes from far anchors
  // at a window edge (the worker tracks the match in separate windows).
  const initialOwner = ownerAt(t0 + dt).playerId;
  if (initialOwner) {
    const rt = runtime.get(initialOwner);
    if (rt) {
      rt.pos.x = ball0.x;
      rt.pos.y = ball0.y;
    }
  }

  const frames: TrackingFrame[] = [];
  const frameCount = Math.max(0, Math.floor((t1 - t0) / dt));
  const maxSpeed = (player: SquadPlayer, t: number, chasing: boolean, sprint = false): number => {
    const base = player.role === 'GK' ? 21 : 23.5 + player.ability.pace * 9.5;
    const fatigue = 1 - 0.1 * (t / 5400);
    const burst = (chasing ? 1.12 : 1) * (sprint ? 1.18 : 1);
    return base * fatigue * burst * (1000 / 3600);
  };

  const active: Array<{ id: string; rt: PlayerRuntime; speedKph: number }> = [];

  for (let f = 1; f <= frameCount; f++) {
    const t = t0 + f * dt;
    applyChangesUntil(t);
    updateGlobalState(t);

    const ball = ballAt(t);
    const owner = ownerAt(t);
    const actor = nextActorId();
    const upcoming = nextPass();
    // The future receiver starts their run early enough to meet the pass —
    // the lead grows with the distance the ball must cover.
    const receiverLead = upcoming?.endAt
      ? clamp(Math.hypot(upcoming.endAt.x - ball.pos.x, upcoming.endAt.y - ball.pos.y) / 7.5 + 1.0, 2.0, 6.5)
      : 0;
    const second = Math.floor(t);
    const frac = t - second;
    const currentEvent = events[eventPointer];
    const passInFlight =
      currentEvent && currentEvent.type === 'pass' && t >= currentEvent.t
        ? (currentEvent as MatchEvent & { outcome: string; recipientId: string | null; endAt: Vec2 | null })
        : null;
    const shotInFlight = currentEvent && currentEvent.type === 'shot' && t >= currentEvent.t ? currentEvent : null;

    // Spawn any players who joined the pitch inside this window.
    for (const side of ['home', 'away'] as const) {
      for (const id of onPitch[side]) {
        if (!runtime.has(id)) spawn(id, side, ball.pos, possession);
      }
    }

    active.length = 0;
    for (const [id, rt] of runtime) {
      if (!onPitch[rt.team].has(id)) continue;
      const tactics = result.config.tactics[rt.team];
      let target: Vec2;
      if (rt.player.role === 'GK') {
        target = goalkeeperAnchor(rt.team, ball.pos);
      } else {
        const anchor = anchorPosition(formationSlotFor(tactics.formation, rt.slot), rt.team, possession, tactics, ball.pos);
        const n0 = noise.get(id, second);
        const n1 = noise.get(id, second + 1);
        target = {
          x: anchor.x + n0.x + (n1.x - n0.x) * frac,
          y: anchor.y + n0.y + (n1.y - n0.y) * frac,
        };
      }

      const isOwner = owner.playerId === id;
      const isActor = actor === id;
      const isReceiver = Boolean(
        passInFlight && passInFlight.outcome === 'complete' && passInFlight.recipientId === id,
      );
      // A player who just released the ball (pass or shot) is no longer on
      // it: he follows through and recovers shape instead of sprinting
      // after his own ball — that lunge-and-return was the giveaway.
      const released = (passInFlight?.playerId === id) || (shotInFlight?.playerId === id);
      if (isOwner && !released) {
        target = { x: ball.pos.x, y: ball.pos.y };
      } else if (isReceiver) {
        // The intended recipient runs onto the arrival point — and gets
        // there on time: with teams holding a real shape, the receiver is
        // often metres from where the pass lands, so he sprints onto it.
        const arrival = passInFlight!.endAt ?? ball.pos;
        target = { x: arrival.x, y: arrival.y };
      } else if (
        upcoming &&
        upcoming.endAt &&
        id === upcoming.recipientId &&
        upcoming.t - t <= receiverLead &&
        upcoming.t > t
      ) {
        // The future receiver makes his run into the space the pass will
        // find — timed so he arrives with the ball, the way a forward
        // attacks a long ball instead of waiting for it.
        target = { x: upcoming.endAt.x, y: upcoming.endAt.y };
      } else if (isActor && !isOwner && !released) {
        // The next actor goes to the ball — a committed fetch when the ball
        // is loose and nobody has it, a full step-on in the last second
        // before he plays it, and a strong drift through the holds in
        // between so pass chains hand over at the ball.
        if (owner.playerId === null || (upcoming && upcoming.t - t <= 1.2)) {
          target = { x: ball.pos.x, y: ball.pos.y };
        } else {
          target = {
            x: target.x + (ball.pos.x - target.x) * 0.7,
            y: target.y + (ball.pos.y - target.y) * 0.7,
          };
        }
      }

      // Steering: seek speed from a distance time-constant, capped by the
      // player's pace, then limited by acceleration/deceleration so turns
      // and stops look human rather than servo-like.
      const dx = target.x - rt.pos.x;
      const dy = target.y - rt.pos.y;
      const dist = Math.hypot(dx, dy);
      let desiredMag = 0;
      let desiredVx = 0;
      let desiredVy = 0;
      if (dist > 0.02) {
        const tau = isOwner ? 0.4 : isReceiver ? 0.9 : isActor ? 1.1 : 2.2;
        const speedCap = maxSpeed(rt.player, t, dist > 10 || isReceiver, isReceiver);
        desiredMag = Math.min(dist / tau, speedCap);
        desiredVx = (dx / dist) * desiredMag;
        desiredVy = (dy / dist) * desiredMag;
      }
      const speedNow = Math.hypot(rt.vel.x, rt.vel.y);
      let dvx = desiredVx - rt.vel.x;
      let dvy = desiredVy - rt.vel.y;
      const dvMag = Math.hypot(dvx, dvy);
      if (dvMag > 1e-6) {
        const rate = (desiredMag < speedNow ? 7.0 : 4.6) * dt;
        const k = Math.min(1, rate / dvMag);
        rt.vel.x += dvx * k;
        rt.vel.y += dvy * k;
      } else if (dist <= 0.02) {
        rt.vel.x = 0;
        rt.vel.y = 0;
      }
      const speed = Math.hypot(rt.vel.x, rt.vel.y);
      let step = 0;
      if (speed > 1e-4 && dist > 0.02) {
        step = Math.min(speed * dt, dist);
        rt.pos.x += (rt.vel.x / speed) * step;
        rt.pos.y += (rt.vel.y / speed) * step;
        if (step >= dist) {
          rt.vel.x = 0;
          rt.vel.y = 0;
        }
      }
      active.push({ id, rt, speedKph: clamp((step / dt) * 3.6, 0, 36) });
    }

    // Separation: nobody stands inside anybody, and teammates keep real
    // spacing — a broadcast pair closer than ~2.5 m reads as one blob.
    // Three relaxation passes; duels with opponents may close to ~1.4 m.
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]!.rt;
          const b = active[j]!.rt;
          let dx = b.pos.x - a.pos.x;
          let dy = b.pos.y - a.pos.y;
          let d = Math.hypot(dx, dy);
          const min = a.team === b.team ? 2.6 : 1.4;
          if (d >= min) continue;
          if (d < 1e-3) {
            // Exactly stacked: a deterministic nudge keeps runs seeded.
            const h = active[i]!.id.charCodeAt(active[i]!.id.length - 1) + active[j]!.id.charCodeAt(active[j]!.id.length - 1);
            const ang = ((h % 360) / 360) * Math.PI * 2;
            dx = Math.cos(ang) * 0.01;
            dy = Math.sin(ang) * 0.01;
            d = 0.01;
          }
          const push = (min - d) / 2 / d;
          a.pos.x -= dx * push;
          a.pos.y -= dy * push;
          b.pos.x += dx * push;
          b.pos.y += dy * push;
        }
      }
    }

    const players: TrackingPlayer[] = active.map(({ id, rt, speedKph }) => {
      rt.pos.x = clamp(rt.pos.x, -52.5 + 0.4, 52.5 - 0.4);
      rt.pos.y = clamp(rt.pos.y, -34 + 0.4, 34 - 0.4);
      return {
        playerId: id,
        pos: { x: roundTo(rt.pos.x, 2), y: roundTo(rt.pos.y, 2) },
        speedKph: roundTo(speedKph, 1),
      };
    });

    frames.push({
      t: roundTo(t, 1),
      ball: { pos: { x: roundTo(ball.pos.x, 2), y: roundTo(ball.pos.y, 2) }, speedKph: roundTo(ball.speedKph, 1) },
      players,
    });
  }

  return frames;
}
