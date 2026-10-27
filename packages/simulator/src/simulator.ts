/**
 * The match simulator — a deterministic, football-realistic event engine.
 *
 * It plays a full 90 (+ stoppage) minutes as a stream of typed events:
 * passes with difficulty and outcomes, carries, duels, shots with xG, set
 * pieces, cards, substitutions and VAR reviews. Given the same seed and
 * configuration the output stream is byte-for-byte identical.
 *
 * The simulator models the laws and texture of football; it does not model
 * perception. Positional truth lives in events, and the 10 Hz tracking feed
 * is derived from them (see tracking.ts). Match time `t` is continuous
 * playing time: period 1 runs [0, 45min + stoppage], period 2 starts
 * immediately after half time and runs to 90min + total stoppage.
 */

import {
  clamp,
  createRng,
  deriveSeed,
  distance,
  expectedThreat,
  HALF_SECONDS,
  lerp,
  PITCH,
  roundTo,
  stableHash,
  type CarryEvent,
  type CardEvent,
  type EventType,
  type MatchConfig,
  type MatchEvent,
  type MatchMeta,
  type PassEvent,
  type PassHeight,
  type Rng,
  type ShotEvent,
  type TeamSide,
  type TeamTactics,
  type Vec2,
} from '@floodlight/core';
import { FORMATIONS, MANAGERS, REFEREES, venueForClub } from './data';
import { pickLineup, type Lineup, type SquadPlayer } from './squad';
import type { Directive, Scenario } from './scenarios';
import { CLUBS } from './data';

export interface SimulationTiming {
  halfTimeT: number;
  fullTimeT: number;
  stop1: number;
  stop2: number;
}

export interface SimulationResult {
  meta: MatchMeta;
  config: MatchConfig;
  lineups: { home: Lineup; away: Lineup };
  events: MatchEvent[];
  timing: SimulationTiming;
}

interface IntentWindow {
  team: TeamSide;
  fromT: number;
  toT: number;
  attackBias: number;
  pressBias: number;
  directBias: number;
}

interface PendingDirective {
  directive: Directive;
  done: boolean;
}

interface CardRecord {
  yellow: number;
  red: boolean;
}

const attackingDirection: Record<TeamSide, 1 | -1> = { home: 1, away: -1 };

export function buildMatchConfig(seed: number, scenario: Scenario | undefined): MatchConfig {
  const rng = createRng(deriveSeed(seed, 'config'));
  const scripted = scenario && scenario.homeClubId !== '' ? scenario : undefined;

  const home = scripted ? CLUBS.find((c) => c.club.id === scripted.homeClubId)! : rng.shuffle(CLUBS)[0]!;
  const awayChosen = scripted
    ? CLUBS.find((c) => c.club.id === scripted.awayClubId)!
    : rng.pick(CLUBS.filter((c) => c.club.id !== home.club.id));

  const merge = (base: TeamTactics, partial?: Partial<TeamTactics>): TeamTactics => ({ ...base, ...(partial ?? {}) });

  return {
    seed,
    scenario: scenario?.id ?? null,
    home: home.club,
    away: awayChosen.club,
    venue: venueForClub(home.club.id),
    kickoffISO: '2026-08-15T19:45:00.000Z',
    tactics: {
      home: merge(home.defaultTactics, scripted?.tacticsOverrides?.home),
      away: merge(awayChosen.defaultTactics, scripted?.tacticsOverrides?.away),
    },
    managers: {
      home: MANAGERS[home.club.id]!,
      away: MANAGERS[awayChosen.club.id]!,
    },
    referee: rng.pick(REFEREES),
  };
}

function flip(team: TeamSide): TeamSide {
  return team === 'home' ? 'away' : 'home';
}

function angleOf(from: Vec2, to: Vec2): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function passAnglePenalty(from: Vec2, to: Vec2, sign: 1 | -1): number {
  const dir = { x: to.x - from.x, y: to.y - from.y };
  const m = Math.hypot(dir.x, dir.y);
  if (m < 1e-6) return 0;
  const cos = (dir.x * sign) / m;
  return clamp((1 - cos) / 2, 0, 1);
}

export class MatchSimulator {
  private readonly rng: Rng;
  private readonly config: MatchConfig;
  private readonly scripted: Scenario | undefined;
  private readonly events: MatchEvent[] = [];
  private readonly intentWindows: IntentWindow[] = [];
  private readonly pending: PendingDirective[] = [];
  private readonly cards = new Map<string, CardRecord>();
  private period: 1 | 2 = 1;

  private readonly squads: Record<TeamSide, Map<string, SquadPlayer>> = { home: new Map(), away: new Map() };
  private readonly lineups: { home: Lineup; away: Lineup };
  private readonly onPitch: Record<TeamSide, string[]> = { home: [], away: [] };
  private readonly benchIndex: Record<TeamSide, number> = { home: 0, away: 0 };
  private readonly subsUsed: Record<TeamSide, number> = { home: 0, away: 0 };
  private readonly redCards: Record<TeamSide, number> = { home: 0, away: 0 };
  private readonly nextSubT: Record<TeamSide, number>;

  private t = 0;
  private halfTimeT = HALF_SECONDS;
  private eventIndex = 0;
  private readonly score: Record<TeamSide, number> = { home: 0, away: 0 };

  private possession: TeamSide = 'home';
  private ball: Vec2 = { x: 0, y: 0 };
  private carrierId: string | null = null;

  private pendingGoal: { team: TeamSide; style: 'open_play' | 'screamer' | 'penalty'; byT: number } | null = null;
  private pendingRed: TeamSide | null = null;
  private pendingRedSetAt = 0;
  private pendingOverturn: TeamSide | null = null;
  private pendingBigSave: TeamSide | null = null;
  private winBallFor: TeamSide | null = null;

  constructor(config: MatchConfig, scenario?: Scenario) {
    this.config = config;
    this.scripted = scenario && scenario.homeClubId !== '' ? scenario : undefined;
    this.rng = createRng(deriveSeed(config.seed, 'sim'));

    const homeFormation = FORMATIONS[config.tactics.home.formation] ?? FORMATIONS['4-3-3']!;
    const awayFormation = FORMATIONS[config.tactics.away.formation] ?? FORMATIONS['4-3-3']!;
    this.lineups = {
      home: pickLineup(config.home.id, 'home', homeFormation.map((s) => s.role)),
      away: pickLineup(config.away.id, 'away', awayFormation.map((s) => s.role)),
    };
    for (const side of ['home', 'away'] as const) {
      for (const p of this.lineups[side].starters) {
        this.squads[side].set(p.id, { ...p });
        this.onPitch[side].push(p.id);
      }
      for (const p of this.lineups[side].bench) this.squads[side].set(p.id, { ...p, team: side });
    }

    this.nextSubT = {
      home: 58 * 60 + this.rng.float(0, 300),
      away: 60 * 60 + this.rng.float(0, 300),
    };

    if (this.scripted) {
      for (const d of this.scripted.directives) {
        this.pending.push({ directive: d, done: false });
        if (d.kind === 'intent') {
          this.intentWindows.push({
            team: d.team,
            fromT: d.fromMinute * 60,
            toT: d.toMinute * 60,
            attackBias: d.attackBias,
            pressBias: d.pressBias,
            directBias: d.directBias,
          });
        }
      }
    }
  }

  /* ----------------------------- public ----------------------------- */

  run(): SimulationResult {
    const plannedStop1 = this.rngStateStoppage(1);
    const plannedStop2 = this.rngStateStoppage(2);
    this.halfTimeT = HALF_SECONDS + plannedStop1;

    this.kickoff('home', 0, 'Kick off');
    this.playPeriod(this.halfTimeT);
    // A review already in progress is resolved before the period ends.
    this.halfTimeT = this.t;
    const stop1 = this.halfTimeT - HALF_SECONDS;
    this.emit('half_time', 'none', null, this.ball, null, {
      detail: `Half time — ${this.config.home.abbr} ${this.score.home}, ${this.config.away.abbr} ${this.score.away}`,
    });

    this.period = 2;
    this.kickoff('away', this.halfTimeT, 'Second half under way');
    this.playPeriod(this.halfTimeT + HALF_SECONDS + plannedStop2);
    const fullTimeT = this.t;
    const stop2 = fullTimeT - this.halfTimeT - HALF_SECONDS;

    this.emit('full_time', 'none', null, this.ball, null, {
      detail: `Full time — ${this.config.home.abbr} ${this.score.home}, ${this.config.away.abbr} ${this.score.away}`,
    });

    const meta: MatchMeta = {
      id: `m-${stableHash({ seed: this.config.seed, scenario: this.config.scenario })}`,
      seed: this.config.seed,
      scenario: this.config.scenario,
      competition: 'Meridian League',
      venue: this.config.venue,
      kickoffISO: this.config.kickoffISO,
      home: this.config.home,
      away: this.config.away,
      homeManager: this.config.managers.home,
      awayManager: this.config.managers.away,
      referee: this.config.referee,
    };

    return {
      meta,
      config: this.config,
      lineups: this.lineups,
      events: this.events,
      timing: { halfTimeT: this.halfTimeT, fullTimeT, stop1, stop2 },
    };
  }

  /* --------------------------- match loop ---------------------------- */

  private playPeriod(endT: number): void {
    while (this.t < endT) this.step(endT);
  }

  private step(endT: number): void {
    const dt = this.rng.float(2.2, 6.0) / this.tempoFactor();
    if (this.t + dt >= endT) {
      this.t = endT;
      return;
    }
    this.t += dt;
    this.advanceDirectives();

    if (this.t >= this.nextSubT.home || this.t >= this.nextSubT.away) {
      this.maybeSubstitution(this.t >= this.nextSubT.home ? 'home' : 'away');
    }

    const team = this.possession;
    const carrier = this.carrierId ? this.squads[team].get(this.carrierId) : undefined;
    if (!carrier) {
      const next = this.pickRestartCarrier(team);
      this.carrierId = next.id;
      this.ball = this.positionOf(next, team);
      this.emitPossessionChange(team, 'set_piece');
      return;
    }

    const attackSign = attackingDirection[team];
    const distToGoal = distance(this.ball.x, this.ball.y, attackSign * PITCH.halfLength, 0);
    const inRange = distToGoal < 30 && Math.abs(this.ball.y) < 22;
    const intent = this.currentIntent(team);
    const attackBias = intent?.attackBias ?? 0;

    // Scripted directives take priority over natural decisions.
    if (this.pendingGoal?.team === team) {
      const urgency = this.pendingGoal.byT - this.t;
      if (inRange || urgency < 150) {
        if (this.pendingGoal.style === 'penalty') this.forcePenalty(team);
        else this.shoot(team, carrier, { forcedOutcome: 'goal', style: this.pendingGoal.style });
        this.pendingGoal = null;
        return;
      }
      if (urgency < 420) {
        this.forcedProgression(team, carrier);
        return;
      }
    }
    if (this.pendingBigSave === team) {
      this.pendingBigSave = null;
      this.shoot(team, carrier, { forcedOutcome: 'saved', style: 'open_play' });
      return;
    }

    // Defensive challenge: a nearby opponent may engage the carrier directly.
    // Defenders are far more careful inside their own penalty area.
    const challenger = this.nearestOpponent(this.ball, team);
    if (challenger) {
      const cp = this.positionOfId(challenger.id, flip(team));
      const inBoxChallenge = this.inAttackingBox(this.ball, team);
      const engagement = this.pressEngagement(this.ball, flip(team));
      if (distance(this.ball.x, this.ball.y, cp.x, cp.y) < 4.0 && this.rng.chance((inBoxChallenge ? 0.25 : 0.58) * engagement)) {
        this.resolveDuel(team, carrier, challenger.id);
        return;
      }
    }

    const shootUrge = this.shootUrge(team, distToGoal, attackBias, inRange);
    if (inRange && this.rng.chance(shootUrge)) {
      this.shoot(team, carrier, {});
      return;
    }

    const underPressure = this.pressureAt(this.ball, team) > 0.35;
    const carryUrge = 0.1 + 0.16 * this.tactics(team).directness + (underPressure ? -0.06 : 0.04);
    if (this.rng.chance(carryUrge)) {
      this.carry(team, carrier);
      return;
    }

    this.attemptPass(team, carrier, {});
  }

  /* ----------------------------- intents ----------------------------- */

  private tactics(team: TeamSide): TeamTactics {
    return this.config.tactics[team];
  }

  private currentIntent(team: TeamSide): IntentWindow | null {
    let active: IntentWindow | null = null;
    for (const w of this.intentWindows) {
      if (w.team === team && this.t >= w.fromT && this.t <= w.toT) active = w;
    }
    return active;
  }

  private shootUrge(team: TeamSide, distToGoal: number, attackBias: number, inRange: boolean): number {
    if (!inRange) return 0;
    const tactics = this.tactics(team);
    const centrality = clamp(1 - Math.abs(this.ball.y) / 24, 0, 1);
    const range = clamp(1 - distToGoal / 30, 0, 1);
    const myScore = this.score[team];
    const oppScore = this.score[flip(team)];
    const chase = myScore < oppScore && this.t > 60 * 60 ? 0.03 : 0;
    return clamp(
      0.008 + 0.085 * range ** 1.5 * (0.5 + 0.5 * centrality) + 0.025 * tactics.risk + attackBias * 0.16 + chase,
      0.004,
      0.18,
    );
  }

  private tempoFactor(): number {
    return clamp(0.75 + this.tactics(this.possession).baseTempo * 0.45, 0.75, 1.3);
  }

  /* --------------------------- ball actions -------------------------- */

  /** Pressing changes willingness to engage nearby opponents, not guaranteed success. */
  private pressEngagement(pos: Vec2, defendingTeam: TeamSide): number {
    const highZone = pos.x * attackingDirection[defendingTeam] >= -PITCH.length * 0.1;
    if (!highZone) return 1;
    const pressing = clamp(this.tactics(defendingTeam).pressing + (this.currentIntent(defendingTeam)?.pressBias ?? 0), 0, 1);
    return 0.45 + pressing * 1.1;
  }

  private pressureAt(pos: Vec2, team: TeamSide): number {
    const opponents = flip(team);
    let pressure = 0;
    for (const id of this.onPitch[opponents]) {
      const p = this.positionOfId(id, opponents);
      const d = distance(pos.x, pos.y, p.x, p.y);
      if (d < 3) pressure += 0.45;
      else if (d < 6) pressure += 0.2;
      else if (d < 9) pressure += 0.06;
    }
    return clamp(pressure * this.pressEngagement(pos, opponents), 0, 1.2);
  }

  private attemptPass(
    team: TeamSide,
    carrier: SquadPlayer,
    options: { forceRecipientId?: string; forceComplete?: boolean },
  ): void {
    const tactics = this.tactics(team);
    const intent = this.currentIntent(team);
    const directBias = (intent?.directBias ?? 0) + (tactics.directness - 0.5) * 0.6;
    const start = this.ball;
    const sign = attackingDirection[team];
    const pressure = this.pressureAt(start, team);

    const teammates = this.onPitch[team]
      .map((id) => this.squads[team].get(id)!)
      .filter((p) => p.id !== carrier.id && p.role !== 'GK');

    const candidates = teammates.map((mate) => {
      const base = this.positionOf(mate, team);
      const raw = {
        x: clamp(base.x + this.rng.gaussian(0, 1.1), -PITCH.halfLength + 0.5, PITCH.halfLength - 0.5),
        y: clamp(base.y + this.rng.gaussian(0, 1.1), -PITCH.halfWidth + 0.5, PITCH.halfWidth - 0.5),
      };
      // A single pass never crosses both halves end to end. Keep the receiver
      // in a plausible target zone; the longest balls are still ~78 m.
      const rawLen = distance(start.x, start.y, raw.x, raw.y);
      const scale = rawLen > 78 ? 78 / rawLen : 1;
      const target = scale < 1
        ? { x: start.x + (raw.x - start.x) * scale, y: start.y + (raw.y - start.y) * scale }
        : raw;
      const len = distance(start.x, start.y, target.x, target.y);
      const progress = (target.x - start.x) * sign;
      let weight = 1;
      weight *= Math.exp(-((len - 15) ** 2) / (2 * 11 ** 2));
      weight *= 1 + clamp(progress, -10, 25) / 18;
      weight *= 1 + directBias * clamp(len / 22, 0, 1.6);
      if (pressure > 0.4) weight *= len < 18 ? 1.6 : 0.7;
      weight *= 0.75 + this.rng.next() * 0.6;
      if (mate.role === 'FW') weight *= 1.08;
      return { mate, target, len, weight };
    });

    const chosen = options.forceRecipientId
      ? candidates.find((c) => c.mate.id === options.forceRecipientId) ?? this.rng.weighted(candidates, (c) => Math.max(c.weight, 0.0001))
      : this.rng.weighted(candidates, (c) => Math.max(c.weight, 0.0001));

    const angleChange = passAnglePenalty(start, chosen.target, sign);
    const difficulty = clamp(
      0.06 +
        0.017 * chosen.len +
        0.22 * pressure +
        0.16 * angleChange +
        (chosen.len > 35 ? 0.08 : 0) -
        0.06 * (carrier.ability.passing - 0.6),
      0.02,
      0.95,
    );
    const successP = clamp(0.992 - difficulty * 0.32 - 0.002 * Math.max(0, chosen.len - 30), 0.5, 0.99);

    const height: PassHeight = chosen.len > 32 ? 'high' : chosen.len > 18 && this.rng.chance(0.35) ? 'low' : 'ground';
    let outcome: PassEvent['outcome'];
    if (options.forceComplete) {
      outcome = 'complete';
    } else {
      const roll = this.rng.next();
      outcome = roll < successP ? 'complete' : this.rng.chance(0.42) ? 'out' : 'incomplete';
    }
    if (Math.abs(chosen.target.x) >= PITCH.halfLength || Math.abs(chosen.target.y) >= PITCH.halfWidth) outcome = 'out';

    // Judge the receiver and all defenders at release, before moving the ball.
    const receiverAtRelease = this.positionOf(chosen.mate, team);
    const offside = outcome === 'complete' && this.isOffsideAtRelease(start, receiverAtRelease, team);
    if (offside) outcome = 'incomplete';
    // Most inaccurate passes escape laterally; overhit balls keep their bearing.
    // This is an error destination, not a completed pass to an off-pitch player.
    const missTarget = outcome === 'out' && this.rng.chance(0.85)
      ? { x: chosen.target.x, y: chosen.target.y < 0 ? -PITCH.halfWidth : PITCH.halfWidth }
      : chosen.target;
    let target = outcome === 'out' ? this.exitPoint(start, missTarget) : chosen.target;
    if (outcome === 'out') {
      const escape = distance(start.x, start.y, target.x, target.y);
      if (escape > 82) {
        // An overhit ball that would cross the whole pitch is kept in play as
        // an inaccurate pass instead of becoming an implausible 100 m exit.
        target = {
          x: start.x + (target.x - start.x) * (82 / escape),
          y: start.y + (target.y - start.y) * (82 / escape),
        };
        outcome = 'incomplete';
      }
    }
    const event = this.emit('pass', team, carrier.id, start, target, {
      recipientId: chosen.mate.id,
      lengthM: roundTo(distance(start.x, start.y, target.x, target.y), 2),
      angleDeg: roundTo(angleOf(start, target), 1),
      height,
      outcome,
      difficulty: roundTo(difficulty, 3),
      xtSwing: roundTo(this.xtOf(target, sign) - this.xtOf(start, sign), 4),
      progressive: (target.x - start.x) * sign > 10,
      lineBreak: this.countLinesBroken(start, target, team) > 0,
      nearestOpponentM: roundTo(this.nearestOpponentDistance(start, team), 2),
      pressureAtRelease: roundTo(pressure, 3),
    }) as PassEvent;

    if (offside) {
      this.emit('offside', team, chosen.mate.id, receiverAtRelease, null, {
        detail: 'Offside',
        relatedEventId: event.id,
        ballAtRelease: { ...start },
        receiverAtRelease,
        secondLastDefenderX: this.secondLastDefenderX(team),
      });
      this.possession = flip(team);
      this.ball = receiverAtRelease;
      this.carrierId = null;
      this.emitPossessionChange(this.possession, 'set_piece');
      return;
    }
    if (outcome === 'complete') {
      this.ball = target;
      this.carrierId = chosen.mate.id;
      return;
    }
    if (outcome === 'incomplete') {
      const defender = this.nearestOpponent(chosen.target, team);
      if (defender) {
        const cleanInterception = this.rng.chance(0.09);
        if (cleanInterception) {
          this.emit('interception', flip(team), defender.id, chosen.target, null, {
            intendedRecipientId: chosen.mate.id,
            resultingPossessionTeam: flip(team),
          });
          this.possession = flip(team);
          this.carrierId = defender.id;
          this.ball = this.positionOfId(defender.id, flip(team));
        } else {
          // A loose ball that the nearest opponent comes away with.
          this.possession = flip(team);
          this.carrierId = defender.id;
          this.ball = {
            x: clamp(lerp(start.x, chosen.target.x, 0.55) + this.rng.gaussian(0, 2), -PITCH.halfLength + 1, PITCH.halfLength - 1),
            y: clamp(lerp(start.y, chosen.target.y, 0.55) + this.rng.gaussian(0, 2), -PITCH.halfWidth + 1, PITCH.halfWidth - 1),
          };
        }
        this.emitPossessionChange(this.possession, 'turnover');
        return;
      }
    }
    this.restartAfterOut(team, target, event);
  }

  private forcedProgression(team: TeamSide, carrier: SquadPlayer): void {
    const sign = attackingDirection[team];
    const forwards = this.onPitch[team]
      .map((id) => this.squads[team].get(id)!)
      .filter((p) => p.id !== carrier.id && p.role !== 'GK')
      .sort((a, b) => this.positionOf(b, team).x * sign - this.positionOf(a, team).x * sign);
    const target = forwards[0];
    if (target) {
      this.attemptPass(team, carrier, { forceRecipientId: target.id, forceComplete: true });
      return;
    }
    this.carry(team, carrier);
  }

  private carry(team: TeamSide, carrier: SquadPlayer): void {
    const sign = attackingDirection[team];
    const start = this.ball;
    const pressure = this.pressureAt(start, team);
    const goal = { x: sign * PITCH.halfLength, y: 0 };

    let dirX = (goal.x - start.x) * 0.06;
    let dirY = (goal.y - start.y) * 0.04;
    const nearest = this.nearestOpponent(start, team);
    if (nearest) {
      const np = this.positionOfId(nearest.id, flip(team));
      dirX += (start.x - np.x) * 0.09;
      dirY += (start.y - np.y) * 0.12;
    }
    dirX += this.rng.gaussian(0, 0.5);
    dirY += this.rng.gaussian(0, 0.5);

    const length = clamp(
      3 + this.rng.float(0, 7) * (1 - pressure * 0.5) * (0.7 + this.tactics(team).directness * 0.6),
      1.5,
      14,
    );
    const norm = Math.max(Math.hypot(dirX, dirY), 1e-6);
    const end = {
      x: clamp(start.x + (dirX / norm) * length, -PITCH.halfLength + 0.5, PITCH.halfLength - 0.5),
      y: clamp(start.y + (dirY / norm) * length, -PITCH.halfWidth + 0.5, PITCH.halfWidth - 0.5),
    };

    const xtStart = this.xtOf(start, sign);
    const xtEnd = this.xtOf(end, sign);
    this.emit('carry', team, carrier.id, start, end, {
      lengthM: roundTo(length, 2),
      underPressure: pressure > 0.35,
      xtSwing: roundTo(xtEnd - xtStart, 4),
    }) as CarryEvent;

    this.ball = end;

    const engage = this.nearestOpponent(end, team);
    if (engage) {
      const ep = this.positionOfId(engage.id, flip(team));
      if (distance(end.x, end.y, ep.x, ep.y) < 2.2 && this.rng.chance(0.25 * this.pressEngagement(end, flip(team)))) {
        this.resolveDuel(team, carrier, engage.id);
      }
    }
  }

  private resolveDuel(attackTeam: TeamSide, carrier: SquadPlayer, defenderId: string): void {
    const defender = this.squads[flip(attackTeam)].get(defenderId)!;
    const attackerSkill = carrier.ability.passing * 0.5 + carrier.ability.physical * 0.5;
    const defenderSkill = defender.ability.defending * 0.6 + defender.ability.physical * 0.4;
    const booked = (this.cards.get(defenderId)?.yellow ?? 0) >= 1;
    const inBox = this.inAttackingBox(this.ball, attackTeam);
    // Booked defenders and defenders in their own box pull out of challenges
    // rather than risk a second yellow or concede a penalty.
    const winP = clamp(0.38 + (attackerSkill - defenderSkill) * 0.7, 0.2, 0.8);
    const foulP = 0.4 * (booked ? 0.35 : 1) * (inBox ? 0.15 : 1) + clamp(defenderSkill - attackerSkill, -0.2, 0.3) * 0.3;

    if (this.rng.chance(foulP)) {
      this.foul(flip(attackTeam), defender, carrier);
      return;
    }
    if (this.rng.chance(winP)) {
      // Beaten defender — only sometimes recorded as a missed tackle.
      if (this.rng.chance(0.3)) {
        this.emit('tackle', flip(attackTeam), defender.id, this.ball, null, {
          tackleOutcome: 'lost',
          opponentId: carrier.id,
          duelType: 'ground',
        });
      }
      return;
    }
    this.emit('tackle', flip(attackTeam), defender.id, this.ball, null, {
      tackleOutcome: 'won',
      opponentId: carrier.id,
      duelType: 'ground',
    });
    this.possession = flip(attackTeam);
    this.carrierId = defender.id;
    this.emitPossessionChange(this.possession, 'turnover');
  }

  private foul(team: TeamSide, offender: SquadPlayer, victim: SquadPlayer): void {
    const inBox = this.inAttackingBox(this.ball, flip(team));
    const reasonRoll = this.rng.next();
    const reason = inBox ? 'last-man' : reasonRoll < 0.45 ? 'tactical' : reasonRoll < 0.85 ? 'reckless' : 'dissent';

    this.emit('foul', team, offender.id, this.ball, null, {
      fouledPlayerId: victim.id,
      card: 'none',
      reason,
      foulType: inBox ? 'penalty-area' : 'open-play',
    });

    const record = this.cards.get(offender.id) ?? { yellow: 0, red: false };
    let card: 'none' | 'yellow' | 'red' = 'none';
    if (this.pendingRed === team) {
      card = 'red';
      this.pendingRed = null;
    } else if (inBox) {
      // A penalty is already the sanction; a card on top of it is rare.
      card = this.rng.chance(0.04) ? 'red' : this.rng.chance(0.12) ? 'yellow' : 'none';
    } else if (reason === 'reckless' && this.rng.chance(0.3)) {
      card = 'yellow';
    } else if (reason === 'dissent' && this.rng.chance(0.24)) {
      card = 'yellow';
    } else if (reason === 'tactical' && this.rng.chance(0.1)) {
      card = 'yellow';
    }

    if (card === 'yellow') {
      record.yellow += 1;
      this.cards.set(offender.id, record);
      if (record.yellow >= 2) card = 'red';
      this.emit('yellow_card', team, offender.id, this.ball, null, { playerId: offender.id, reason });
    }
    if (card === 'red') {
      record.red = true;
      this.cards.set(offender.id, record);
      this.redCards[team] += 1;
      this.emit('red_card', team, offender.id, this.ball, null, { playerId: offender.id, reason }) as CardEvent;
      this.removeFromPitch(team, offender.id);
    }

    if (inBox) {
      this.penalty(flip(team));
      return;
    }
    this.possession = flip(team);
    this.carrierId = null;
    this.emitPossessionChange(this.possession, 'set_piece');
  }

  private penalty(team: TeamSide, forceGoal = false): void {
    const sign = attackingDirection[team];
    const spot = { x: sign * (PITCH.halfLength - 11), y: 0 };
    this.emit('penalty', team, null, spot, null, { detail: 'Penalty awarded' });
    const shooters = this.onPitch[team]
      .map((id) => this.squads[team].get(id)!)
      .filter((p) => p.role !== 'GK')
      .sort((a, b) => b.ability.shooting - a.ability.shooting);
    const shooter = shooters[0]!;
    this.ball = spot;
    this.carrierId = shooter.id;
    this.shoot(team, shooter, { isPenalty: true, forcedOutcome: forceGoal ? 'goal' : undefined });
  }

  private forcePenalty(team: TeamSide): void {
    this.penalty(team, true);
  }

  private shoot(
    team: TeamSide,
    shooter: SquadPlayer,
    options: { forcedOutcome?: 'goal' | 'saved'; style?: 'open_play' | 'screamer' | 'penalty'; isPenalty?: boolean },
  ): void {
    const sign = attackingDirection[team];

    let start = this.ball;
    if (options.isPenalty) {
      start = { x: sign * (PITCH.halfLength - 11), y: 0 };
    } else if (options.style === 'screamer') {
      start = { x: sign * (PITCH.halfLength - 27 + this.rng.float(-2, 4)), y: this.rng.float(-7, 7) };
    } else if (options.forcedOutcome && (options.forcedOutcome === 'saved' || distance(start.x, start.y, sign * PITCH.halfLength, 0) > 26)) {
      // Authored chances use plausible shooting locations rather than inflated xG.
      const range = options.forcedOutcome === 'saved' ? this.rng.float(5, 9) : this.rng.float(7, 15);
      start = { x: sign * (PITCH.halfLength - range), y: clamp(this.rng.gaussian(0, 3), -8, 8) };
    }
    this.ball = start;

    const dist = distance(start.x, start.y, sign * PITCH.halfLength, 0);
    const centrality = clamp(1 - Math.abs(start.y) / 20, 0, 1);
    const pressure = options.isPenalty ? 0 : clamp(this.pressureAt(start, team) * 0.7, 0, 1);
    let xg = options.isPenalty
      ? 0.78
      : clamp(
          1 / (1 + Math.exp(-(-0.2 - 0.19 * dist + 0.5 * centrality - 0.75 * pressure + 0.4 * (shooter.ability.shooting - 0.6)))),
          0.01,
          0.45,
        );
    // Heuristic, not fitted to real-world shots. The recorded value is also
    // the exact Bernoulli probability, including goalkeeper ability.
    const goalkeeper = this.goalkeeperOf(flip(team));
    const keeperAdj = goalkeeper ? 1 - 0.3 * (goalkeeper.ability.defending - 0.6) : 1;
    xg = roundTo(clamp(xg * keeperAdj, 0.001, 0.99), 3);
    let outcome: ShotEvent['outcome'];
    if (options.forcedOutcome) {
      outcome = options.forcedOutcome;
    } else if (this.rng.chance(xg)) {
      outcome = 'goal';
    } else {
      const roll = this.rng.next();
      if (roll < 0.24 && !options.isPenalty) outcome = 'blocked';
      else if (roll < 0.62) outcome = 'saved';
      else if (roll < 0.9) outcome = 'off_target';
      else outcome = 'post';
    }

    // Authored storylines may suppress natural goals in specific windows so
    // the intended shape of the story survives (e.g. a siege staying 0-0).
    if (outcome === 'goal' && !options.forcedOutcome && this.naturalGoalSuppressed(team)) {
      outcome = this.rng.chance(0.5) ? 'saved' : 'off_target';
    }

    const ballSpeed = options.isPenalty
      ? this.rng.float(78, 95)
      : options.style === 'screamer'
        ? this.rng.float(96, 112)
        : clamp(70 + shooter.ability.shooting * 32 + this.rng.gaussian(0, 7) - dist * 0.55, 45, 114);

    const underReview = outcome === 'goal' && (this.pendingOverturn === team || this.rng.chance(0.1));
    const isOverturn = underReview && this.pendingOverturn === team;
    if (isOverturn) this.pendingOverturn = null;

    const shot = this.emit('shot', team, shooter.id, start, { x: sign * PITCH.halfLength, y: clamp(start.y * 0.3, -3, 3) }, {
      outcome,
      xg,
      // Authored overrides are explicit; their xG is the counterfactual natural probability.
      outcomeForced: Boolean(options.forcedOutcome),
      naturalGoalSuppressed: this.naturalGoalSuppressed(team),
      bodyPart: options.isPenalty || this.rng.chance(0.75) ? (this.rng.chance(0.6) ? 'right' : 'left') : this.rng.chance(0.6) ? 'head' : 'other',
      distanceM: roundTo(dist, 1),
      angleDeg: roundTo(angleOf(start, { x: sign * PITCH.halfLength, y: 0 }), 1),
      ballSpeedKph: roundTo(ballSpeed, 1),
      bigChance: options.isPenalty || xg >= 0.2,
      assistPlayerId: null,
      blockedBy: null,
      isPenalty: Boolean(options.isPenalty),
    }) as ShotEvent;

    if (outcome === 'goal') {
      // Like the engine, count provisionally on the shot and retract only on overturn.
      this.score[team] += 1;
      if (underReview) {
        this.emit('var_check', 'none', null, start, null, { detail: 'Goal under review', relatedEventId: shot.id });
        // No ordinary play, directives or substitutions while the ball is dead.
        this.t += 90;
        if (isOverturn) this.score[team] -= 1;
        this.emit('var_check', 'none', null, start, null, {
          detail: isOverturn ? 'Overturned — offside' : 'Goal awarded',
          relatedEventId: shot.id,
        });
        this.t += 60;
        if (isOverturn) {
          this.possession = flip(team);
          this.ball = start;
          this.carrierId = null;
          this.emitPossessionChange(this.possession, 'set_piece');
        } else this.kickoff(flip(team), this.t, 'Restart after review');
        return;
      }
      this.t += 45;
      this.kickoff(flip(team), this.t, 'Restart after goal');
      return;
    }
    if (outcome === 'blocked') {
      const blocker = this.nearestOpponent(start, team);
      if (blocker) {
        this.emit('block', flip(team), blocker.id, start, null, { shooterId: shooter.id });
      }
      if (this.rng.chance(0.45)) {
        this.corner(team);
        return;
      }
      if (this.rng.chance(0.45)) {
        this.possession = flip(team);
        this.carrierId = blocker?.id ?? null;
        this.ball = {
          x: start.x + this.rng.gaussian(0, 3),
          y: clamp(start.y + this.rng.gaussian(0, 3), -PITCH.halfWidth, PITCH.halfWidth),
        };
        this.emitPossessionChange(this.possession, 'turnover');
      } else {
        this.restartFromDefendingTeam(flip(team));
      }
      return;
    }
    if (outcome === 'saved') {
      const keeper = this.goalkeeperOf(flip(team));
      if (keeper) {
        this.emit('save', flip(team), keeper.id, { x: sign * PITCH.halfLength, y: clamp(start.y * 0.3, -3.5, 3.5) }, null, {
          shooterId: shooter.id,
          xg: roundTo(xg, 3),
          difficulty: roundTo(clamp(xg * 1.7 + ballSpeed / 220, 0.05, 1), 3),
        });
      }
      if (this.rng.chance(0.5)) this.corner(team);
      else this.restartFromDefendingTeam(flip(team), keeper?.id);
      return;
    }
    if (outcome === 'post') {
      if (this.rng.chance(0.6)) this.corner(team);
      else this.restartFromDefendingTeam(flip(team));
      return;
    }
    this.restartFromDefendingTeam(flip(team));
  }

  /* ----------------------------- restarts ---------------------------- */

  private kickoff(team: TeamSide, atT: number, detail: string): void {
    this.t = Math.max(this.t, atT);
    this.ball = { x: 0, y: 0 };
    this.possession = team;
    const starters = this.onPitch[team].map((id) => this.squads[team].get(id)!);
    const taker = starters.filter((p) => p.role === 'MF' || p.role === 'FW')[0] ?? starters[1]!;
    this.carrierId = taker.id;
    this.emit('kickoff', team, taker.id, this.ball, null, { detail });
  }

  private restartFromDefendingTeam(team: TeamSide, keeperId?: string): void {
    this.possession = team;
    const keeper = keeperId ? this.squads[team].get(keeperId) : this.goalkeeperOf(team);
    if (keeper && this.onPitch[team].includes(keeper.id)) {
      this.ball = this.positionOf(keeper, team);
      this.carrierId = keeper.id;
    } else {
      this.carrierId = null;
    }
    this.emitPossessionChange(team, 'out_of_play');
  }

  private corner(team: TeamSide, exitY?: number): void {
    const sign = attackingDirection[team];
    const lowerSide = exitY === undefined ? this.rng.chance(0.5) : exitY < 0;
    const y = lowerSide ? -PITCH.halfWidth + 0.4 : PITCH.halfWidth - 0.4;
    const spot = { x: sign * (PITCH.halfLength - 0.4), y };
    this.emit('corner', team, null, spot, null, { detail: 'Corner' });
    this.possession = team;
    const target = { x: sign * (PITCH.halfLength - this.rng.float(6, 11)), y: this.rng.gaussian(0, 5) };
    const attackers = this.onPitch[team]
      .map((id) => this.squads[team].get(id)!)
      .filter((p) => p.role !== 'GK')
      .sort((a, b) => b.ability.physical - a.ability.physical);
    const header = attackers[0]!;
    if (this.rng.chance(0.35)) {
      this.ball = target;
      this.carrierId = header.id;
      this.shoot(team, header, {});
      return;
    }
    this.ball = target;
    this.possession = flip(team);
    const defender = this.nearestOpponent(target, team);
    this.carrierId = defender?.id ?? null;
    this.emitPossessionChange(this.possession, 'turnover');
  }

  /** First boundary crossed by an errant pass, extending its travel if needed. */
  private exitPoint(start: Vec2, target: Vec2): Vec2 {
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const tx = dx === 0 ? Infinity : ((dx > 0 ? PITCH.halfLength : -PITCH.halfLength) - start.x) / dx;
    const ty = dy === 0 ? Infinity : ((dy > 0 ? PITCH.halfWidth : -PITCH.halfWidth) - start.y) / dy;
    const travel = Math.min(tx >= 0 ? tx : Infinity, ty >= 0 ? ty : Infinity);
    if (!Number.isFinite(travel)) return { x: clamp(start.x, -PITCH.halfLength, PITCH.halfLength), y: PITCH.halfWidth };
    return {
      x: clamp(start.x + dx * travel, -PITCH.halfLength, PITCH.halfLength),
      y: clamp(start.y + dy * travel, -PITCH.halfWidth, PITCH.halfWidth),
    };
  }

  private restartAfterOut(team: TeamSide, where: Vec2, sourceEvent: MatchEvent): void {
    const sign = attackingDirection[team];
    const exit = this.exitPoint(sourceEvent.at, where);
    if (Math.abs(exit.x) >= PITCH.halfLength - 1e-6) {
      if (exit.x * sign < 0) {
        // Last touched by the defending team: corner at that end and touchline.
        this.corner(flip(team), exit.y);
      } else {
        const spot = { x: sign * (PITCH.halfLength - PITCH.sixYardLength), y: 0 };
        this.emit('goal_kick', flip(team), null, spot, null, { detail: 'Goal kick' });
        this.possession = flip(team);
        this.ball = spot;
        this.carrierId = this.goalkeeperOf(this.possession)?.id ?? null;
        this.emitPossessionChange(this.possession, 'out_of_play');
      }
      return;
    }
    const throwTeam = flip(team);
    const spot = { x: exit.x, y: exit.y < 0 ? -PITCH.halfWidth : PITCH.halfWidth };
    this.emit('throw_in', throwTeam, null, spot, null, { detail: 'Throw-in' });
    this.possession = throwTeam;
    this.ball = spot;
    this.carrierId = null;
    this.emitPossessionChange(throwTeam, 'out_of_play');
  }

  private secondLastDefenderX(team: TeamSide): number {
    const sign = attackingDirection[team];
    const defenders = this.onPitch[flip(team)]
      .map((id) => this.positionOfId(id, flip(team)).x)
      .sort((a, b) => b * sign - a * sign);
    return defenders[1] ?? -sign * PITCH.halfLength;
  }

  private isOffsideAtRelease(ball: Vec2, receiver: Vec2, team: TeamSide): boolean {
    const sign = attackingDirection[team];
    const receiverX = receiver.x * sign;
    return receiverX > 0 && receiverX > ball.x * sign && receiverX > this.secondLastDefenderX(team) * sign;
  }

  /* --------------------------- substitutions ------------------------- */

  private maybeSubstitution(side: TeamSide): void {
    if (this.subsUsed[side] >= 3) {
      this.nextSubT[side] = Infinity;
      return;
    }
    const bench = this.lineups[side].bench;
    // Skip the backup goalkeeper — keepers are not substituted in this model.
    let idx = this.benchIndex[side];
    while (idx < bench.length && bench[idx]!.role === 'GK') idx++;
    const on = bench[idx];
    if (!on) {
      this.nextSubT[side] = Infinity;
      return;
    }
    const candidates = this.onPitch[side]
      .map((id) => this.squads[side].get(id)!)
      .filter((p) => p.role === on.role && p.role !== 'GK')
      .sort((a, b) => a.ability.physical + a.ability.pace - (b.ability.physical + b.ability.pace));
    const off = candidates[0];
    if (!off) {
      this.nextSubT[side] = this.t + 120;
      return;
    }
    // The bench stays pristine — downstream consumers (engine, tracking)
    // rebuild rosters from it plus the substitution events.
    this.benchIndex[side] = idx + 1;
    this.removeFromPitch(side, off.id);
    this.onPitch[side].push(on.id);
    this.squads[side].set(on.id, { ...on, team: side, slot: off.slot });
    this.emit('substitution', side, off.id, this.ball, null, {
      playerId: off.id,
      playerOffId: off.id,
      playerOnId: on.id,
    });
    this.subsUsed[side] += 1;
    this.nextSubT[side] = this.t + this.rng.float(180, 420);
  }

  private removeFromPitch(side: TeamSide, playerId: string): void {
    this.onPitch[side] = this.onPitch[side].filter((id) => id !== playerId);
    if (this.carrierId === playerId) this.carrierId = null;
  }

  /* ----------------------------- helpers ------------------------------ */

  private advanceDirectives(): void {
    for (const p of this.pending) {
      if (p.done) continue;
      const d = p.directive;
      switch (d.kind) {
        case 'force_goal': {
          const deadline = d.byMinute * 60;
          if (this.t >= deadline - 200) {
            this.pendingGoal = { team: d.team, style: d.style, byT: deadline };
            this.winBallFor = d.team;
            p.done = true;
          } else if (this.t >= deadline - 380) {
            this.winBallFor = d.team;
          }
          break;
        }
        case 'force_red_card': {
          if (this.t >= d.atMinute * 60) {
            this.pendingRed = d.team;
            this.pendingRedSetAt = this.t;
            p.done = true;
          }
          break;
        }
        case 'force_var_overturn': {
          if (this.t >= d.atMinute * 60) {
            this.pendingOverturn = d.team;
            p.done = true;
          }
          break;
        }
        case 'force_big_save': {
          if (this.t >= d.atMinute * 60 && this.t < d.atMinute * 60 + 240) {
            this.pendingBigSave = d.team;
            p.done = true;
          }
          break;
        }
        case 'intent':
          p.done = true;
          break;
      }
    }

    // Fallbacks so scripted beats always land even if the match drifts.
    if (this.pendingRed && this.t > this.pendingRedSetAt + 240) {
      const team = this.pendingRed;
      const defender = this.nearestOpponent(this.ball, flip(team)) ?? this.onPitch[team].map((id) => this.squads[team].get(id)!)[1];
      const victim = this.pickRestartCarrier(flip(team));
      if (defender) this.foul(team, defender, victim);
      this.pendingRed = null;
    }
    if (this.winBallFor && this.possession !== this.winBallFor && this.rng.chance(0.08)) {
      this.possession = this.winBallFor;
      this.carrierId = null;
      this.emitPossessionChange(this.possession, 'turnover');
    }
    if (this.winBallFor && this.possession === this.winBallFor) {
      this.winBallFor = null;
    }
  }

  private naturalGoalSuppressed(team: TeamSide): boolean {
    if (!this.scripted?.naturalGoalBlocks) return false;
    const minute = this.t / 60;
    return this.scripted.naturalGoalBlocks.some(
      (b) => minute >= b.fromMinute && minute <= b.toMinute && (b.team === 'both' || b.team === team),
    );
  }

  private positionOf(player: SquadPlayer, team: TeamSide): Vec2 {
    return this.positionOfId(player.id, team);
  }

  /** Formation anchor, shifted by possession phase and ball position. */
  private positionOfId(playerId: string, team: TeamSide): Vec2 {
    const player = this.squads[team].get(playerId);
    if (!player) return { x: 0, y: 0 };
    const formation = FORMATIONS[this.tactics(team).formation] ?? FORMATIONS['4-3-3']!;
    const s = formation[player.slot % formation.length]!;
    const sign = attackingDirection[team];
    const inPossession = this.possession === team;
    const tactics = this.tactics(team);

    const ballShift = (this.ball.x * sign) / PITCH.halfLength;
    const slide = clamp(ballShift * 0.18, -0.18, 0.18);
    let x = s.x + slide;
    if (!inPossession) {
      x = x * (0.55 + tactics.lineHeight * 0.5) - 0.06 * (1 - tactics.lineHeight);
    }
    const widthScale = inPossession ? 0.9 + tactics.width * 0.35 : 0.82;
    const y = s.y * widthScale + ((this.ball.y * sign) / PITCH.halfWidth) * 0.12;

    return {
      x: clamp(sign * (-PITCH.halfLength + x * PITCH.length), -PITCH.halfLength + 0.5, PITCH.halfLength - 0.5),
      y: clamp(y * PITCH.halfWidth, -PITCH.halfWidth + 0.5, PITCH.halfWidth - 0.5),
    };
  }

  private pickRestartCarrier(team: TeamSide): SquadPlayer {
    const options = this.onPitch[team]
      .map((id) => this.squads[team].get(id)!)
      .filter((p) => p.role === 'MF' || p.role === 'DF');
    const pool = options.length > 0 ? options : this.onPitch[team].map((id) => this.squads[team].get(id)!);
    return this.rng.pick(pool);
  }

  private goalkeeperOf(team: TeamSide): SquadPlayer | undefined {
    return this.onPitch[team].map((id) => this.squads[team].get(id)!).find((p) => p.role === 'GK');
  }

  private nearestOpponent(pos: Vec2, team: TeamSide): SquadPlayer | undefined {
    const opponents = flip(team);
    let best: SquadPlayer | undefined;
    let bestD = Infinity;
    for (const id of this.onPitch[opponents]) {
      const opp = this.squads[opponents].get(id)!;
      if (opp.role === 'GK') continue;
      const p = this.positionOfId(id, opponents);
      const d = distance(pos.x, pos.y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = opp;
      }
    }
    return best;
  }

  private nearestOpponentDistance(pos: Vec2, team: TeamSide): number {
    const opp = this.nearestOpponent(pos, team);
    if (!opp) return 99;
    const p = this.positionOfId(opp.id, flip(team));
    return distance(pos.x, pos.y, p.x, p.y);
  }

  private countLinesBroken(start: Vec2, end: Vec2, team: TeamSide): number {
    const sign = attackingDirection[team];
    const opponents = flip(team);
    const lineXs: number[] = [];
    for (const id of this.onPitch[opponents]) {
      const opp = this.squads[opponents].get(id)!;
      if (opp.role === 'GK') continue;
      lineXs.push(this.positionOfId(id, opponents).x * sign);
    }
    // Work entirely in attack-normalized coordinates; backward passes cannot break lines.
    const low = start.x * sign;
    const high = end.x * sign;
    if (high <= low) return 0;
    lineXs.sort((a, b) => a - b);
    const lines: number[] = [];
    for (const x of lineXs) {
      const last = lines[lines.length - 1];
      if (last === undefined || x - last > 6) lines.push(x);
    }
    let broken = 0;
    for (const line of lines) {
      if (line > low + 0.5 && line < high - 0.5) broken++;
    }
    return broken;
  }

  private inAttackingBox(pos: Vec2, team: TeamSide): boolean {
    const sign = attackingDirection[team];
    const dx = (sign * PITCH.halfLength - pos.x) * sign;
    return dx >= 0 && dx <= PITCH.penaltyAreaLength && Math.abs(pos.y) <= PITCH.penaltyAreaWidth / 2;
  }

  private rngStateStoppage(period: 1 | 2): number {
    const base = period === 1 ? this.rng.int(140, 300) : this.rng.int(200, 400);
    return base;
  }

  /**
   * Expected-threat surface — delegates to the single shared definition in
   * core so the engine and the simulator can never disagree.
   */
  xtOf(pos: Vec2, attackSign: 1 | -1): number {
    return expectedThreat(pos, attackSign);
  }

  private emit(
    type: EventType,
    team: TeamSide | 'none',
    playerId: string | null,
    at: Vec2,
    endAt: Vec2 | null,
    payload: Record<string, unknown>,
  ): MatchEvent {
    this.eventIndex++;
    const event = {
      id: `e${String(this.eventIndex).padStart(5, '0')}`,
      index: this.eventIndex,
      t: roundTo(this.t, 1),
      period: this.period,
      type,
      team,
      playerId,
      at: { x: roundTo(at.x, 2), y: roundTo(at.y, 2) },
      endAt: endAt ? { x: roundTo(endAt.x, 2), y: roundTo(endAt.y, 2) } : null,
      ...payload,
    } as MatchEvent;
    this.events.push(event);
    return event;
  }

  private emitPossessionChange(toTeam: TeamSide, cause: 'turnover' | 'out_of_play' | 'set_piece'): void {
    this.emit('possession_change', toTeam, null, this.ball, null, { toTeam, cause });
  }
}

/* ---------------------------- entry point ---------------------------- */

export function simulateMatch(seed: number, scenario?: Scenario): SimulationResult {
  const config = buildMatchConfig(seed, scenario);
  const simulator = new MatchSimulator(config, scenario);
  return simulator.run();
}

export type { SquadPlayer, Lineup };
