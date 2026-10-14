/**
 * The MCP surface, exercised the way a real client would.
 *
 * Two linked transports per suite: the studio tools behind a cached
 * MatchService, and the live tools behind a running engine. Every tool is
 * called over the wire (in memory), and the crew's facts client is checked
 * to return exactly the engine's numbers.
 */

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { prepareMatch } from '@floodlight/dataset';
import { MatchService } from '@floodlight/dataservice';
import { createLiveFactsClient } from '../src/live';
import { registerStudioTools } from '../src/tools';

async function connectClient(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 'floodlight-test', version: '1.0.0' });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((part) => part.type === 'text')?.text ?? 'null';
  return JSON.parse(text) as T;
}

describe('studio tools over MCP', () => {
  it('serves scenarios, the prepared match, ledger, stories, players, cues and the vision pass', async () => {
    const client = await connectClient((server) => registerStudioTools(server, new MatchService()));

    const scenarios = await call<Array<{ id: string; home: { name: string }; away: { name: string } }>>(
      client,
      'list_scenarios',
    );
    expect(scenarios.map((row) => row.id).sort()).toEqual(['comeback', 'derby', 'freeplay', 'siege']);
    const comeback = scenarios.find((row) => row.id === 'comeback')!;
    expect(comeback.home.name).toMatch(/./);
    expect(comeback.away.name).toMatch(/./);

    const summary = await call<{
      matchId: string;
      scenario: string;
      finalScore: { home: number; away: number };
      counts: { events: number; candidates: number; stories: number; cues: number };
    }>(client, 'prepare_match', { scenario: 'freeplay', seed: 77 });
    expect(summary.scenario).toBe('freeplay');
    expect(summary.counts.events).toBeGreaterThan(2000);
    expect(summary.counts.stories).toBeGreaterThan(0);
    expect(summary.counts.cues).toBeGreaterThan(0);
    expect(summary.finalScore.home + summary.finalScore.away).toBeGreaterThanOrEqual(0);

    const state = await call<{
      possession: { home: number; away: number };
      players: unknown[];
    }>(client, 'match_state', { scenario: 'freeplay', seed: 77 });
    expect(state.possession.home + state.possession.away).toBeCloseTo(1, 2);
    expect(state.players.length).toBeGreaterThan(20);

    const at = await call<{
      score: { home: number; away: number };
      shots: { home: number; away: number };
      goals: unknown[];
    }>(client, 'state_at', { scenario: 'freeplay', seed: 77, t: 60 * 75 });
    expect(at.shots.home + at.shots.away).toBeGreaterThan(0);
    expect(at.goals.length).toBe(at.score.home + at.score.away);

    const shots = await call<Array<{ type: string; t: number }>>(client, 'query_events', {
      scenario: 'freeplay',
      seed: 77,
      type: 'shot',
      limit: 4,
    });
    expect(shots.length).toBe(4);
    expect(shots.every((row) => row.type === 'shot')).toBe(true);

    const windowed = await call<Array<{ t: number; team: string }>>(client, 'query_events', {
      scenario: 'freeplay',
      seed: 77,
      from: 900,
      to: 905,
    });
    expect(windowed.every((row) => row.t >= 900 && row.t <= 905)).toBe(true);

    const moments = await call<Array<{ id: string; headline: string; verified: boolean }>>(client, 'query_moments', {
      scenario: 'freeplay',
      seed: 77,
    });
    expect(moments.length).toBeGreaterThan(0);
    expect(moments.every((row) => typeof row.verified === 'boolean' && row.headline.length > 0)).toBe(true);

    const players = await call<Array<{ name: string; distanceKm: number }>>(client, 'player_stats', {
      scenario: 'freeplay',
      seed: 77,
    });
    expect(players.length).toBeGreaterThan(20);
    expect(players.every((row) => row.distanceKm >= 0)).toBe(true);
    const named = await call<Array<{ name: string }>>(client, 'player_stats', {
      scenario: 'freeplay',
      seed: 77,
      player: players[0]!.name.slice(0, 4),
    });
    expect(named.some((row) => row.name === players[0]!.name)).toBe(true);

    const cues = await call<{ cues: Array<{ id: string; priority: number }> }>(client, 'get_cue_sheet', {
      scenario: 'freeplay',
      seed: 77,
    });
    expect(cues.cues.length).toBeGreaterThan(0);

    const vision = await call<{ report: { passPrecision: number; passRecall: number }; derivedEvents: number }>(
      client,
      'run_vision_pass',
      { scenario: 'freeplay', seed: 77 },
    );
    expect(vision.report.passPrecision).toBeGreaterThan(0);
    expect(vision.report.passPrecision).toBeLessThanOrEqual(1);
    expect(vision.derivedEvents).toBeGreaterThan(0);
  }, 60_000);

  it('reports unknown scenarios as tool errors, not crashes', async () => {
    const client = await connectClient((server) => registerStudioTools(server, new MatchService()));
    let errored = false;
    try {
      const result = await client.callTool({ name: 'prepare_match', arguments: { scenario: 'nope' } });
      errored = result.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  }, 60_000);
});

describe('live tools over MCP', () => {
  it('hands the crew the engine numbers it verifies against', async () => {
    const prepared = await prepareMatch({ scenarioId: 'freeplay', seed: 77 });
    const engine = prepared.engine;
    const facts = await createLiveFactsClient(engine);

    await expect(facts.snapshot()).resolves.toEqual(engine.snapshot());
    await expect(facts.scoreAt(23 * 60)).resolves.toEqual(engine.scoreAt(23 * 60));
    await expect(facts.windowFeatures(20 * 60, 25 * 60)).resolves.toEqual(engine.windowFeatures(20 * 60, 25 * 60));
  }, 60_000);
});
