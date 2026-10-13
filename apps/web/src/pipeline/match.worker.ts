/**
 * The pipeline worker — simulation, interpretation, the crew and the cue
 * compiler all live here, off the main thread. The control room talks to it
 * through the typed protocol; the worker never touches the DOM.
 */

import { SCENARIOS, simulateMatch, trackingWindow, type SimulationResult } from '@floodlight/simulator';
import { MatchEngine } from '@floodlight/engine';
import { ProductionCrew, type NarratedMoment } from '@floodlight/agents';
import { compileCues } from '@floodlight/cuesheet';
import type { TrackingFrame } from '@floodlight/core';
import type { PreparedMatch, WorkerRequest, WorkerResponse } from './protocol';

let result: SimulationResult | null = null;

const post = (message: WorkerResponse) => self.postMessage(message);
const progress = (label: string, fraction: number) => post({ type: 'progress', label, fraction });

interface RecordedMoment {
  candidateId: string;
  headline: string;
  body: string;
  lang: string;
  persona: string;
  ticker?: string | null;
  variants?: Array<{ persona: string; lang: string; headline: string; body: string }>;
  provider?: string;
}

interface Recording {
  scenarioId: string;
  seed: number;
  provider: string;
  model: string;
  moments: RecordedMoment[];
}

async function loadRecording(id: string): Promise<Recording | null> {
  try {
    const response = await fetch(`./recordings/${id}.json`);
    if (!response.ok) return null;
    return (await response.json()) as Recording;
  } catch {
    return null;
  }
}

async function prepare(request: { scenarioId: string | null; seed: number; recording?: string | null }): Promise<void> {
  const scenario = request.scenarioId ? SCENARIOS.find((s) => s.id === request.scenarioId) : undefined;

  progress('Playing the match', 0.05);
  const simulation = simulateMatch(request.seed, scenario);
  result = simulation;

  progress('Interpreting events', 0.25);
  const engine = new MatchEngine(simulation.meta, simulation.lineups);
  const candidates = simulation.events.flatMap((e) => engine.ingestEvent(e));

  // Physical pass: 2 Hz tracking through the engine, chunked so the worker
  // stays responsive. Distance, top speed and sprint metrics come from here.
  const chunkMinutes = 6;
  const fullTime = simulation.timing.fullTimeT;
  let t = 0;
  while (t < fullTime) {
    const t1 = Math.min(fullTime, t + chunkMinutes * 60);
    const frames = trackingWindow(simulation, t, t1, { hz: 2 });
    for (const frame of frames) candidates.push(...engine.ingestFrame(frame as TrackingFrame));
    t = t1;
    progress('Tracking the players', 0.25 + 0.45 * (t / fullTime));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  progress('Directing the show', 0.72);
  candidates.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  const recording = request.recording ? await loadRecording(request.recording) : null;
  const recordedById = new Map<string, RecordedMoment>();
  if (recording) for (const m of recording.moments) recordedById.set(m.candidateId, m);

  const crew = new ProductionCrew({ generateVariants: true });
  const moments: NarratedMoment[] = [];
  for (const candidate of candidates) {
    const moment = await crew.processCandidate(candidate, engine);
    if (!moment) continue;
    const recorded = recordedById.get(candidate.id);
    if (recorded) {
      moment.headline = recorded.headline;
      moment.body = recorded.body;
      moment.provider = 'llm';
      if (recorded.ticker) moment.ticker = recorded.ticker;
      if (recorded.variants?.length) {
        moment.variants = recorded.variants as NarratedMoment['variants'];
      }
    }
    moments.push(moment);
  }

  progress('Compiling the cue sheet', 0.9);
  const events = new Map(simulation.events.map((e) => [e.id, e]));
  const cues = compileCues(moments, simulation.meta, { events });

  // Score timeline for the timeline scrubber.
  const scoreTimeline: PreparedMatch['scoreTimeline'] = [{ t: 0, home: 0, away: 0 }];
  let home = 0;
  let away = 0;
  const overturned = new Set(
    candidates.filter((c) => c.kind === 'var_overturn').map((c) => c.t),
  );
  for (const event of simulation.events) {
    if (event.type === 'shot' && (event as { outcome: string }).outcome === 'goal') {
      const wasOverturned = [...overturned].some((ot) => ot > event.t && ot - event.t < 200);
      if (wasOverturned) continue;
      if (event.team === 'home') home++;
      else away++;
      scoreTimeline.push({ t: event.t, home, away });
    }
  }

  const stats = crew.runtime.stats();
  const payload: PreparedMatch = {
    meta: simulation.meta,
    timing: { halfTimeT: simulation.timing.halfTimeT, fullTimeT: simulation.timing.fullTimeT },
    lineups: {
      home: simulation.lineups.home.starters.map((p) => ({ id: p.id, name: p.name, shirt: p.shirt, role: p.role, team: 'home' as const })),
      away: simulation.lineups.away.starters.map((p) => ({ id: p.id, name: p.name, shirt: p.shirt, role: p.role, team: 'away' as const })),
    },
    events: simulation.events,
    cues,
    moments,
    candidates,
    players: engine.snapshot().players,
    traces: crew.runtime.allTraces(),
    scoreTimeline,
    providerSummary: {
      completed: stats.completed,
      fallback: stats.fallback,
      failed: stats.failed,
      recorded: Boolean(recording),
    },
  };
  progress('Ready', 1);
  post({ type: 'ready', payload });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'prepare':
        await prepare(request);
        break;
      case 'trackingWindow': {
        if (!result) throw new Error('match not prepared');
        const frames = trackingWindow(result, request.t0, request.t1, { hz: request.hz ?? 10 });
        post({ type: 'tracking', t0: request.t0, t1: request.t1, frames });
        break;
      }
      default:
        post({ type: 'error', message: `unsupported request: ${request.type}` });
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
