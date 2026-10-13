/**
 * Export datasets for every scenario — `npm run export:dataset`.
 *
 * usage: tsx packages/dataset/src/cli.ts [--scenario id|all] [--seed n] [--out dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from '@floodlight/simulator';
import { prepareMatch } from './pipeline';
import { buildDataCard, eventsCsv, exportMatch, matchJson, momentsCsv, playersCsv, toJsonl } from './exporters';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

async function main(): Promise<void> {
  const scenarioArg = argValue('--scenario') ?? 'all';
  const seed = Number(argValue('--seed') ?? '2026');
  const outRoot = argValue('--out') ?? 'data';

  const ids = scenarioArg === 'all' ? SCENARIOS.map((scenario) => scenario.id) : [scenarioArg];
  for (const id of ids) {
    if (!SCENARIOS.some((scenario) => scenario.id === id)) {
      console.error(`unknown scenario "${id}" — known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  for (const id of ids) {
    const prepared = await prepareMatch({ scenarioId: id, seed });
    const data = exportMatch(prepared);
    const dir = join(outRoot, `${id}-${seed}`);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'match.json'), matchJson(data));
    writeFileSync(join(dir, 'events.jsonl'), toJsonl(data.events));
    writeFileSync(join(dir, 'events.csv'), eventsCsv(data.events));
    writeFileSync(join(dir, 'candidates.jsonl'), toJsonl(data.candidates));
    writeFileSync(join(dir, 'moments.jsonl'), toJsonl(data.moments));
    writeFileSync(join(dir, 'moments.csv'), momentsCsv(data.moments));
    writeFileSync(join(dir, 'players.csv'), playersCsv(data.players));
    writeFileSync(join(dir, 'cues.json'), JSON.stringify(data.cues, null, 2) + '\n');
    writeFileSync(join(dir, 'DATA_CARD.md'), buildDataCard(data));

    console.log(
      `${id.padEnd(9)} ${data.finalScore.home}–${data.finalScore.away}  ` +
        `${String(data.events.length).padStart(5)} events  ${String(data.candidates.length).padStart(4)} candidates  ` +
        `${String(data.moments.length).padStart(3)} stories  ${String(data.cues.cues.length).padStart(3)} cues  -> ${dir}`,
    );
  }
}

await main();
