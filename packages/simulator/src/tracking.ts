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

  const segments: BallSegment[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const next = events[i + 1];
    if (!next) break;
    const gap = Math.max(next.t - e.t, 0.05);
    const from = e.at;
    const to = e.endAt ?? e.at;
    const travel = distance(from.x, from.y, to.x, to.y);

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

    if (next.type === 'kickoff') {
      // After a goal: the ball finishes its flight into the net, holds for
      // the celebration, is walked back to the centre at a stroll and waits
      // there for the restart — no ball frozen in the net for half a minute.
      const centre = { x: 0, y: 0 };
      const flight = speed > 0 && travel > 0.3 ? clamp((travel / speed) * 3.6, 0.2, 2.5) : 0;
      const flightEnd = Math.min(e.t + flight, next.t);
      if (flight > 0) segments.push({ fromT: e.t, toT: flightEnd, from, to, speedKph: speed });
      const restEnd = Math.min(flightEnd + 3.5, next.t);
      if (restEnd > flightEnd) segments.push({ fromT: flightEnd, toT: restEnd, from: to, to, speedKph: 0 });
      const walkSeconds = distance(to.x, to.y, centre.x, centre.y) / (14 / 3.6);
      const glideEnd = Math.min(restEnd + walkSeconds, next.t);
      if (glideEnd > restEnd) segments.push({ fromT: restEnd, toT: glideEnd, from: to, to: centre, speedKph: 14 });
      if (next.t > glideEnd) segments.push({ fromT: glideEnd, toT: next.t, from: centre, to: centre, speedKph: 0 });
      continue;
    }

    // Where the ball will restart: if the break is long, the ball is walked
    // from where it stopped to the restart spot and placed there — never
    // parked on a frozen pixel for half a minute.
    const restart = { x: clamp(next.at.x, -50.5, 50.5), y: clamp(next.at.y, -32.5, 32.5) };
    const parkThenGlide = (fromT: number, toT: number, restAt: Vec2) => {
      const walkSeconds = distance(restAt.x, restAt.y, restart.x, restart.y) / (16 / 3.6);
      if (toT - fromT < 3 + walkSeconds) {
        segments.push({ fromT, toT, from: restAt, to: restAt, speedKph: 0 });
        return;
      }
      const moveStart = fromT + 3;
      const moveEnd = Math.min(moveStart + walkSeconds, toT);
      segments.push({ fromT, toT: moveStart, from: restAt, to: restAt, speedKph: 0 });
      segments.push({ fromT: moveStart, toT: moveEnd, from: restAt, to: restart, speedKph: 16 });
      if (moveEnd < toT) segments.push({ fromT: moveEnd, toT, from: restart, to: restart, speedKph: 0 });
    };

    if (speed > 0 && travel > 0.3) {
      // Flight: the ball travels at governed speed, then rests where it lands.
      const flight = clamp((travel / speed) * 3.6, 0.2, 2.5);
      const flightEnd = Math.min(e.t + flight, next.t);
      segments.push({ fromT: e.t, toT: flightEnd, from, to, speedKph: speed });
      if (flightEnd < next.t) {
        parkThenGlide(flightEnd, next.t, to);
      }
    } else {
      parkThenGlide(e.t, next.t, to);
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
    const next = events[eventPointer + 1];
    return next && (next.type === 'pass' || next.type === 'carry' || next.type === 'shot') ? next.playerId : null;
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
  const maxSpeed = (player: SquadPlayer, t: number, chasing: boolean): number => {
    const base = player.role === 'GK' ? 21 : 23.5 + player.ability.pace * 9.5;
    const fatigue = 1 - 0.1 * (t / 5400);
    const burst = chasing ? 1.12 : 1;
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
      // A player who just released the ball (pass or shot) is no longer on
      // it: he follows through and recovers shape instead of sprinting
      // after his own ball — that lunge-and-return was the giveaway.
      const released = (passInFlight?.playerId === id) || (shotInFlight?.playerId === id);
      if (isOwner && !released) {
        target = { x: ball.pos.x, y: ball.pos.y };
      } else if (passInFlight && passInFlight.recipientId === id && passInFlight.outcome === 'complete') {
        // The intended recipient runs onto the arrival point — a burst onto
        // the pass that arrives with the ball, instead of reacting late.
        const arrival = passInFlight.endAt ?? ball.pos;
        target = { x: arrival.x, y: arrival.y };
      } else if (isActor && !isOwner && ball.speedKph > 5) {
        // The next actor drifts toward the ball to receive or collect — but
        // only while the ball is actually travelling. A ball at rest holds
        // the shape; nobody sprints at nothing during kickoff waits.
        target = {
          x: target.x + (ball.pos.x - target.x) * 0.45,
          y: target.y + (ball.pos.y - target.y) * 0.45,
        };
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
        const tau = isOwner ? 0.4 : isActor ? 1.1 : 2.2;
        const speedCap = maxSpeed(rt.player, t, dist > 10);
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

    // Separation: nobody stands inside anybody. Two relaxation passes —
    // teammates keep more space than opponents (duels may get close).
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]!.rt;
          const b = active[j]!.rt;
          let dx = b.pos.x - a.pos.x;
          let dy = b.pos.y - a.pos.y;
          let d = Math.hypot(dx, dy);
          const min = a.team === b.team ? 1.8 : 1.0;
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
