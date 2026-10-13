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

export interface PrepareMatchOptions {
  scenarioId: string | null;
  seed: number;
  /** Tracking rate for the physical-metrics pass (distance, speeds, sprints). */
  trackingHz?: number;
  /** Bring your own crew — the studio-voice recorder passes one with a gateway. */
  crew?: ProductionCrew;
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

  const simulation = simulateMatch(options.seed, scenario);
  const engine = new MatchEngine(simulation.meta, simulation.lineups);
  const candidates = simulation.events.flatMap((event) => engine.ingestEvent(event));

  const frames = trackingWindow(simulation, 0, simulation.timing.fullTimeT, { hz: options.trackingHz ?? 2 });
  for (const frame of frames) candidates.push(...engine.ingestFrame(frame));

  candidates.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  const crew = options.crew ?? new ProductionCrew();
  const moments: NarratedMoment[] = [];
  for (const candidate of candidates) {
    const moment = await crew.processCandidate(candidate, engine);
    if (moment) moments.push(moment);
  }

  const events = new Map(simulation.events.map((event) => [event.id, event]));
  const cues = compileCues(moments, simulation.meta, { events });

  return { scenario: scenario ?? null, seed: options.seed, simulation, engine, candidates, moments, cues };
}
