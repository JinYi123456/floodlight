/**
 * Auto-eventing — turn pixel tracks into football events.
 *
 * The deriver watches the ball and who owns it: an ownership change between
 * team-mates is a pass, between opponents a turnover; an unowned fast ball
 * heading into the goal mouth is a shot. Everything is derived from the
 * tracked positions and speeds alone — the ground truth is only used
 * afterwards, to score the job.
 */

import type { SimulationResult } from '@floodlight/simulator';
import { trackingWindow } from '@floodlight/simulator';
import { homeIdSet, renderPixels } from './raster';
import type { Projection } from './raster';
import { projection } from './raster';
import { detectEntities, learnPalettes, type KitPalettes } from './detect';
import { TrackingLayer, type Track } from './track';

export interface DerivedEvent {
  t: number;
  type: 'pass' | 'shot' | 'possession_change';
  team: 'home' | 'away';
  from: { x: number; y: number };
  to: { x: number; y: number };
  speedKph: number;
}

export interface FrameSample {
  t: number;
  truth: { passes: number; shots: number };
  detected: { passes: number; shots: number };
  ballSpeedTruth: number;
  ballSpeedDetected: number;
}

export interface VisionReport {
  window: { t0: number; t1: number };
  framesProcessed: number;
  groundTruth: { passes: number; shots: number };
  detected: { passes: number; shots: number };
  passPrecision: number;
  passRecall: number;
  passF1: number;
  ballSpeedMaeKph: number;
  playerSpeedMaeKph: number;
  possessionAgreement: number;
  /** How kit classes map onto home/away for the possession score. */
  paletteMapping: 'direct' | 'swapped';
  samples: FrameSample[];
}

const OWNER_RADIUS = 1.8;
const OWNER_LOST_RADIUS = 2.4;
const DWELL_FRAMES = 2;

interface OwnerState {
  trackId: number | null;
  team: 'home' | 'away' | null;
  since: number;
  lastPos: { x: number; y: number } | null;
  lastSeen: number;
}

interface FlightState {
  startT: number;
  startPos: { x: number; y: number };
  team: 'home' | 'away' | null;
  maxSpeedKph: number;
  speeds: number[];
  lastPos: { x: number; y: number };
  /** Last position while the ball was genuinely travelling (≥25 km/h). */
  lastFastPos: { x: number; y: number };
  slowStreak: number;
}

const SHOT_SPEED_KPH = 58;
const GOAL_ZONE_X = 42;
const GOAL_ZONE_Y = 18;

export class EventDeriver {
  private owner: OwnerState = { trackId: null, team: null, since: 0, lastPos: null, lastSeen: -Infinity };
  /** The last established owner; survives the ball going loose, so the
   *  next establishment can emit a pass across the flight gap. */
  private lastOwner: OwnerState | null = null;
  private candidateId: number | null = null;
  private candidateSince = 0;
  private flight: FlightState | null = null;
  /** The most recently ended flight, still usable for the establishment
   *  that follows it (dwell arrives ~0.2 s after the ball has settled). */
  private lastFlight: FlightState | null = null;
  private lastFlightEndT = -Infinity;
  private events: DerivedEvent[] = [];

  update(t: number, ball: Track | null, players: Track[]): DerivedEvent[] {
    const emitted: DerivedEvent[] = [];
    if (!ball) return emitted;

    // Nearest player to the ball.
    let nearest: Track | null = null;
    let nearestD = Infinity;
    for (const player of players) {
      const d = Math.hypot(player.x - ball.x, player.y - ball.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = player;
      }
    }

    const ownerCandidate = nearest && nearestD <= OWNER_RADIUS ? nearest : null;
    if (ownerCandidate) {
      if (this.candidateId === ownerCandidate.id) {
        if (t - this.candidateSince >= DWELL_FRAMES * 0.1 - 1e-6) {
          this.establishOwner(ownerCandidate, t, ball, emitted);
        }
      } else {
        this.candidateId = ownerCandidate.id;
        this.candidateSince = t;
      }
    } else {
      this.candidateId = null;
      if (nearestD > OWNER_LOST_RADIUS && this.owner.trackId !== null) {
        // The ball is loose — remember where the owner last had it.
        this.lastOwner = { ...this.owner };
        this.owner = { trackId: null, team: null, since: 0, lastPos: null, lastSeen: -Infinity };
      }
    }

    // Ball flight bookkeeping.
    if (this.owner.trackId === null) {
      if (!this.flight) {
        this.lastFlight = null;
        this.flight = {
          startT: t,
          startPos: { x: ball.x, y: ball.y },
          team: this.lastOwner && t - this.lastOwner.lastSeen <= 3 ? this.lastOwner.team : null,
          maxSpeedKph: ball.speedKph,
          speeds: [ball.speedKph],
          lastPos: { x: ball.x, y: ball.y },
          lastFastPos: { x: ball.x, y: ball.y },
          slowStreak: 0,
        };
      } else {
        this.flight.maxSpeedKph = Math.max(this.flight.maxSpeedKph, ball.speedKph);
        this.flight.speeds.push(ball.speedKph);
        this.flight.lastPos = { x: ball.x, y: ball.y };
        if (ball.speedKph >= 25) this.flight.lastFastPos = { x: ball.x, y: ball.y };
      }
      if (ball.speedKph < 12) this.flight.slowStreak++;
      else this.flight.slowStreak = 0;

      // A flight that came to rest: score it as a shot if it died in the
      // goal zone (goal, off target, or into the net).
      if (this.flight.slowStreak >= 3) {
        const shot = this.evaluateShot(this.flight, this.flight.lastFastPos, null);
        if (shot) {
          emitted.push(shot);
          this.events.push(shot);
        }
        this.lastFlight = this.flight;
        this.lastFlightEndT = t;
        this.flight = null;
      }
    } else {
      if (this.flight) {
        this.lastFlight = this.flight;
        this.lastFlightEndT = t;
      }
      this.flight = null;
    }

    return emitted;
  }

  private establishOwner(track: Track, t: number, ball: Track, emitted: DerivedEvent[]): void {
    // The relevant flight: the live one, or one that just settled while the
    // ownership dwell was still counting.
    const flight = this.flight ?? (this.lastFlight && t - this.lastFlightEndT <= 0.8 ? this.lastFlight : null);

    // The owner we are transitioning from: the live owner, or the last one
    // remembered when the ball went loose.
    const previous = this.owner.trackId !== null ? this.owner : this.lastOwner;
    const sameTrack = Boolean(previous && previous.trackId === track.id);

    // A flight that ends at a player inside the goal zone at shot speed is
    // a shot (saved or gathered by the keeper) — not a pass.
    let shotEmitted = false;
    if (flight && !sameTrack) {
      const shot = this.evaluateShot(flight, { x: track.x, y: track.y }, track.cls);
      if (shot) {
        emitted.push(shot);
        this.events.push(shot);
        shotEmitted = true;
      }
    }

    if (!shotEmitted && previous && previous.team && previous.lastPos && t - previous.lastSeen <= 3.0) {
      const travel = Math.hypot(track.x - previous.lastPos.x, track.y - previous.lastPos.y);
      const flightSpeeds = flight?.speeds ?? [];
      const speed =
        flightSpeeds.length > 0
          ? flightSpeeds.reduce((sum, s) => sum + s, 0) / flightSpeeds.length
          : ball.speedKph;
      const maxSpeed = flight?.maxSpeedKph ?? ball.speedKph;
      // When trackers merge the passer and receiver into one identity (the
      // pass arrives where the receiver stood and possession never visibly
      // lapsed), hard flight evidence — a fast, sustained ball that itself
      // covered distance — is what justifies calling it a pass.
      const flightEvidence = flight !== null && flight.maxSpeedKph >= 30 && flight.speeds.length >= 3;
      const ballTravel = flight ? Math.hypot(flight.lastPos.x - flight.startPos.x, flight.lastPos.y - flight.startPos.y) : 0;
      const eligible = sameTrack ? flightEvidence && (travel >= 2.0 || ballTravel >= 2.0) : travel >= 2.0;
      // A pass needs the ball to actually travel at passing speed — slow
      // hand-overs (dribble jostles, restarts) are not passes.
      if (eligible && (speed >= 20 || maxSpeed >= 28)) {
        const event: DerivedEvent = {
          t: flight?.startT ?? t - 0.2,
          type: track.cls === previous.team ? 'pass' : 'possession_change',
          team: previous.team,
          from: { ...previous.lastPos },
          to: { x: track.x, y: track.y },
          speedKph: Math.round(speed * 10) / 10,
        };
        emitted.push(event);
        this.events.push(event);
      }
    }
    this.owner = {
      trackId: track.id,
      team: track.cls === 'home' || track.cls === 'away' ? track.cls : null,
      since: t,
      lastPos: { x: track.x, y: track.y },
      lastSeen: t,
    };
    this.lastOwner = this.owner;
    this.flight = null;
    this.lastFlight = null;
  }

  private evaluateShot(
    flight: FlightState,
    endPos: { x: number; y: number },
    endOwnerClass: 'ball' | 'home' | 'away' | null,
  ): DerivedEvent | null {
    const duration = flight.speeds.length * 0.1;
    if (duration < 0.35) return null;
    if (flight.maxSpeedKph < SHOT_SPEED_KPH) return null;
    const inGoalZone = Math.abs(endPos.x) >= GOAL_ZONE_X && Math.abs(endPos.y) <= GOAL_ZONE_Y;
    if (!inGoalZone) return null;
    // A fast ball collected by a team-mate is a pass, not a shot.
    if (endOwnerClass && flight.team && endOwnerClass === flight.team) return null;
    const towardHomeGoal = endPos.x < 0;
    return {
      t: flight.startT,
      type: 'shot',
      // Prefer the shooter's tracked class (the analyser normalises class
      // labels); fall back to geometry.
      team: flight.team ?? (towardHomeGoal ? 'away' : 'home'),
      from: { ...flight.startPos },
      to: { x: endPos.x, y: endPos.y },
      speedKph: Math.round(flight.maxSpeedKph * 10) / 10,
    };
  }

  /** Who the deriver currently believes is on the ball (team level). */
  ownerTeam(): 'home' | 'away' | null {
    return this.owner.team;
  }

  all(): DerivedEvent[] {
    return this.events;
  }
}

/** Per-frame team of whoever is nearest the ball (ground truth side). */
export function truthOwnerTeam(
  ball: { x: number; y: number },
  players: Array<{ x: number; y: number; team: 'home' | 'away' }>,
): 'home' | 'away' | null {
  let best: 'home' | 'away' | null = null;
  let bestD = 2.0;
  for (const player of players) {
    const d = Math.hypot(player.x - ball.x, player.y - ball.y);
    if (d < bestD) {
      bestD = d;
      best = player.team;
    }
  }
  return best;
}

export interface AnalyzeOptions {
  /** Analysis window in match seconds. */
  t0: number;
  t1: number;
  width?: number;
  height?: number;
  /** Frame rate of the feed. */
  hz?: number;
  /** Seconds of feed consumed before t0 to prime the tracker. */
  warmupS?: number;
}

export interface AnalyzeResult {
  events: DerivedEvent[];
  samples: FrameSample[];
  truth: {
    passes: number;
    shots: number;
  };
  frameCount: number;
  ballSpeedAbsError: number;
  ballSpeedSamples: number;
  playerSpeedAbsError: number;
  playerSpeedSamples: number;
  possessionFrames: number;
  possessionAgreementFrames: number;
  /** Frames where the detected home/away label matched truth as-is. */
  possessionDirect: number;
  /** Frames where it matched with home/away swapped (kit learning is label-blind). */
  possessionSwapped: number;
  /** The mapping that scored better over the window. */
  paletteMapping: 'direct' | 'swapped';
}

/**
 * Run the whole auto-eventing pass over a window of the match: render each
 * frame, detect, track and derive — then compare with the truth the
 * simulator recorded.
 */
export function analyzeWindow(result: SimulationResult, options: AnalyzeOptions): AnalyzeResult {
  const { t0, t1 } = options;
  const width = options.width ?? 320;
  const height = options.height ?? 208;
  const hz = options.hz ?? 10;
  const dt = 1 / hz;
  const proj: Projection = projection(width, height);

  // One continuous tracking pass for the whole window — players integrate
  // from the anchors and then genuinely chase the ball, exactly like a
  // long-form feed would. A warm-up stretch primes the tracker before the
  // analysis window begins.
  const warmup = options.warmupS ?? 25;
  const trackingFrames = trackingWindow(result, Math.max(0, t0 - warmup), t1 + dt, { hz });
  const colors = {
    homePrimary: result.meta.home.primary,
    awayPrimary: result.meta.away.primary,
    homeIds: homeIdSet(result),
  };

  const tracker = new TrackingLayer();
  const deriver = new EventDeriver();
  let palettes: KitPalettes | null = null;

  const events: DerivedEvent[] = [];
  const samples: FrameSample[] = [];
  let ballSpeedAbsError = 0;
  let ballSpeedSamples = 0;
  let playerSpeedAbsError = 0;
  let playerSpeedSamples = 0;
  let possessionFrames = 0;
  let possessionDirect = 0;
  let possessionSwapped = 0;
  let frameCount = 0;

  const truthEvents = result.events.filter((e) => e.t >= t0 && e.t <= t1);
  const truthPasses = truthEvents.filter((e) => e.type === 'pass');
  const truthShots = truthEvents.filter((e) => e.type === 'shot');
  let nextSampleT = t0;
  let prevBall: { x: number; y: number } | null = null;
  const trail: typeof trackingFrames = [];

  for (let index = 0; index < trackingFrames.length; index++) {
    const trackingFrame = trackingFrames[index]!;
    const t = trackingFrame.t;
    if (t > t1 + 1e-6) break;
    const inWindow = t >= t0 - 1e-6;
    if (inWindow) frameCount++;

    const frame = renderPixels(trackingFrame, trail.slice(-3), { width, height, ...colors });
    trail.push(trackingFrame);
    if (!palettes) palettes = learnPalettes(frame);

    const entities = detectEntities(frame, {
      projection: proj,
      palettes,
      ballHint: prevBall,
    });
    const ballEntity = entities.find((e) => e.cls === 'ball') ?? null;
    if (ballEntity) prevBall = { x: ballEntity.x, y: ballEntity.y };

    const tracks = tracker.update(entities, dt);
    const ballTrack = tracks.find((track) => track.cls === 'ball') ?? null;
    const playerTracks = tracks.filter((track) => track.cls !== 'ball');
    const emitted = deriver.update(t, ballTrack, playerTracks);
    events.push(...emitted);

    // Speed error bookkeeping (window frames only).
    if (inWindow && ballTrack) {
      ballSpeedAbsError += Math.abs(ballTrack.speedKph - frame.truth.ball.speedKph);
      ballSpeedSamples++;
    }
    if (inWindow && playerTracks.length > 0) {
      const used = new Set<number>();
      for (const player of frame.truth.players) {
        let bestTrack: Track | null = null;
        let bestD = 3.0;
        for (const track of playerTracks) {
          if (used.has(track.id)) continue;
          const d = Math.hypot(track.x - player.x, track.y - player.y);
          if (d < bestD) {
            bestD = d;
            bestTrack = track;
          }
        }
        if (bestTrack) {
          used.add(bestTrack.id);
          playerSpeedAbsError += Math.abs(bestTrack.speedKph - player.speedKph);
          playerSpeedSamples++;
        }
      }
    }

    // Possession agreement (team-level), scored under both possible
    // home/away label mappings — kit learning cannot know team identity.
    const truthTeam = truthOwnerTeam(frame.truth.ball, frame.truth.players);
    const detectedTeam = deriver.ownerTeam();
    if (inWindow) possessionFrames++;
    if (!truthTeam && !detectedTeam) {
      if (inWindow) {
        possessionDirect++;
        possessionSwapped++;
      }
    } else if (detectedTeam) {
      if (detectedTeam === truthTeam && inWindow) possessionDirect++;
      const swapped = detectedTeam === 'home' ? 'away' : 'home';
      if (swapped === truthTeam && inWindow) possessionSwapped++;
    }

    if (t + 1e-9 >= nextSampleT) {
      const passesSoFar = events.filter((e) => e.type === 'pass' && e.t <= t).length;
      const shotsSoFar = events.filter((e) => e.type === 'shot' && e.t <= t).length;
      const truthPassesSoFar = truthPasses.filter((e) => e.t <= t).length;
      const truthShotsSoFar = truthShots.filter((e) => e.t <= t).length;
      samples.push({
        t: Math.round(t),
        truth: { passes: truthPassesSoFar, shots: truthShotsSoFar },
        detected: { passes: passesSoFar, shots: shotsSoFar },
        ballSpeedTruth: Math.round(frame.truth.ball.speedKph * 10) / 10,
        ballSpeedDetected: Math.round((ballTrack?.speedKph ?? 0) * 10) / 10,
      });
      nextSampleT += 1;
    }
  }

  const paletteMapping: 'direct' | 'swapped' = possessionDirect >= possessionSwapped ? 'direct' : 'swapped';
  // Warm-up events are discarded — they primed the tracker, they are not
  // part of the analysed window.
  const windowEvents = events.filter((e) => e.t >= t0 - 1e-6);
  // Kit classes learn as two clusters with no team identity; normalise the
  // reported teams once the best mapping is known.
  if (paletteMapping === 'swapped') {
    for (const event of windowEvents) {
      event.team = event.team === 'home' ? 'away' : 'home';
    }
  }
  return {
    events: windowEvents,
    samples,
    truth: { passes: truthPasses.length, shots: truthShots.length },
    frameCount,
    ballSpeedAbsError,
    ballSpeedSamples,
    playerSpeedAbsError,
    playerSpeedSamples,
    possessionFrames,
    possessionAgreementFrames: Math.max(possessionDirect, possessionSwapped),
    possessionDirect,
    possessionSwapped,
    paletteMapping,
  };
}

/**
 * Score derived events against ground truth. Passes and shots match on time
 * (±0.7 s) and origin (±9 m), greedily, each truth event used once.
 */
export function buildReport(result: SimulationResult, analysis: AnalyzeResult, window: { t0: number; t1: number }): VisionReport {
  const truthPasses = result.events.filter(
    (e) => e.type === 'pass' && e.t >= window.t0 && e.t <= window.t1,
  );
  const truthShots = result.events.filter(
    (e) => e.type === 'shot' && e.t >= window.t0 && e.t <= window.t1,
  );
  const detectedPasses = analysis.events.filter((e) => e.type === 'pass');
  const detectedShots = analysis.events.filter((e) => e.type === 'shot');

  const matchCount = (
    truth: typeof truthPasses,
    detected: DerivedEvent[],
  ): number => {
    const usedDetected = new Set<number>();
    let matched = 0;
    for (const event of truth) {
      let bestIndex = -1;
      let bestScore = Infinity;
      detected.forEach((candidate, index) => {
        if (usedDetected.has(index)) return;
        const dt = Math.abs(candidate.t - event.t);
        if (dt > 0.7) return;
        const d = Math.hypot(candidate.from.x - event.at.x, candidate.from.y - event.at.y);
        if (d > 9) return;
        const score = dt + d * 0.05;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        usedDetected.add(bestIndex);
        matched++;
      }
    }
    return matched;
  };

  const matchedPasses = matchCount(truthPasses, detectedPasses);
  const matchedShots = matchCount(truthShots, detectedShots);
  const precision = detectedPasses.length > 0 ? matchedPasses / detectedPasses.length : 0;
  const recall = truthPasses.length > 0 ? matchedPasses / truthPasses.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    window,
    framesProcessed: analysis.frameCount,
    groundTruth: { passes: truthPasses.length, shots: truthShots.length },
    detected: { passes: detectedPasses.length, shots: detectedShots.length },
    passPrecision: round3(precision),
    passRecall: round3(recall),
    passF1: round3(f1),
    ballSpeedMaeKph: analysis.ballSpeedSamples > 0 ? round2(analysis.ballSpeedAbsError / analysis.ballSpeedSamples) : 0,
    playerSpeedMaeKph:
      analysis.playerSpeedSamples > 0 ? round2(analysis.playerSpeedAbsError / analysis.playerSpeedSamples) : 0,
    possessionAgreement:
      analysis.possessionFrames > 0 ? round3(analysis.possessionAgreementFrames / analysis.possessionFrames) : 0,
    paletteMapping: analysis.paletteMapping,
    samples: analysis.samples,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
