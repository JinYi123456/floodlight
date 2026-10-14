/**
 * The pipeline as a service.
 *
 * One process, zero runtime dependencies beyond the workspace: simulate a
 * match, interpret it, write and verify the stories, compile the cue sheet —
 * then serve all of it over plain HTTP with server-sent events for the live
 * stages. The dataset writers are reused verbatim, so what the API returns
 * is what the web app plays and what data/ contains.
 *
 *   GET /health
 *   GET /scenarios
 *   GET /matches/prepare?scenario=&seed=      full machine-readable run
 *   GET /matches/stream?scenario=&seed=       SSE: stage, moment, ready, done
 *   GET /matches/vision?scenario=&seed=       auto-eventing report from pixels
 *   GET /matches/events.jsonl?scenario=&seed= NDJSON event stream
 *   GET /matches/moments.csv?scenario=&seed=  stories as CSV
 *   GET /matches/data-card?scenario=&seed=    generated data card
 *   POST /mcp                                 the studio as MCP tools (Streamable HTTP)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CLUBS, SCENARIOS, simulateMatch } from '@floodlight/simulator';
import { runVisionPass, visionWindowFor, type DerivedEvent, type VisionReport } from '@floodlight/vision';
import {
  buildDataCard,
  eventsCsv,
  exportMatch,
  momentsCsv,
  prepareMatch,
  toJsonl,
  type ExportedMatch,
} from '@floodlight/dataset';
import { handleMcp } from './mcp-endpoint';

const PORT = Number(process.env['PORT'] ?? '8787');

/* ------------------------------ tiny cache ----------------------------- */

function memoise<T>(cache: Map<string, Promise<T>>, capacity: number, key: string, build: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = build().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  if (cache.size > capacity) cache.delete(cache.keys().next().value!);
  return pending;
}

const matchCache = new Map<string, Promise<ExportedMatch>>();
const visionCache = new Map<string, Promise<{ window: { t0: number; t1: number }; report: VisionReport; events: DerivedEvent[] }>>();

/* ------------------------------- helpers ------------------------------- */

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
};

const send = (res: ServerResponse, status: number, contentType: string, body: string): void => {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
};

interface MatchQuery {
  scenarioId: string | null;
  seed: number;
}

function parseMatchQuery(url: URL): MatchQuery {
  const scenario = url.searchParams.get('scenario');
  if (scenario && !SCENARIOS.some((s) => s.id === scenario)) {
    throw Object.assign(new Error(`unknown scenario "${scenario}"`), { status: 404, known: SCENARIOS.map((s) => s.id) });
  }
  const seed = Number(url.searchParams.get('seed') ?? '2026');
  if (!Number.isFinite(seed)) throw Object.assign(new Error('seed must be a number'), { status: 400 });
  return { scenarioId: scenario, seed };
}

const runMatch = (query: MatchQuery): Promise<ExportedMatch> =>
  memoise(matchCache, 6, `${query.scenarioId ?? 'free'}|${query.seed}`, async () => exportMatch(await prepareMatch(query)));

const runVision = (query: MatchQuery) =>
  memoise(visionCache, 4, `${query.scenarioId ?? 'free'}|${query.seed}`, async () => {
    const scenario = query.scenarioId ? SCENARIOS.find((s) => s.id === query.scenarioId) : undefined;
    const simulation = simulateMatch(query.seed, scenario);
    const window = visionWindowFor(simulation);
    const pass = runVisionPass(simulation, window);
    return { window, report: pass.report, events: pass.events };
  });

const scenarioSummaries = () =>
  SCENARIOS.map((scenario) => {
    const home = CLUBS.find((entry) => entry.club.id === scenario.homeClubId)?.club;
    const away = CLUBS.find((entry) => entry.club.id === scenario.awayClubId)?.club;
    return {
      id: scenario.id,
      name: scenario.name,
      tagline: scenario.tagline,
      home: home ? { id: home.id, name: home.name, abbr: home.abbr, primary: home.primary } : null,
      away: away ? { id: away.id, name: away.name, abbr: away.abbr, primary: away.primary } : null,
    };
  });

const countsOf = (data: ExportedMatch) => ({
  events: data.events.length,
  candidates: data.candidates.length,
  moments: data.moments.length,
  cues: data.cues.cues.length,
  players: data.players.length,
});

/* ------------------------------- routes -------------------------------- */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    });
    res.end();
    return;
  }

  // The MCP tool surface over Streamable HTTP — the same nine tools the
  // stdio server exposes, attachable by any remote MCP host.
  if (path === '/mcp') {
    await handleMcp(req, res);
    return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'only GET is served' });
    return;
  }

  switch (path) {
    case '/':
    case '/health':
      json(res, 200, {
        ok: true,
        service: 'floodlight-api',
        version: '0.1.0',
        endpoints: [
          '/scenarios',
          '/matches/prepare?scenario=comeback&seed=2026',
          '/matches/stream?scenario=comeback&seed=2026',
          '/matches/vision?scenario=comeback&seed=2026',
          '/matches/events.jsonl?scenario=comeback&seed=2026',
          '/matches/moments.csv?scenario=comeback&seed=2026',
          '/matches/data-card?scenario=comeback&seed=2026',
          '/mcp (POST — MCP tools over Streamable HTTP)',
        ],
      });
      return;

    case '/scenarios':
      json(res, 200, { scenarios: scenarioSummaries(), defaultSeed: 2026 });
      return;

    case '/matches/prepare': {
      const query = parseMatchQuery(url);
      const data = await runMatch(query);
      json(res, 200, { counts: countsOf(data), ...data });
      return;
    }

    case '/matches/stream': {
      const query = parseMatchQuery(url);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const write = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // The point of this endpoint is to watch the stages happen: no cache.
      const prepared = await prepareMatch({
        ...query,
        onProgress: (stage, fraction) => write('stage', { stage, fraction: Math.round(fraction * 100) / 100 }),
        onMoment: (moment) =>
          write('moment', {
            t: Math.round(moment.candidate.t),
            kind: moment.candidate.kind,
            team: moment.candidate.team,
            minute: moment.candidate.minuteLabel,
            provider: moment.provider,
            headline: moment.headline,
          }),
      });
      const data = exportMatch(prepared);
      write('ready', { counts: countsOf(data), finalScore: data.finalScore, matchId: data.meta.id });
      write('done', { ok: true });
      res.end();
      return;
    }

    case '/matches/vision': {
      const query = parseMatchQuery(url);
      const { window, report, events } = await runVision(query);
      json(res, 200, { window, report, derivedEvents: events });
      return;
    }

    case '/matches/events.jsonl': {
      const data = await runMatch(parseMatchQuery(url));
      send(res, 200, 'application/x-ndjson; charset=utf-8', toJsonl(data.events));
      return;
    }

    case '/matches/moments.csv': {
      const data = await runMatch(parseMatchQuery(url));
      send(res, 200, 'text/csv; charset=utf-8', momentsCsv(data.moments));
      return;
    }

    case '/matches/events.csv': {
      const data = await runMatch(parseMatchQuery(url));
      send(res, 200, 'text/csv; charset=utf-8', eventsCsv(data.events));
      return;
    }

    case '/matches/data-card': {
      const data = await runMatch(parseMatchQuery(url));
      send(res, 200, 'text/markdown; charset=utf-8', buildDataCard(data));
      return;
    }

    default:
      json(res, 404, {
        error: `no route for ${path}`,
        endpoints: ['/health', '/scenarios', '/matches/prepare', '/matches/stream', '/matches/vision', '/matches/events.jsonl', '/matches/moments.csv', '/matches/data-card', '/mcp'],
      });
  }
}

export function createApiServer(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500;
      const body: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error) };
      const known = (error as { known?: unknown }).known;
      if (Array.isArray(known)) body['knownScenarios'] = known;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, body);
      else res.end();
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createApiServer();
  server.listen(PORT, () => {
    console.log(`floodlight api listening on :${PORT}`);
  });
}
