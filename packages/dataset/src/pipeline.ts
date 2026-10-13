/**
 * Dataset pipeline — a full run of the five stages in plain Node.
 *
 * Simulate, interpret, explain and compile, with no browser, no worker and
 * no I/O. The exports of this are what the dataset writers and the studio
 * voice recorder consume, so the data they see is exactly what the live app
 * sees — same engine, same crew, same cue compiler.
 */

import { trackingWindow } from '@floodlight/simulator';
import { SCENARIOS, simulateMatch, type Scenario, type SimulationResult } from '@floodlight/simulator';
import { MatchEngine, type InsightCandidate } from '@floodlight/engine';
import { ProductionCrew, type NarratedMoment } from '@floodlight/agents';
import { compileCues, type CueSheet } from '@floodlight/cuesheet';

export type PrepareStage = 'simulating' | 'interpreting' | 'tracking' | 'directing' | 'compiling' | 'ready';

export interface PrepareMatchOptions {
  scenarioId: string | null;
  seed: number;
  /** Tracking rate for the physical-metrics pass (distance, speeds, sprints). */
  trackingHz?: number;
  /** Bring your own crew — the studio-voice recorder passes one with a gateway. */
  crew?: ProductionCrew;
  /** Stage reports for streaming services and CLIs. */
  onProgress?: (stage: PrepareStage, fraction: number) => void;
  /** Fired as each story is written, before the cue sheet exists. */
  onMoment?: (moment: NarratedMoment) => void;
}

export interface PreparedPipeline {
  scenario: Scenario | null;
  seed: number;
  simulation: SimulationResult;
  engine: MatchEngine;
  candidates: InsightCandidate[];
  moments: NarratedMoment[];
  cues: CueSheet;
}

export async function prepareMatch(options: PrepareMatchOptions): Promise<PreparedPipeline> {
  const scenario = options.scenarioId ? SCENARIOS.find((s) => s.id === options.scenarioId) : undefined;
  if (options.scenarioId && !scenario) throw new Error(`unknown scenario: ${options.scenarioId}`);

  options.onProgress?.('simulating', 0.05);
  const simulation = simulateMatch(options.seed, scenario);
  const engine = new MatchEngine(simulation.meta, simulation.lineups);
  const candidates = simulation.events.flatMap((event) => engine.ingestEvent(event));

  // Physical pass in chunks, yielding between them so an HTTP server stays
  // responsive while it watches itself track a whole match.
  options.onProgress?.('tracking', 0.2);
  const hz = options.trackingHz ?? 2;
  const fullTime = simulation.timing.fullTimeT;
  let t = 0;
  while (t < fullTime) {
    const t1 = Math.min(fullTime, t + 6 * 60);
    const frames = trackingWindow(simulation, t, t1, { hz });
    for (const frame of frames) candidates.push(...engine.ingestFrame(frame));
    t = t1;
    options.onProgress?.('tracking', 0.2 + 0.45 * (t / fullTime));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  candidates.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  options.onProgress?.('directing', 0.7);
  const crew = options.crew ?? new ProductionCrew();
  const moments: NarratedMoment[] = [];
  for (const candidate of candidates) {
    const moment = await crew.processCandidate(candidate, engine);
    if (moment) {
      moments.push(moment);
      options.onMoment?.(moment);
    }
    options.onProgress?.('directing', 0.7 + 0.27 * (moments.length / Math.max(1, candidates.length)));
  }

  options.onProgress?.('compiling', 0.97);
  const events = new Map(simulation.events.map((event) => [event.id, event]));
  const cues = compileCues(moments, simulation.meta, { events });

  options.onProgress?.('ready', 1);
  return { scenario: scenario ?? null, seed: options.seed, simulation, engine, candidates, moments, cues };
}
