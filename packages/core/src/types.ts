/**
 * Floodlight domain model.
 *
 * Coordinate system: origin at the centre of the pitch.
 *   x ∈ [-52.5, +52.5] metres — home team attacks +x, away attacks −x.
 *   y ∈ [-34, +34] metres — touchlines at ±34.
 * All distances are metres, all speeds km/h, all times seconds since kickoff.
 */

export const PITCH = {
  length: 105,
  width: 68,
  halfLength: 52.5,
  halfWidth: 34,
  goalWidth: 7.32,
  penaltyAreaLength: 16.5,
  penaltyAreaWidth: 40.32,
  sixYardLength: 5.5,
  sixYardWidth: 18.32,
  centreCircleRadius: 9.15,
  cornerArcRadius: 1,
} as const;

/** Sprint threshold in km/h — an "official" marker used by player tags. */
export const SPRINT_THRESHOLD_KPH = 25.2;
/** High-speed running threshold used for distance breakdowns. */
export const HIGH_SPEED_RUNNING_KPH = 19.8;
/** Match structure: two halves of 45 minutes, generous stoppage allowed. */
export const HALF_SECONDS = 45 * 60;
export const FULL_TIME_SECONDS = 2 * HALF_SECONDS;

export interface Vec2 {
  x: number;
  y: number;
}

export type TeamSide = 'home' | 'away';
export type Role = 'GK' | 'DF' | 'MF' | 'FW';

export interface Club {
  id: string;
  name: string;
  abbr: string;
  /** Primary kit colour (shirt). */
  primary: string;
  /** Secondary colour (shorts/trim). */
  secondary: string;
  /** Colour for text on top of primary. */
  onPrimary: string;
}

export interface Player {
  id: string;
  name: string;
  shirt: number;
  team: TeamSide;
  role: Role;
  squadNumber: number;
  /** Declared starting slot index 0..10 in the formation. */
  slot: number;
}

export interface Venue {
  id: string;
  name: string;
  city: string;
  capacity: number;
}

export interface MatchMeta {
  id: string;
  seed: number;
  scenario: string | null;
  competition: string;
  venue: Venue;
  kickoffISO: string;
  home: Club;
  away: Club;
  homeManager: string;
  awayManager: string;
  referee: string;
}

export interface TeamTactics {
  /** 0..1 — how directly a team progresses (low = patient build-up). */
  directness: number;
  /** 0..1 — willingness to press high up the pitch. */
  pressing: number;
  /** 0..1 — attacking width preference. */
  width: number;
  /** 0..1 — defensive line height. */
  lineHeight: number;
  /** 0..1 — risk appetite in possession (through balls, ambitious passes). */
  risk: number;
  /** Preferred formation, e.g. '4-3-3'. */
  formation: string;
  baseTempo: number;
}

export interface MatchConfig {
  seed: number;
  scenario: string | null;
  home: Club;
  away: Club;
  venue: Venue;
  kickoffISO: string;
  tactics: { home: TeamTactics; away: TeamTactics };
  managers: { home: string; away: string };
  referee: string;
}

/* ------------------------------------------------------------------ */
/* Events — what actually happened on the pitch (simulator ground truth) */
/* ------------------------------------------------------------------ */

export type EventType =
  | 'kickoff'
  | 'half_time'
  | 'second_half'
  | 'full_time'
  | 'pass'
  | 'carry'
  | 'shot'
  | 'save'
  | 'block'
  | 'interception'
  | 'tackle'
  | 'clearance'
  | 'foul'
  | 'yellow_card'
  | 'red_card'
  | 'corner'
  | 'goal_kick'
  | 'throw_in'
  | 'offside'
  | 'substitution'
  | 'penalty'
  | 'var_check'
  | 'pressure_phase'
  | 'possession_change';

export type PassOutcome = 'complete' | 'incomplete' | 'out';
export type PassHeight = 'ground' | 'low' | 'high';
export type ShotOutcome = 'goal' | 'saved' | 'off_target' | 'blocked' | 'post';
export type TackleOutcome = 'won' | 'lost' | 'foul';
export type CardType = 'none' | 'yellow' | 'red';

export interface EventBase {
  id: string;
  /** 1-based sequence number in the match stream. */
  index: number;
  /** Match seconds since kickoff (period 1 starts at 0). */
  t: number;
  period: 1 | 2;
  type: EventType;
  team: TeamSide | 'none';
  playerId: string | null;
  /** Where the ball was when the event happened. */
  at: Vec2;
  /** Where the ball ended up (passes, carries, shots). */
  endAt: Vec2 | null;
}

export interface PassEvent extends EventBase {
  type: 'pass';
  recipientId: string | null;
  lengthM: number;
  angleDeg: number;
  height: PassHeight;
  outcome: PassOutcome;
  /** 0..1 — how hard the pass was (contextual). */
  difficulty: number;
  /** Expected-threat swing of this pass (receiving zone − passing zone). */
  xtSwing: number;
  progressive: boolean;
  /** Passes the ball past at least one opponent line (breakline). */
  lineBreak: boolean;
  /** Distance to nearest opponent at release, metres. */
  nearestOpponentM: number;
  pressureAtRelease: number;
}

export interface CarryEvent extends EventBase {
  type: 'carry';
  lengthM: number;
  underPressure: boolean;
  xtSwing: number;
}

export interface ShotEvent extends EventBase {
  type: 'shot';
  outcome: ShotOutcome;
  xg: number;
  bodyPart: 'right' | 'left' | 'head' | 'other';
  distanceM: number;
  angleDeg: number;
  ballSpeedKph: number;
  /** True when the shooter had a genuine big chance (xG ≥ 0.2). */
  bigChance: boolean;
  assistPlayerId: string | null;
  blockedBy: string | null;
  isPenalty: boolean;
}

export interface SaveEvent extends EventBase {
  type: 'save';
  shooterId: string;
  xg: number;
  /** Subjective save difficulty 0..1 derived from xG and ball speed. */
  difficulty: number;
}

export interface InterceptionEvent extends EventBase {
  type: 'interception';
  intendedRecipientId: string | null;
  resultingPossessionTeam: TeamSide;
}

export interface TackleEvent extends EventBase {
  type: 'tackle';
  tackleOutcome: TackleOutcome;
  opponentId: string;
  duelType: 'ground' | 'aerial';
}

export interface FoulEvent extends EventBase {
  type: 'foul';
  fouledPlayerId: string;
  card: CardType;
  /** Reason shown in broadcast copy: 'tactical', 'reckless', 'dissent', 'last-man'. */
  reason: string;
  foulType: string;
}

export interface CardEvent extends EventBase {
  type: 'yellow_card' | 'red_card';
  playerId: string;
  reason: string;
}

export interface SetPieceEvent extends EventBase {
  type: 'corner' | 'goal_kick' | 'throw_in' | 'offside' | 'penalty' | 'var_check';
  detail: string;
}

export interface SubstitutionEvent extends EventBase {
  type: 'substitution';
  playerId: string;
  playerOffId: string;
  playerOnId: string;
}

export interface ClearanceEvent extends EventBase {
  type: 'clearance';
  distanceM: number;
}

export interface BlockEvent extends EventBase {
  type: 'block';
  shooterId: string;
}

export interface PressurePhaseEvent extends EventBase {
  type: 'pressure_phase';
  /** Which team is applying the pressure. */
  team: TeamSide;
  intensity: number;
  durationS: number;
  zone: 'high' | 'middle' | 'low';
}

export interface PossessionChangeEvent extends EventBase {
  type: 'possession_change';
  toTeam: TeamSide;
  cause: 'turnover' | 'out_of_play' | 'set_piece';
}

export interface PhaseEvent extends EventBase {
  type: 'kickoff' | 'half_time' | 'second_half' | 'full_time';
  detail: string;
}

export type MatchEvent =
  | PassEvent
  | CarryEvent
  | ShotEvent
  | SaveEvent
  | InterceptionEvent
  | TackleEvent
  | FoulEvent
  | CardEvent
  | SetPieceEvent
  | SubstitutionEvent
  | ClearanceEvent
  | BlockEvent
  | PressurePhaseEvent
  | PossessionChangeEvent
  | PhaseEvent;

/* ------------------------------------------------------------------ */
/* Tracking — positional frames at 10 Hz (synthetic broadcast feed)    */
/* ------------------------------------------------------------------ */

export interface TrackingFrame {
  /** Match seconds, quantised to 0.1s. */
  t: number;
  ball: {
    pos: Vec2;
    /** Speed in km/h of the ball at this frame. */
    speedKph: number;
  };
  players: TrackingPlayer[];
}

export interface TrackingPlayer {
  playerId: string;
  pos: Vec2;
  speedKph: number;
}

export const TRACKING_HZ = 10;
export const TRACKING_DT = 1 / TRACKING_HZ;
