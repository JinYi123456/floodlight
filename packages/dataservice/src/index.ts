/**
 * The match data service — one typed tool surface, three consumers.
 *
 * The same functions back the MCP server an external agent host attaches
 * to, the crew's fact-checking calls inside the live pipeline, and the
 * studio HTTP API's derived endpoints. One implementation, one truth: the
 * verification the audience sees is the verification the tools serve.
 */

import type { MatchEvent, TeamSide } from '@floodlight/core';
import { CLUBS, SCENARIOS, type SimulationResult } from '@floodlight/simulator';
import type { InsightCandidate, MatchState, PlayerMatchStats, WindowFeatures } from '@floodlight/engine';
import type { FactsSource, NarratedMoment } from '@floodlight/agents';
import type { CueSheet } from '@floodlight/cuesheet';
import { prepareMatch } from '@floodlight/dataset';
import { runVisionPass, type VisionReport } from '@floodlight/vision';

export type { MatchState, PlayerMatchStats, WindowFeatures, VisionReport };

/* ------------------------------ live facts ------------------------------- */

/**
 * The async fact surface the production crew consults while it writes. The
 * MCP client implements this over tool calls; a plain object over a live
 * engine implements it in-process. Same numbers either way.
 */
export { liveFacts, type MatchFacts, type FactsSource } from '@floodlight/agents';

/* ------------------------------ the service ------------------------------ */

export interface PreparedSummary {
  matchId: string;
  scenario: string | null;
  seed: number;
  clubs: { home: { name: string; abbr: string }; away: { name: string; abbr: string } };
  venue: string;
  timing: { halfTimeT: number; fullTimeT: number };
  finalScore: { home: number; away: number };
  counts: { events: number; candidates: number; stories: number; cues: number };
}

export interface AtTimeState {
  t: number;
  minuteLabel: string;
  period: 1 | 2;
  score: { home: number; away: number };
  shots: { home: number; away: number };
  shotsOnTarget: { home: number; away: number };
  possessionShare: { home: number; away: number };
  xtBalance: number;
  goals: Array<{ t: number; minuteLabel: string; team: TeamSide; player: string | null }>;
}

export interface EventQuery {
  type?: string;
  team?: TeamSide;
  from?: number;
  to?: number;
  limit?: number;
}

export interface MomentRow {
  id: string;
  t: number;
  minuteLabel: string;
  kind: string;
  team: TeamSide | 'none';
  headline: string;
  verified: boolean;
  persona: string;
  provider: string;
}

export interface ScenarioRow {
  id: string;
  name: string;
  tagline: string;
  home: { name: string; abbr: string };
  away: { name: string; abbr: string };
}

interface Prepared {
  summary: PreparedSummary;
  simulation: SimulationResult;
  engine: FactsSource;
  candidates: InsightCandidate[];
  moments: NarratedMoment[];
  cues: CueSheet;
}

function clubOf(clubId: string): { name: string; abbr: string } {
  const profile = CLUBS.find((candidate) => candidate.club.id === clubId);
  return { name: profile?.club.name ?? clubId, abbr: profile?.club.abbr ?? clubId.toUpperCase() };
}

function playerNameOf(simulation: SimulationResult, playerId: string | null): string | null {
  if (!playerId) return null;
  for (const side of ['home', 'away'] as const) {
    for (const group of [simulation.lineups[side].starters, simulation.lineups[side].bench]) {
      const found = group.find((player) => player.id === playerId);
      if (found) return found.name;
    }
  }
  return null;
}

/** The full tool surface over a prepared match. */
export class MatchService {
  private cache = new Map<string, Promise<Prepared>>();

  listScenarios(): ScenarioRow[] {
    return SCENARIOS.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      tagline: scenario.tagline,
      home: clubOf(scenario.homeClubId),
      away: clubOf(scenario.awayClubId),
    }));
  }

  async prepare(scenarioId: string | null, seed = 2026): Promise<PreparedSummary> {
    return (await this.pipeline(scenarioId, seed)).summary;
  }

  async matchState(scenarioId: string | null, seed = 2026): Promise<MatchState> {
    return (await this.pipeline(scenarioId, seed)).engine.snapshot();
  }

  /** The scoreboard and flow as they stood at match time `t`. */
  async stateAt(scenarioId: string | null, seed = 2026, t = 0): Promise<AtTimeState> {
    const prepared = await this.pipeline(scenarioId, seed);
    return this.reduceAt(prepared, t);
  }

  async queryEvents(scenarioId: string | null, seed = 2026, query: EventQuery = {}): Promise<MatchEvent[]> {
    const prepared = await this.pipeline(scenarioId, seed);
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const rows = prepared.simulation.events.filter((event) => {
      if (query.type && event.type !== query.type) return false;
      if (query.team && event.team !== query.team) return false;
      if (query.from !== undefined && event.t < query.from) return false;
      if (query.to !== undefined && event.t > query.to) return false;
      return true;
    });
    return rows.slice(0, limit);
  }

  async queryMoments(scenarioId: string | null, seed = 2026, kind?: string): Promise<MomentRow[]> {
    const prepared = await this.pipeline(scenarioId, seed);
    return prepared.moments
      .filter((moment) => moment.air.air && (!kind || moment.candidate.kind === kind))
      .map((moment) => ({
        id: moment.candidate.id,
        t: moment.candidate.t,
        minuteLabel: moment.candidate.minuteLabel,
        kind: moment.candidate.kind,
        team: moment.candidate.team,
        headline: moment.headline,
        verified: moment.verification.approved,
        persona: moment.persona,
        provider: moment.provider,
      }));
  }

  async playerStats(scenarioId: string | null, seed = 2026, player?: string): Promise<PlayerMatchStats[]> {
    const prepared = await this.pipeline(scenarioId, seed);
    const rows = prepared.engine.snapshot().players;
    if (!player) return rows;
    const needle = player.toLowerCase();
    return rows.filter((row) => row.name.toLowerCase().includes(needle));
  }

  async cueSheet(scenarioId: string | null, seed = 2026): Promise<CueSheet> {
    return (await this.pipeline(scenarioId, seed)).cues;
  }

  async visionPass(scenarioId: string | null, seed = 2026): Promise<{ report: VisionReport; derivedEvents: number }> {
    const prepared = await this.pipeline(scenarioId, seed);
    const { report, events } = runVisionPass(prepared.simulation);
    return { report, derivedEvents: events.length };
  }

  /* ------------------------------- internals ------------------------------ */

  private pipeline(scenarioId: string | null, seed: number): Promise<Prepared> {
    const key = `${scenarioId ?? 'default'}:${seed}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.build(scenarioId, seed);
      this.cache.set(key, entry);
    }
    return entry;
  }

  private async build(scenarioId: string | null, seed: number): Promise<Prepared> {
    const scenario = scenarioId ? SCENARIOS.find((s) => s.id === scenarioId) : undefined;
    if (scenarioId && !scenario) throw new Error(`unknown scenario: ${scenarioId}`);
    const pipeline = await prepareMatch({ scenarioId, seed });
    const meta = pipeline.simulation.meta;
    const score = pipeline.engine.scoreAt(pipeline.simulation.timing.fullTimeT);
    return {
      summary: {
        matchId: meta.id,
        scenario: scenarioId,
        seed,
        clubs: { home: clubOf(meta.home.id), away: clubOf(meta.away.id) },
        venue: meta.venue.name,
        timing: {
          halfTimeT: pipeline.simulation.timing.halfTimeT,
          fullTimeT: pipeline.simulation.timing.fullTimeT,
        },
        finalScore: score,
        counts: {
          events: pipeline.simulation.events.length,
          candidates: pipeline.candidates.length,
          stories: pipeline.moments.length,
          cues: pipeline.cues.cues.length,
        },
      },
      simulation: pipeline.simulation,
      engine: pipeline.engine,
      candidates: pipeline.candidates,
      moments: pipeline.moments,
      cues: pipeline.cues,
    };
  }

  private reduceAt(prepared: Prepared, t: number): AtTimeState {
    const side = { home: 0, away: 0 } as Record<TeamSide, number>;
    const onTarget = { home: 0, away: 0 } as Record<TeamSide, number>;
    const xt = { home: 0, away: 0 } as Record<TeamSide, number>;
    const possessionMs = { home: 0, away: 0 } as Record<TeamSide, number>;
    const goals: AtTimeState['goals'] = [];
    let possessionTeam: TeamSide = 'home';
    let possessionSince = 0;
    for (const event of prepared.simulation.events) {
      if (event.t > t) break;
      if (event.type === 'possession_change') {
        possessionMs[possessionTeam] += event.t - possessionSince;
        possessionTeam = event.team === 'away' ? 'away' : 'home';
        possessionSince = event.t;
      }
      if (event.type === 'shot') {
        side[event.team === 'away' ? 'away' : 'home']++;
        if (event.outcome === 'goal') onTarget[event.team === 'away' ? 'away' : 'home']++;
        else if (event.outcome === 'saved') onTarget[event.team === 'away' ? 'away' : 'home']++;
        if (event.outcome === 'goal') {
          goals.push({
            t: event.t,
            minuteLabel: `${Math.max(1, Math.round(event.t / 60))}'`,
            team: event.team === 'away' ? 'away' : 'home',
            player: playerNameOf(prepared.simulation, event.playerId),
          });
        }
      }
      if (event.type === 'pass') {
        const at = (event as { xtSwing?: number }).xtSwing ?? 0;
        xt[event.team === 'away' ? 'away' : 'home'] += at;
      }
    }
    possessionMs[possessionTeam] += Math.max(0, t - possessionSince);
    const totalPossession = possessionMs.home + possessionMs.away || 1;
    return {
      t,
      minuteLabel: `${Math.max(1, Math.round(t / 60))}'`,
      period: t >= prepared.simulation.timing.halfTimeT ? 2 : 1,
      score: { home: goals.filter((g) => g.team === 'home').length, away: goals.filter((g) => g.team === 'away').length },
      shots: side,
      shotsOnTarget: onTarget,
      possessionShare: {
        home: Math.round((possessionMs.home / totalPossession) * 1000) / 1000,
        away: Math.round((possessionMs.away / totalPossession) * 1000) / 1000,
      },
      xtBalance: Math.round((xt.home - xt.away) * 1000) / 1000,
      goals,
    };
  }
}
