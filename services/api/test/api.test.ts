/**
 * The API is a plain node:http server over the same pipeline the web app
 * runs — these tests boot it on an ephemeral port and talk to it with fetch.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer } from '../src/server';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('floodlight api', () => {
  it('answers health with an endpoint index', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; endpoints: string[] };
    expect(body.ok).toBe(true);
    expect(body.endpoints.some((endpoint) => endpoint.startsWith('/matches/stream'))).toBe(true);
  });

  it('lists the four scenarios with their clubs', async () => {
    const response = await fetch(`${base}/scenarios`);
    const body = (await response.json()) as { scenarios: Array<{ id: string; home: { name: string } | null }> };
    expect(body.scenarios.map((s) => s.id)).toEqual(['comeback', 'siege', 'derby', 'freeplay']);
    expect(body.scenarios[0]!.home?.name).toBe('Riverside Athletic');
  });

  it('serves a prepared match and reuses the cached run for derived formats', async () => {
    const prepared = await fetch(`${base}/matches/prepare?scenario=freeplay&seed=77`);
    expect(prepared.status).toBe(200);
    const data = (await prepared.json()) as { counts: { events: number; moments: number }; finalScore: { home: number; away: number } };
    expect(data.counts.events).toBeGreaterThan(500);
    expect(data.counts.moments).toBeGreaterThan(0);

    const jsonl = await fetch(`${base}/matches/events.jsonl?scenario=freeplay&seed=77`);
    expect(jsonl.headers.get('content-type')).toContain('ndjson');
    const lines = (await jsonl.text()).trimEnd().split('\n');
    expect(lines).toHaveLength(data.counts.events);
    expect(JSON.parse(lines[0]!)).toHaveProperty('id');

    const card = await fetch(`${base}/matches/data-card?scenario=freeplay&seed=77`);
    expect(await card.text()).toContain('# Data card');
  });

  it('streams the production stages and every story over SSE', async () => {
    const response = await fetch(`${base}/matches/stream?scenario=freeplay&seed=77`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    for (const event of ['event: stage', 'event: moment', 'event: ready', 'event: done']) {
      expect(text).toContain(event);
    }
    const readyLine = text.split('\n\n').find((block) => block.startsWith('event: ready'))!;
    const payload = JSON.parse(readyLine.split('data: ')[1]!) as { counts: { moments: number }; finalScore: { home: number; away: number } };
    expect(payload.counts.moments).toBeGreaterThan(0);
    expect(payload.finalScore.home + payload.finalScore.away).toBeGreaterThanOrEqual(0);
  });

  it('runs auto-eventing and reports honest accuracy over the tape', async () => {
    const response = await fetch(`${base}/matches/vision?scenario=freeplay&seed=77`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { framesProcessed: number; passPrecision: number; groundTruth: { passes: number } };
      derivedEvents: Array<{ type: string }>;
    };
    expect(body.report.framesProcessed).toBeGreaterThan(800);
    // The freeplay window ends in a penalty-box scramble where a blocked
    // shot rebounds off bodies — one honest misread in five detections is
    // within what pixel-only auto-eventing can promise.
    expect(body.report.passPrecision).toBeGreaterThanOrEqual(0.8);
    expect(body.report.groundTruth.passes).toBeGreaterThan(0);
    expect(body.derivedEvents.length).toBeGreaterThan(0);
  });

  it('rejects unknown scenarios and routes with useful 404s', async () => {
    const scenario = await fetch(`${base}/matches/prepare?scenario=nope`);
    expect(scenario.status).toBe(404);
    const body = (await scenario.json()) as { knownScenarios: string[] };
    expect(body.knownScenarios).toContain('comeback');

    const route = await fetch(`${base}/nonsense`);
    expect(route.status).toBe(404);
  });
});
