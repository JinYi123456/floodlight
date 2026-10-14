/**
 * The Floodlight MCP tool surface.
 *
 * A football studio exposed as typed tools: prepare a match, walk the event
 * ledger, read the story list, check a player's night, pull the cue sheet,
 * or run the pixel-only auto-eventing pass — the same functions behind the
 * live product, callable by any MCP-speaking agent host.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MatchService, AtTimeState, MatchFacts, MatchState } from '@floodlight/dataservice';
import type { WindowFeatures } from '@floodlight/engine';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

function reply(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

const scenario = z.string().describe('Scenario id — one of comeback, siege, derby, freeplay');
const seed = z.number().int().optional().describe('Simulation seed (default 2026)');

/** Register the studio tools (backed by a cached MatchService). */
export function registerStudioTools(server: McpServer, service: MatchService): void {
  server.registerTool(
    'list_scenarios',
    {
      description:
        'List the four synthetic matches the studio ships with — id, name, tagline and the two clubs.',
      inputSchema: {},
    },
    async () => reply(service.listScenarios()),
  );

  server.registerTool(
    'prepare_match',
    {
      description:
        'Run the full five-stage pipeline (simulate, interpret, track, direct, compile) for a scenario and seed, and return the match summary: clubs, venue, timing, final score and the number of events, insight candidates, stories and cues.',
      inputSchema: { scenario, seed },
    },
    async ({ scenario: id, seed: s }) => reply(await service.prepare(id, s ?? 2026)),
  );

  server.registerTool(
    'match_state',
    {
      description:
        'The end-of-match intelligence snapshot: score, possession share, per-team stats (PPDA, xT, tempo), control-vs-chaos reading, rhythm, momentum, and the player workload table.',
      inputSchema: { scenario, seed },
    },
    async ({ scenario: id, seed: s }) => reply(await service.matchState(id, s ?? 2026)),
  );

  server.registerTool(
    'state_at',
    {
      description:
        'The scoreboard and flow as they stood at match time t (seconds): score, shots, shots on target, possession share, expected-threat balance and the goal log so far.',
      inputSchema: { scenario, seed, t: z.number().min(0).describe('Match time in seconds') },
    },
    async ({ scenario: id, seed: s, t }) => reply(await service.stateAt(id, s ?? 2026, t)),
  );

  server.registerTool(
    'query_events',
    {
      description:
        'Query the raw event ledger. Filter by event type (pass, carry, shot, save, block, tackle, interception, foul, corner, yellow_card, red_card, substitution, possession_change, pressure_phase, …), team, time window and row limit.',
      inputSchema: {
        scenario,
        seed,
        type: z.string().optional().describe('Event type filter'),
        team: z.enum(['home', 'away']).optional(),
        from: z.number().optional().describe('Window start, match seconds'),
        to: z.number().optional().describe('Window end, match seconds'),
        limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50)'),
      },
    },
    async ({ scenario: id, seed: s, ...query }) => reply(await service.queryEvents(id, s ?? 2026, query)),
  );

  server.registerTool(
    'query_moments',
    {
      description:
        'The story ledger: every moment that went to air, with minute, kind (goal, big_save, var_overturn, milestone, …), the verified headline, and whether the verifier approved it.',
      inputSchema: { scenario, seed, kind: z.string().optional().describe('Moment kind filter') },
    },
    async ({ scenario: id, seed: s, kind }) => reply(await service.queryMoments(id, s ?? 2026, kind)),
  );

  server.registerTool(
    'player_stats',
    {
      description:
        'Per-player match numbers — goals, assists, xG, passes completed, xT generated, distance, top speed, sprints, duels — optionally filtered by player name.',
      inputSchema: { scenario, seed, player: z.string().optional().describe('Name substring filter') },
    },
    async ({ scenario: id, seed: s, player }) => reply(await service.playerStats(id, s ?? 2026, player)),
  );

  server.registerTool(
    'get_cue_sheet',
    {
      description:
        'The compiled broadcast cue sheet: every graphics event — lower thirds, stat bumpers, telestration, momentum bars — with slots, priorities, timings and payloads.',
      inputSchema: { scenario, seed },
    },
    async ({ scenario: id, seed: s }) => reply(await service.cueSheet(id, s ?? 2026)),
  );

  server.registerTool(
    'run_vision_pass',
    {
      description:
        'Run auto-eventing: render the match to a sensor image, detect players and the ball from pixels alone, re-derive passes and shots, and score the result honestly against ground truth. Returns the accuracy report.',
      inputSchema: { scenario, seed },
    },
    async ({ scenario: id, seed: s }) => reply(await service.visionPass(id, s ?? 2026)),
  );
}

/* --------------------------- the live match feed -------------------------- */

export interface LiveEngineLike {
  snapshot(): MatchState;
  scoreAt(t: number): { home: number; away: number };
  windowFeatures(t0: number, t1: number): WindowFeatures;
}

/** Register the live-match tools the production crew consults mid-write. */
export function registerLiveTools(server: McpServer, engine: LiveEngineLike): void {
  server.registerTool(
    'match_snapshot',
    {
      description: 'The live intelligence snapshot the production crew verifies its copy against.',
      inputSchema: {},
    },
    async () => reply(engine.snapshot()),
  );

  server.registerTool(
    'match_score_at',
    {
      description: 'The scoreboard as it stood at a given match time (seconds).',
      inputSchema: { t: z.number().min(0) },
    },
    async ({ t }) => reply(engine.scoreAt(t)),
  );

  server.registerTool(
    'match_window_features',
    {
      description: 'Aggregated flow features over a time window: possession, completion, turnovers, duels, shots, xT balance, high presses.',
      inputSchema: { from: z.number().min(0), to: z.number().min(0) },
    },
    async ({ from, to }) => reply(engine.windowFeatures(from, to)),
  );
}

/**
 * A MatchFacts implementation that reaches the live match over MCP tool
 * calls — the crew's fact-checking path in the running pipeline.
 */
export function factsOverClient(client: Client): MatchFacts {
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((part) => part.type === 'text')?.text ?? 'null';
    return JSON.parse(text) as T;
  };
  return {
    snapshot: () => call<MatchState>('match_snapshot', {}),
    scoreAt: (t) => call<{ home: number; away: number }>('match_score_at', { t }),
    windowFeatures: (t0, t1) => call<WindowFeatures>('match_window_features', { from: t0, to: t1 }),
  };
}

export type { AtTimeState };
