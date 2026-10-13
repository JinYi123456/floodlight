/**
 * Studio voice recorder.
 *
 * Runs the real production crew with a Featherless gateway over each story
 * scenario and freezes the verified output into static recordings the web
 * app can play without any key in the browser. The live app then shows
 * `provider: llm` copy exactly as it was recorded — templates remain the
 * floor everywhere else.
 *
 * Recordings are keyed by candidate id, so re-run this after touching the
 * simulation, engine or crew: ids shift and stale overrides would be
 * silently dropped by the worker.
 *
 * usage:
 *   npm run record:voice                          all scenarios, seed 2026
 *   npm run record:voice -- --scenario derby      just one
 *   npm run record:voice -- --limit 3             cap model calls (smoke)
 *
 * The key is read from FEATHERLESS_API_KEY or the gitignored .env.local.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '@floodlight/simulator';
import { featherlessProvider, ProductionCrew, ProviderGateway, type CompletionRequest, type LLMProvider } from '@floodlight/agents';
import { prepareMatch } from '@floodlight/dataset';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(): Map<string, string> {
  const values = new Map<string, string>();
  try {
    for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (match) values.set(match[1]!, match[2]!);
    }
  } catch {
    // .env.local is optional — process env alone may carry the key.
  }
  return values;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

const env = loadEnv();
const apiKey = process.env['FEATHERLESS_API_KEY'] ?? env.get('FEATHERLESS_API_KEY') ?? '';
const model = process.env['FEATHERLESS_MODEL'] ?? env.get('FEATHERLESS_MODEL') ?? 'Qwen/Qwen3-30B-A3B-Instruct-2507';
const seed = Number(argValue('--seed') ?? '2026');
const limit = Number(argValue('--limit') ?? '0');
const only = argValue('--scenario');

if (!apiKey) {
  console.error('no FEATHERLESS_API_KEY in the environment or .env.local');
  process.exit(1);
}

const ids = only ? [only] : SCENARIOS.map((scenario) => scenario.id);
for (const id of ids) {
  if (!SCENARIOS.some((scenario) => scenario.id === id)) {
    console.error(`unknown scenario "${id}" — known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }
}

const outDir = join(root, 'apps/web/public/recordings');
mkdirSync(outDir, { recursive: true });

for (const id of ids) {
  let calls = 0;
  const provider = featherlessProvider(apiKey, model);
  const counter: LLMProvider = {
    id: 'featherless-counted',
    enabled: () => true,
    async complete(request: CompletionRequest) {
      if (limit > 0 && calls >= limit) throw new Error('call limit reached');
      calls++;
      return provider.complete(request);
    },
  };

  const crew = new ProductionCrew({
    gateway: new ProviderGateway([counter]),
    generateVariants: true,
    useLLMCommentary: true,
  });

  console.log(`\n=== ${id} (seed ${seed}${limit > 0 ? `, limit ${limit} calls` : ''}) ===`);
  const prepared = await prepareMatch({
    scenarioId: id,
    seed,
    crew,
    onProgress: (stage, fraction) => {
      if (stage === 'tracking' || stage === 'simulating') process.stdout.write(`\r${stage} ${(fraction * 100).toFixed(0)}%   `);
    },
    onMoment: (moment) => {
      const at = `${moment.candidate.minuteLabel} ${moment.candidate.kind}`.padEnd(24);
      console.log(`\n${moment.candidate.id}  ${at} [${moment.provider}] ${moment.headline}`);
    },
  });

  const moments = prepared.moments.map((moment) => ({
    candidateId: moment.candidate.id,
    headline: moment.headline,
    body: moment.body,
    lang: moment.lang,
    persona: moment.persona,
    ticker: moment.ticker,
    variants: moment.variants,
    provider: moment.provider,
  }));

  const llm = moments.filter((moment) => moment.provider === 'llm').length;
  const recording = { scenarioId: id, seed, provider: 'featherless', model, moments };
  const file = join(outDir, `${id}.json`);
  writeFileSync(file, JSON.stringify(recording, null, 2) + '\n');
  console.log(`\n${id}: ${moments.length} stories — ${llm} studio voice, ${moments.length - llm} template floor — ${calls} model calls — wrote ${file}`);
}

console.log('\nrecorded. re-run after any pipeline change that shifts candidate ids.');
