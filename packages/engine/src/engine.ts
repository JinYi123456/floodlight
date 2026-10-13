/**
 * The football intelligence engine — the Interpret stage.
 *
 * Consumes the simulator's event stream (and optional tracking frames) and
 * maintains live match state: possession, pass quality, xT, control vs
 * chaos, rhythm, momentum, player workload — plus a running feed of
 * `InsightCandidate`s: significant moments with structured facts and
 * evidence ids attached, ready for the agent crew to explain and verify.
 *
 * Every number the engine reports is a deterministic function of the event
 * stream. Nothing is sampled, nothing is guessed.
 */

import {
  clamp,
  distance,
  formatMinute,
  isInAttackingBox,
  roundTo,
  SPRINT_THRESHOLD_KPH,
  type MatchEvent,
  type MatchMeta,
  type TeamSide,
  type TrackingFrame,
} from '@floodlight/core';
import { readControlChaos, readRhythm, MomentumTracker, type ControlChaosReading, type RhythmReading, type WindowFeatures } from './analysis';

export interface TeamMatchStats {
  side: TeamSide;
  goals: number;
  goalsDisallowed: number;
  shots: number;
  shotsOnTarget: number;
  bigChances: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  passAccuracy: number;
  progressivePasses: number;
  passDifficultyAvg: number;
  xtGenerated: number;
  carries: number;
  tackles: number;
  interceptions: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  corners: number;
  turnovers: number;
  highTurnovers: number;
  possessionSeconds: number;
  possessionShare: number;
  defensiveActions: number;
  ppda: number;
  topSpeedKph: number;
  distanceCoveredKm: number;
  sprints: number;
  touchesInBox: number;
}

export interface PlayerMatchStats {
  playerId: string;
  name: string;
  shirt: number;
  team: TeamSide;
  role: string;
  goals: number;
  assists: number;
  shots: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  keyPasses: number;
  progressivePasses: number;
  xtGenerated: number;
  carries: number;
  tackles: number;
  interceptions: number;
  foulsCommitted: number;
  yellowCards: number;
  redCards: number;
  touches: number;
  distanceKm: number;
  topSpeedKph: number;
  sprints: number;
  duelsWon: number;
}

export type MomentKind =
  | 'goal'
  | 'var_review'
  | 'var_overturn'
  | 'penalty'
  | 'red_card'
  | 'big_chance'
  | 'big_save'
  | 'momentum_shift'
  | 'siege'
  | 'comeback_trigger'
  | 'late_drama'
  | 'milestone'
  | 'speed_flash'
  | 'tactical_pressure';

export interface InsightCandidate {
  id: string;
  t: number;
  minuteLabel: string;
  kind: MomentKind;
  /** 0..1 — how much this deserves air. */
  salience: number;
  team: TeamSide | 'none';
  playerId: string | null;
  facts: Record<string, string | number | boolean>;
  evidenceEventIds: string[];
  window: { t0: number; t1: number } | null;
  provisional: boolean;
  overturned: boolean;
}

export interface MatchState {
  meta: MatchMeta;
  clockSeconds: number;
  period: 1 | 2;
  score: { home: number; away: number };
  possession: { home: number; away: number };
  teams: { home: TeamMatchStats; away: TeamMatchStats };
  players: PlayerMatchStats[];
  controlChaos: ControlChaosReading;
  rhythm: RhythmReading;
  tempo: { actionsPerMinute: number; passSpeedAvgKph: number };
  momentum: { value: number; series: Array<{ minute: number; value: number }> };
}

interface MinuteBucket {
  passes: number;
  completed: number;
  shots: number;
  xg: number;
  xt: number;
  turnovers: number;
  duels: number;
  defActionsHigh: number;
  possessionSec: number;
  passSpeedSum: number;
  passSpeedCount: number;
}

function emptyBucket(): MinuteBucket {
  return {
    passes: 0,
    completed: 0,
    shots: 0,
    xg: 0,
    xt: 0,
    turnovers: 0,
    duels: 0,
    defActionsHigh: 0,
    possessionSec: 0,
    passSpeedSum: 0,
    passSpeedCount: 0,
  };
}

function emptyTeamStats(side: TeamSide): TeamMatchStats {
  return {
    side,
    goals: 0,
    goalsDisallowed: 0,
    shots: 0,
    shotsOnTarget: 0,
    bigChances: 0,
    xg: 0,
    passes: 0,
    passesCompleted: 0,
    passAccuracy: 0,
    progressivePasses: 0,
    passDifficultyAvg: 0,
    xtGenerated: 0,
    carries: 0,
    tackles: 0,
    interceptions: 0,
    fouls: 0,
    yellowCards: 0,
    redCards: 0,
    corners: 0,
    turnovers: 0,
    highTurnovers: 0,
    possessionSeconds: 0,
    possessionShare: 0,
    defensiveActions: 0,
    ppda: 0,
    topSpeedKph: 0,
    distanceCoveredKm: 0,
    sprints: 0,
    touchesInBox: 0,
  };
}

export interface LineupPlayerLike {
  id: string;
  name: string;
  shirt: number;
  role: string;
}

export interface LineupsLike {
  home: { starters: LineupPlayerLike[]; bench?: LineupPlayerLike[] };
  away: { starters: LineupPlayerLike[]; bench?: LineupPlayerLike[] };
}

const MAX_MINUTE = 130;

export class MatchEngine {
  private readonly meta: MatchMeta;
  private readonly playerInfo = new Map<string, { name: string; shirt: number; team: TeamSide; role: string }>();
  private readonly teamStats: Record<TeamSide, TeamMatchStats> = { home: emptyTeamStats('home'), away: emptyTeamStats('away') };
  private readonly playerStats = new Map<string, PlayerMatchStats>();
  private readonly buckets: Record<TeamSide, MinuteBucket[]> = { home: [], away: [] };
  private readonly candidatesList: InsightCandidate[] = [];
  private readonly momentumTracker = new MomentumTracker();
  private readonly momentumSeries: Array<{ minute: number; value: number }> = [];

  private readonly onSince = new Map<string, number>();
  private readonly minutesPlayed = new Map<string, number>();
  private readonly lastFrame = new Map<string, { t: number; x: number; y: number; speedKph: number }>();

  private clockSeconds = 0;
  private period: 1 | 2 = 1;
  private score: Record<TeamSide, number> = { home: 0, away: 0 };
  /** Cumulative score over time; VAR overturns remove their entry. */
  private readonly scoreTimeline: Array<{ t: number; home: number; away: number; eventId: string | null }> = [
    { t: 0, home: 0, away: 0, eventId: null },
  ];
  private possessionTeam: TeamSide = 'home';
  private lastEvent: MatchEvent | null = null;
  private lastMinute = -1;
  private candidateSeq = 0;
  private eventSeq = 0;

  private lastPassBy: Record<TeamSide, { passerId: string; recipientId: string | null; t: number } | null> = { home: null, away: null };
  private lastGoalCandidate: InsightCandidate | null = null;
  private lastMomentumShiftT = -Infinity;
  private lastSiegeT = -Infinity;
  private speedFlashCount = 0;
  private lastSpeedFlashT = -Infinity;
  private passDifficultySum: Record<TeamSide, number> = { home: 0, away: 0 };
  private passDifficultyCount: Record<TeamSide, number> = { home: 0, away: 0 };

  constructor(meta: MatchMeta, lineups: LineupsLike) {
    this.meta = meta;
    for (const side of ['home', 'away'] as const) {
      const all = [...lineups[side].starters, ...(lineups[side].bench ?? [])];
      for (const p of all) {
        this.playerInfo.set(p.id, { name: p.name, shirt: p.shirt, team: side, role: p.role });
        this.playerStats.set(p.id, this.newPlayerStats(p.id, side, p.name, p.shirt, p.role));
      }
      for (const p of lineups[side].starters) {
        this.onSince.set(p.id, 0);
      }
      this.buckets[side] = Array.from({ length: MAX_MINUTE }, emptyBucket);
    }
  }

  private newPlayerStats(playerId: string, team: TeamSide, name: string, shirt: number, role: string): PlayerMatchStats {
    return {
      playerId,
      name,
      shirt,
      team,
      role,
      goals: 0,
      assists: 0,
      shots: 0,
      xg: 0,
      passes: 0,
      passesCompleted: 0,
      keyPasses: 0,
      progressivePasses: 0,
      xtGenerated: 0,
      carries: 0,
      tackles: 0,
      interceptions: 0,
      foulsCommitted: 0,
      yellowCards: 0,
      redCards: 0,
      touches: 0,
      distanceKm: 0,
      topSpeedKph: 0,
      sprints: 0,
      duelsWon: 0,
    };
  }

  /* ------------------------------ ingest ------------------------------ */

  ingestEvent(e: MatchEvent): InsightCandidate[] {
    const emitted: InsightCandidate[] = [];
    this.eventSeq++;
    const previousPossession = this.possessionTeam;

    // Possession clock: attribute the gap since the last event to the team
    // that had the ball (capped so celebrations don't inflate the total).
    if (this.lastEvent) {
      const gap = clamp(e.t - this.lastEvent.t, 0, 60);
      const bucket = this.bucketFor(previousPossession, e.t);
      bucket.possessionSec += gap;
      this.teamStats[previousPossession].possessionSeconds += gap;
    }

    // Minute boundary: finalize rhythm/momentum for the minute we just left.
    const minute = Math.floor(e.t / 60);
    while (this.lastMinute < minute - 1) {
      this.lastMinute++;
      if (this.lastMinute >= 0) emitted.push(...this.finalizeMinute(this.lastMinute));
    }

    switch (e.type) {
      case 'kickoff':
      case 'possession_change': {
        if (e.team !== 'none') this.possessionTeam = e.team as TeamSide;
        break;
      }
      case 'pass': {
        const pass = e as MatchEvent & {
          outcome: string;
          recipientId: string | null;
          lengthM: number;
          difficulty: number;
          xtSwing: number;
          progressive: boolean;
          height: string;
        };
        const team = pass.team as TeamSide;
        const stats = this.teamStats[team];
        const bucket = this.bucketFor(team, pass.t);
        stats.passes++;
        bucket.passes++;
        this.passDifficultySum[team] += pass.difficulty;
        this.passDifficultyCount[team]++;
        stats.passDifficultyAvg = this.passDifficultySum[team] / Math.max(1, this.passDifficultyCount[team]);
        bucket.passSpeedSum += clamp(28 + pass.lengthM * 1.15, 30, 85);
        bucket.passSpeedCount++;
        const player = pass.playerId ? this.playerStats.get(pass.playerId) : undefined;
        if (player) {
          player.passes++;
          player.touches++;
        }
        if (pass.outcome === 'complete') {
          stats.passesCompleted++;
          bucket.completed++;
          if (pass.progressive) stats.progressivePasses++;
          if (pass.xtSwing > 0) {
            stats.xtGenerated += pass.xtSwing;
            bucket.xt += pass.xtSwing;
            if (player) player.xtGenerated += pass.xtSwing;
          }
          if (pass.progressive && player) player.progressivePasses++;
          if (player && pass.recipientId) {
            this.lastPassBy[team] = { passerId: player.playerId, recipientId: pass.recipientId, t: pass.t };
            const receiver = this.playerStats.get(pass.recipientId);
            if (receiver) receiver.touches++;
          }
        } else {
          stats.turnovers++;
          bucket.turnovers++;
        }
        this.possessionTeam = team;
        break;
      }
      case 'carry': {
        const carry = e as MatchEvent & { xtSwing: number };
        const team = carry.team as TeamSide;
        const stats = this.teamStats[team];
        stats.carries++;
        if (carry.xtSwing > 0) {
          stats.xtGenerated += carry.xtSwing;
          this.bucketFor(team, carry.t).xt += carry.xtSwing;
        }
        const player = carry.playerId ? this.playerStats.get(carry.playerId) : undefined;
        if (player) {
          player.carries++;
          player.touches++;
          player.xtGenerated += Math.max(0, carry.xtSwing);
        }
        this.possessionTeam = team;
        break;
      }
      case 'shot': {
        const shot = e as MatchEvent & {
          outcome: string;
          xg: number;
          distanceM: number;
          ballSpeedKph: number;
          bigChance: boolean;
          isPenalty: boolean;
        };
        const team = shot.team as TeamSide;
        const stats = this.teamStats[team];
        const bucket = this.bucketFor(team, shot.t);
        const player = shot.playerId ? this.playerStats.get(shot.playerId) : undefined;
        stats.shots++;
        stats.xg += shot.xg;
        bucket.shots++;
        bucket.xg += shot.xg;
        if (shot.outcome === 'goal' || shot.outcome === 'saved') stats.shotsOnTarget++;
        if (shot.bigChance) stats.bigChances++;
        if (player) {
          player.shots++;
          player.xg += shot.xg;
        }
        // Key pass / assist attribution.
        const last = this.lastPassBy[team];
        if (last && last.recipientId === shot.playerId && shot.t - last.t <= 10) {
          const passer = this.playerStats.get(last.passerId);
          if (passer) {
            passer.keyPasses++;
            if (shot.outcome === 'goal') passer.assists++;
          }
        }
        if (isInAttackingBox(shot.at, team === 'home' ? 1 : -1)) stats.touchesInBox += 1;
        if (shot.outcome === 'goal') {
          const prevDeficit = this.score[flip(team)] - this.score[team];
          this.score[team] += 1;
          stats.goals++;
          if (player) player.goals++;
          const candidate = this.pushCandidate({
            t: shot.t,
            kind: 'goal',
            salience: 1,
            team,
            playerId: shot.playerId,
            facts: {
              score: `${this.meta.home.abbr} ${this.score.home}–${this.score.away} ${this.meta.away.abbr}`,
              xg: roundTo(shot.xg, 2),
              distanceM: shot.distanceM,
              ballSpeedKph: shot.ballSpeedKph,
              isPenalty: shot.isPenalty,
            },
            evidenceEventIds: [shot.id],
            provisional: false,
          });
          this.lastGoalCandidate = candidate;
          emitted.push(candidate);
          this.scoreTimeline.push({ t: shot.t, home: this.score.home, away: this.score.away, eventId: shot.id });
          if (player && (player.goals === 2 || player.goals === 3)) {
            emitted.push(
              this.pushCandidate({
                t: shot.t,
                kind: 'milestone',
                salience: player.goals >= 3 ? 0.9 : 0.7,
                team,
                playerId: shot.playerId,
                facts: { milestone: player.goals >= 3 ? 'hat-trick' : 'brace', goals: player.goals },
                evidenceEventIds: [shot.id],
              }),
            );
          }
          if (prevDeficit >= 2) {
            emitted.push(
              this.pushCandidate({
                t: shot.t,
                kind: 'comeback_trigger',
                salience: 0.85,
                team,
                playerId: shot.playerId,
                facts: { deficitBefore: prevDeficit, scoreNow: `${this.score.home}–${this.score.away}` },
                evidenceEventIds: [shot.id],
              }),
            );
          }
          if (shot.t >= 84 * 60 && Math.abs(this.score.home - this.score.away) <= 1) {
            emitted.push(
              this.pushCandidate({
                t: shot.t,
                kind: 'late_drama',
                salience: 0.9,
                team,
                playerId: shot.playerId,
                facts: { minute: formatMinute(shot.t), score: `${this.score.home}–${this.score.away}` },
                evidenceEventIds: [shot.id],
              }),
            );
          }
        } else if (shot.bigChance || shot.xg >= 0.2) {
          emitted.push(
            this.pushCandidate({
              t: shot.t,
              kind: 'big_chance',
              salience: clamp(0.4 + shot.xg, 0, 0.85),
              team,
              playerId: shot.playerId,
              facts: { xg: roundTo(shot.xg, 2), outcome: shot.outcome, distanceM: shot.distanceM },
              evidenceEventIds: [shot.id],
            }),
          );
        }
        break;
      }
      case 'save': {
        const save = e as MatchEvent & { shooterId: string; xg: number; difficulty: number };
        if (save.difficulty >= 0.4) {
          const team = save.team as TeamSide;
          emitted.push(
            this.pushCandidate({
              t: save.t,
              kind: 'big_save',
              salience: clamp(0.45 + save.difficulty * 0.5, 0, 0.95),
              team,
              playerId: save.playerId,
              facts: { difficulty: roundTo(save.difficulty, 2), xg: roundTo(save.xg, 2), shooterId: save.shooterId },
              evidenceEventIds: [save.id],
            }),
          );
        }
        this.possessionTeam = flip(save.team as TeamSide);
        break;
      }
      case 'interception': {
        const team = e.team as TeamSide;
        this.teamStats[team].interceptions++;
        this.teamStats[team].defensiveActions++;
        this.bucketFor(team, e.t).duels++;
        const player = e.playerId ? this.playerStats.get(e.playerId) : undefined;
        if (player) player.interceptions++;
        this.possessionTeam = team;
        break;
      }
      case 'tackle': {
        const tackle = e as MatchEvent & { tackleOutcome: string; opponentId: string };
        const team = tackle.team as TeamSide;
        this.teamStats[team].tackles++;
        this.teamStats[team].defensiveActions++;
        this.bucketFor(team, tackle.t).duels++;
        const player = tackle.playerId ? this.playerStats.get(tackle.playerId) : undefined;
        if (player) {
          player.tackles++;
          if (tackle.tackleOutcome === 'won') player.duelsWon++;
        }
        if (tackle.tackleOutcome === 'won') {
          this.possessionTeam = team;
          const attacker = this.playerStats.get(tackle.opponentId);
          void attacker;
        }
        break;
      }
      case 'foul': {
        const team = e.team as TeamSide;
        this.teamStats[team].fouls++;
        this.teamStats[team].defensiveActions++;
        this.playerFoul(e.playerId);
        this.bucketFor(team, e.t).duels++;
        break;
      }
      case 'yellow_card': {
        const team = e.team as TeamSide;
        this.teamStats[team].yellowCards++;
        const player = e.playerId ? this.playerStats.get(e.playerId) : undefined;
        if (player) player.yellowCards++;
        break;
      }
      case 'red_card': {
        const team = e.team as TeamSide;
        this.teamStats[team].redCards++;
        const player = e.playerId ? this.playerStats.get(e.playerId) : undefined;
        if (player) player.redCards++;
        if (e.playerId) this.exitPitch(e.playerId, e.t);
        emitted.push(
          this.pushCandidate({
            t: e.t,
            kind: 'red_card',
            salience: 0.95,
            team,
            playerId: e.playerId,
            facts: {
              player: e.playerId ? this.playerInfo.get(e.playerId)?.name ?? e.playerId : 'unknown',
              reason: (e as MatchEvent & { reason?: string }).reason ?? 'unspecified',
            },
            evidenceEventIds: [e.id],
          }),
        );
        break;
      }
      case 'penalty': {
        const team = e.team as TeamSide;
        emitted.push(
          this.pushCandidate({
            t: e.t,
            kind: 'penalty',
            salience: 0.8,
            team,
            playerId: null,
            facts: { minute: formatMinute(e.t) },
            evidenceEventIds: [e.id],
          }),
        );
        break;
      }
      case 'corner': {
        this.teamStats[e.team as TeamSide].corners++;
        break;
      }
      case 'var_check': {
        const detail = (e as MatchEvent & { detail: string }).detail;
        if (detail.includes('under review')) {
          emitted.push(
            this.pushCandidate({
              t: e.t,
              kind: 'var_review',
              salience: 0.6,
              team: 'none',
              playerId: null,
              facts: { detail },
              evidenceEventIds: [e.id],
              provisional: true,
            }),
          );
        } else if (detail.includes('Overturned')) {
          // Retract the provisional goal: score comes back off the board.
          if (this.lastGoalCandidate) {
            this.lastGoalCandidate.overturned = true;
            this.lastGoalCandidate.provisional = false;
            const team = this.lastGoalCandidate.team as TeamSide;
            this.score[team] = Math.max(0, this.score[team] - 1);
            this.teamStats[team].goals = Math.max(0, this.teamStats[team].goals - 1);
            this.teamStats[team].goalsDisallowed++;
            const scorer = this.lastGoalCandidate.playerId ? this.playerStats.get(this.lastGoalCandidate.playerId) : undefined;
            if (scorer) scorer.goals = Math.max(0, scorer.goals - 1);
            this.removeFromTimeline(this.lastGoalCandidate.evidenceEventIds[0] ?? null);
          }
          emitted.push(
            this.pushCandidate({
              t: e.t,
              kind: 'var_overturn',
              salience: 0.95,
              team: 'none',
              playerId: null,
              facts: { detail },
              evidenceEventIds: [e.id],
            }),
          );
        } else {
          // Review resolved without a change.
          if (this.lastGoalCandidate) this.lastGoalCandidate.provisional = false;
        }
        break;
      }
      case 'substitution': {
        const sub = e as MatchEvent & { playerOffId: string; playerOnId: string };
        this.exitPitch(sub.playerOffId, sub.t);
        this.onSince.set(sub.playerOnId, sub.t);
        this.ensurePlayerStats(sub.playerOnId);
        break;
      }
      default:
        break;
    }

    // Track possession-time from action events too.
    this.lastEvent = e;
    this.clockSeconds = Math.max(this.clockSeconds, e.t);
    this.period = e.period;
    return emitted;
  }

  ingestFrame(frame: TrackingFrame): InsightCandidate[] {
    const emitted: InsightCandidate[] = [];
    for (const p of frame.players) {
      const prev = this.lastFrame.get(p.playerId);
      const stats = this.ensurePlayerStats(p.playerId);
      if (!stats) continue;
      if (prev && frame.t - prev.t > 0 && frame.t - prev.t <= 0.5) {
        const step = distance(prev.x, prev.y, p.pos.x, p.pos.y);
        stats.distanceKm += step / 1000;
        this.teamStats[stats.team].distanceCoveredKm += step / 1000;
        if (p.speedKph > stats.topSpeedKph) stats.topSpeedKph = p.speedKph;
        const teamStats = this.teamStats[stats.team];
        if (p.speedKph > teamStats.topSpeedKph) teamStats.topSpeedKph = p.speedKph;
        if (p.speedKph >= SPRINT_THRESHOLD_KPH && (prev.speedKph ?? 0) < SPRINT_THRESHOLD_KPH) {
          stats.sprints++;
          teamStats.sprints++;
        }
      }
      this.lastFrame.set(p.playerId, { t: frame.t, x: p.pos.x, y: p.pos.y, speedKph: p.speedKph });

      // Speed flash: a new match-best sprint enters the highlight window.
      // Not before two minutes in — no broadcast flashes a "fastest" graphic
      // before the match has a shape to compare against.
      if (
        p.speedKph >= 32.2 &&
        frame.t >= 120 &&
        frame.t - this.lastSpeedFlashT >= 180 &&
        this.speedFlashCount < 3 &&
        stats.topSpeedKph === p.speedKph
      ) {
        this.speedFlashCount++;
        this.lastSpeedFlashT = frame.t;
        emitted.push(
          this.pushCandidate({
            t: frame.t,
            kind: 'speed_flash',
            salience: 0.35,
            team: stats.team,
            playerId: p.playerId,
            facts: { speedKph: roundTo(p.speedKph, 1), player: stats.name },
            evidenceEventIds: [],
            window: { t0: frame.t - 5, t1: frame.t },
          }),
        );
      }
    }
    this.clockSeconds = Math.max(this.clockSeconds, frame.t);
    return emitted;
  }

  /* --------------------------- computations --------------------------- */

  private bucketFor(team: TeamSide, t: number): MinuteBucket {
    const idx = clamp(Math.floor(t / 60), 0, MAX_MINUTE - 1);
    return this.buckets[team][idx]!;
  }

  private playerFoul(playerId: string | null): void {
    if (!playerId) return;
    const player = this.playerStats.get(playerId);
    if (player) player.foulsCommitted++;
  }

  private exitPitch(playerId: string, t: number): void {
    const since = this.onSince.get(playerId);
    if (since !== undefined) {
      this.minutesPlayed.set(playerId, (this.minutesPlayed.get(playerId) ?? 0) + (t - since) / 60);
      this.onSince.delete(playerId);
    }
    this.lastFrame.delete(playerId);
  }

  private ensurePlayerStats(playerId: string): PlayerMatchStats | undefined {
    const existing = this.playerStats.get(playerId);
    if (existing) return existing;
    return undefined;
  }

  /** Momentum/threat evaluated when a minute completes. */
  private finalizeMinute(minute: number): InsightCandidate[] {
    const emitted: InsightCandidate[] = [];
    const home = this.buckets.home[minute] ?? emptyBucket();
    const away = this.buckets.away[minute] ?? emptyBucket();
    const homeThreat = home.xt + home.xg * 2.4 + home.shots * 0.04;
    const awayThreat = away.xt + away.xg * 2.4 + away.shots * 0.04;
    const value = this.momentumTracker.update(homeThreat, awayThreat);
    this.momentumSeries.push({ minute, value: roundTo(value, 3) });

    // Momentum shift: a sustained swing of at least 0.45 over ~5 minutes.
    if (minute >= 6 && this.momentumSeries.length >= 6) {
      const now = this.momentumSeries[this.momentumSeries.length - 1]!;
      const before = this.momentumSeries[this.momentumSeries.length - 6]!;
      const swing = now.value - before.value;
      if (Math.abs(swing) >= 0.45 && Math.abs(now.value) > 0.28 && minute * 60 - this.lastMomentumShiftT > 480) {
        this.lastMomentumShiftT = minute * 60;
        const side: TeamSide = swing > 0 ? 'home' : 'away';
        emitted.push(
          this.pushCandidate({
            t: minute * 60,
            kind: 'momentum_shift',
            salience: clamp(0.45 + Math.abs(swing) * 0.5, 0, 0.9),
            team: side,
            playerId: null,
            facts: {
              direction: side,
              swing: roundTo(swing, 2),
              overMinutes: 5,
              momentumNow: now.value,
            },
            evidenceEventIds: [],
            window: { t0: (minute - 5) * 60, t1: minute * 60 },
          }),
        );
      }
    }

    // Siege: one side camped in the final third.
    if (minute >= 12 && minute * 60 - this.lastSiegeT > 900) {
      const lastTwelve = (side: TeamSide) => this.sumRange(side, minute - 11, minute);
      const h = lastTwelve('home');
      const a = lastTwelve('away');
      const homeSiege = h.shots >= 5 && a.shots <= 2 && h.possessionSec > a.possessionSec * 1.4;
      const awaySiege = a.shots >= 5 && h.shots <= 2 && a.possessionSec > h.possessionSec * 1.4;
      if (homeSiege || awaySiege) {
        const side: TeamSide = homeSiege ? 'home' : 'away';
        this.lastSiegeT = minute * 60;
        emitted.push(
          this.pushCandidate({
            t: minute * 60,
            kind: 'siege',
            salience: 0.65,
            team: side,
            playerId: null,
            facts: {
              shotsLast10: side === 'home' ? h.shots : a.shots,
              opponentShotsLast10: side === 'home' ? a.shots : h.shots,
              possessionShare: roundTo((side === 'home' ? h.possessionSec : a.possessionSec) / Math.max(1, h.possessionSec + a.possessionSec), 2),
            },
            evidenceEventIds: [],
            window: { t0: (minute - 9) * 60, t1: minute * 60 },
          }),
        );
      }
    }
    return emitted;
  }

  private sumRange(side: TeamSide, fromMinute: number, toMinute: number): MinuteBucket {
    const result = emptyBucket();
    for (let m = Math.max(0, fromMinute); m <= Math.min(MAX_MINUTE - 1, toMinute); m++) {
      const b = this.buckets[side][m]!;
      result.passes += b.passes;
      result.completed += b.completed;
      result.shots += b.shots;
      result.xg += b.xg;
      result.xt += b.xt;
      result.turnovers += b.turnovers;
      result.duels += b.duels;
      result.defActionsHigh += b.defActionsHigh;
      result.possessionSec += b.possessionSec;
      result.passSpeedSum += b.passSpeedSum;
      result.passSpeedCount += b.passSpeedCount;
    }
    return result;
  }

  /** Aggregate features over a match-time window — the evidence pack basis. */
  windowFeatures(t0: number, t1: number): WindowFeatures {
    const fromMinute = Math.max(0, Math.floor(t0 / 60));
    const toMinute = Math.min(MAX_MINUTE - 1, Math.floor(t1 / 60));
    const h = this.sumRange('home', fromMinute, toMinute);
    const a = this.sumRange('away', fromMinute, toMinute);
    const minutes = Math.max(1, toMinute - fromMinute + 1);
    const totalPasses = h.passes + a.passes;
    const totalCompleted = h.completed + a.completed;
    const totalPossession = h.possessionSec + a.possessionSec;
    const passSpeedSum = h.passSpeedSum + a.passSpeedSum;
    const passSpeedCount = h.passSpeedCount + a.passSpeedCount;
    return {
      minutes,
      possessionHome: totalPossession > 0 ? h.possessionSec / totalPossession : 0.5,
      completion: totalPasses > 0 ? totalCompleted / totalPasses : 0.8,
      turnoversPerMinute: (h.turnovers + a.turnovers) / minutes,
      duelsPerMinute: (h.duels + a.duels) / minutes,
      passSpeedAvgKph: passSpeedCount > 0 ? passSpeedSum / passSpeedCount : 40,
      shots: h.shots + a.shots,
      xtBalance: h.xt - a.xt,
      highPressPerMinute: (h.defActionsHigh + a.defActionsHigh) / minutes,
    };
  }

  snapshot(): MatchState {
    const windowStart = Math.max(0, this.clockSeconds - 5 * 60);
    const features = this.windowFeatures(windowStart, this.clockSeconds);
    const totalPossession = this.teamStats.home.possessionSeconds + this.teamStats.away.possessionSeconds;
    for (const side of ['home', 'away'] as const) {
      const s = this.teamStats[side];
      s.passAccuracy = s.passes > 0 ? s.passesCompleted / s.passes : 0;
      s.possessionShare = totalPossession > 0 ? s.possessionSeconds / totalPossession : 0.5;
      const opp = flip(side);
      s.ppda = s.defensiveActions > 0 ? this.teamStats[opp].passes / s.defensiveActions : this.teamStats[opp].passes;
    }
    return {
      meta: this.meta,
      clockSeconds: this.clockSeconds,
      period: this.period,
      score: { home: this.score.home, away: this.score.away },
      possession: { home: roundTo(this.teamStats.home.possessionShare, 3), away: roundTo(this.teamStats.away.possessionShare, 3) },
      teams: { home: { ...this.teamStats.home }, away: { ...this.teamStats.away } },
      players: [...this.playerStats.values()].map((p) => ({
        ...p,
        distanceKm: roundTo(p.distanceKm, 2),
        topSpeedKph: roundTo(p.topSpeedKph, 1),
      })),
      controlChaos: readControlChaos(features),
      rhythm: readRhythm(features),
      tempo: {
        actionsPerMinute: this.clockSeconds > 0 ? roundTo((this.eventSeq / this.clockSeconds) * 60, 1) : 0,
        passSpeedAvgKph: features.passSpeedAvgKph,
      },
      momentum: { value: this.momentumTracker.current(), series: [...this.momentumSeries] },
    };
  }

  candidates(): InsightCandidate[] {
    return this.candidatesList;
  }

  /** The scoreboard as it stood at match time t (VAR overturns applied). */
  scoreAt(t: number): { home: number; away: number } {
    let home = 0;
    let away = 0;
    for (const point of this.scoreTimeline) {
      if (point.t > t) break;
      home = point.home;
      away = point.away;
    }
    return { home, away };
  }

  private removeFromTimeline(eventId: string | null): void {
    const idx = eventId ? this.scoreTimeline.findIndex((p) => p.eventId === eventId) : -1;
    if (idx <= 0) return;
    const removed = this.scoreTimeline[idx]!;
    const prev = this.scoreTimeline[idx - 1]!;
    const dHome = removed.home - prev.home;
    const dAway = removed.away - prev.away;
    this.scoreTimeline.splice(idx, 1);
    for (let i = idx; i < this.scoreTimeline.length; i++) {
      const point = this.scoreTimeline[i]!;
      this.scoreTimeline[i] = { ...point, home: point.home - dHome, away: point.away - dAway };
    }
  }

  private pushCandidate(partial: Omit<InsightCandidate, 'id' | 'minuteLabel' | 'provisional' | 'overturned' | 'window'> & {
    provisional?: boolean;
    window?: { t0: number; t1: number } | null;
  }): InsightCandidate {
    this.candidateSeq++;
    const candidate: InsightCandidate = {
      id: `cand-${String(this.candidateSeq).padStart(4, '0')}`,
      t: partial.t,
      minuteLabel: formatMinute(partial.t),
      kind: partial.kind,
      salience: roundTo(partial.salience, 3),
      team: partial.team,
      playerId: partial.playerId,
      facts: partial.facts,
      evidenceEventIds: partial.evidenceEventIds,
      window: partial.window ?? null,
      provisional: partial.provisional ?? false,
      overturned: false,
    };
    this.candidatesList.push(candidate);
    return candidate;
  }
}

function flip(team: TeamSide): TeamSide {
  return team === 'home' ? 'away' : 'home';
}

export type { WindowFeatures };
