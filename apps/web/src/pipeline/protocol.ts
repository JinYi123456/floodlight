/**
 * Worker protocol — the typed contract between the control room and the
 * pipeline worker. The worker owns the simulation, the engine, the crew and
 * the cue compiler; the UI owns the clock and the pixels.
 */

import type { MatchEvent, MatchMeta, TeamSide, TrackingFrame } from '@floodlight/core';
import type { NarratedMoment, TaskTrace } from '@floodlight/agents';
import type { CueSheet } from '@floodlight/cuesheet';
import type { InsightCandidate, PlayerMatchStats } from '@floodlight/engine';

export interface LineupPlayer {
  id: string;
  name: string;
  shirt: number;
  role: string;
  team: TeamSide;
}

export interface PreparedMatch {
  meta: MatchMeta;
  timing: { halfTimeT: number; fullTimeT: number };
  lineups: { home: LineupPlayer[]; away: LineupPlayer[] };
  events: MatchEvent[];
  cues: CueSheet;
  moments: NarratedMoment[];
  candidates: InsightCandidate[];
  players: PlayerMatchStats[];
  traces: TaskTrace[];
  scoreTimeline: Array<{ t: number; home: number; away: number }>;
  providerSummary: { completed: number; fallback: number; failed: number; recorded: boolean };
}

export interface VisionDetectedEvent {
  t: number;
  type: 'pass' | 'shot' | 'possession_change';
  team: 'home' | 'away' | 'none';
  from: { x: number; y: number };
  to: { x: number; y: number };
  speedKph: number;
}

export interface VisionFrameSample {
  t: number;
  /** Detected entities: [x, y, speedKph, classId] in pitch metres. */
  entities: Array<{ x: number; y: number; speedKph: number; cls: 'ball' | 'home' | 'away' | 'official' }>;
}

export interface VisionReport {
  scenarioId: string;
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
  samples: Array<{
    t: number;
    truth: { passes: number; shots: number };
    detected: { passes: number; shots: number };
    ballSpeedTruth: number;
    ballSpeedDetected: number;
  }>;
}

export type VisionJob =
  | { type: 'visionPrepare'; scenarioId: string }
  | { type: 'visionFrame'; t: number; width: number; height: number }
  | { type: 'visionReport' };

export type WorkerRequest =
  | { type: 'prepare'; scenarioId: string | null; seed: number; recording?: string | null }
  | { type: 'trackingWindow'; t0: number; t1: number; hz?: number }
  | VisionJob;

export type WorkerResponse =
  | { type: 'progress'; label: string; fraction: number }
  | { type: 'ready'; payload: PreparedMatch }
  | { type: 'tracking'; t0: number; t1: number; frames: TrackingFrame[] }
  | { type: 'visionReady'; scenarioId: string; window: { t0: number; t1: number } }
  | { type: 'visionFrame'; t: number; rgba: ArrayBuffer; width: number; height: number; entities: VisionFrameSample['entities']; detected: VisionDetectedEvent[] }
  | { type: 'visionReport'; report: VisionReport }
  | { type: 'error'; message: string };
