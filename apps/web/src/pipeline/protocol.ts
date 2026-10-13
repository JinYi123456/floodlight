/**
 * Worker protocol — the typed contract between the control room and the
 * pipeline worker. The worker owns the simulation, the engine, the crew and
 * the cue compiler; the UI owns the clock and the pixels.
 */

import type { MatchEvent, MatchMeta, TeamSide, TrackingFrame } from '@floodlight/core';
import type { NarratedMoment, TaskTrace } from '@floodlight/agents';
import type { CueSheet } from '@floodlight/cuesheet';
import type { InsightCandidate, PlayerMatchStats } from '@floodlight/engine';
import type { DerivedEvent, VisionReport } from '@floodlight/vision';

export type { VisionReport, DerivedEvent };

export interface LineupPlayer {
  id: string;
  name: string;
  shirt: number;
  role: string;
  team: TeamSide;
  /** Formation slot 0..10 — starters only. */
  slot?: number;
  /** Normalised anchor on the right-facing half: x own goal → opponent goal
   *  (0..1), y across (-1..1). Starters only. */
  slotX?: number;
  slotY?: number;
}

export interface PreparedMatch {
  meta: MatchMeta;
  timing: { halfTimeT: number; fullTimeT: number };
  lineups: { home: LineupPlayer[]; away: LineupPlayer[] };
  bench: { home: LineupPlayer[]; away: LineupPlayer[] };
  formations: { home: string; away: string };
  events: MatchEvent[];
  cues: CueSheet;
  moments: NarratedMoment[];
  candidates: InsightCandidate[];
  players: PlayerMatchStats[];
  traces: TaskTrace[];
  scoreTimeline: Array<{ t: number; home: number; away: number }>;
  providerSummary: { completed: number; fallback: number; failed: number; recorded: boolean };
}

export interface VisionFrameEntity {
  cls: 'ball' | 'home' | 'away';
  x: number;
  y: number;
}

export type VisionJob =
  | { type: 'visionPrepare' }
  | { type: 'visionFrame'; t: number; width: number; height: number }
  | { type: 'visionAnalyze' };

export type WorkerRequest =
  | { type: 'prepare'; scenarioId: string | null; seed: number; recording?: string | null; recordingsBase?: string | null }
  | { type: 'trackingWindow'; t0: number; t1: number; hz?: number }
  | VisionJob;

export type WorkerResponse =
  | { type: 'progress'; label: string; fraction: number; channel?: 'prepare' | 'vision' }
  | { type: 'ready'; payload: PreparedMatch }
  | { type: 'tracking'; t0: number; t1: number; frames: TrackingFrame[] }
  | { type: 'visionReady'; window: { t0: number; t1: number } }
  | {
      type: 'visionFrame';
      t: number;
      width: number;
      height: number;
      rgba: ArrayBuffer;
      entities: VisionFrameEntity[];
      detected: DerivedEvent[];
    }
  | { type: 'visionReport'; report: VisionReport }
  | { type: 'error'; message: string };
