/**
 * Commentator audio renderer.
 *
 * Turns every recorded studio-voice line into an actual audio clip with a
 * neural voice (edge-tts, free) so the broadcast plays a real commentator
 * instead of the flat system voice. Big moments — goals, penalties, cards,
 * late drama — are delivered faster, like a commentator raising his voice.
 *
 *   tsx tools/render-voice-audio.ts
 *
 * Output: apps/web/public/recordings/audio/<scenario>/<candidateId>.mp3
 * Text matches exactly what the app speaks: the first clause of the
 * headline (see spokenLine in ProgramMonitor — keep the two in sync).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VOICE = process.env['COMMENTARY_VOICE'] ?? 'en-GB-RyanNeural';

const BIG_KINDS = new Set(['goal', 'penalty', 'red_card', 'var_overturn', 'comeback_trigger', 'late_drama']);

function spokenLine(headline: string): string {
  const first = headline.split(',')[0]?.trim() ?? headline;
  return first.length >= 12 ? first : headline;
}

const scenarios = ['comeback', 'siege', 'derby', 'freeplay'];
let rendered = 0;

for (const scenario of scenarios) {
  const recording = JSON.parse(readFileSync(join(root, 'apps/web/public/recordings', `${scenario}.json`), 'utf8')) as {
    moments: Array<{ candidateId: string; headline: string }>;
  };
  const kindsById = new Map<string, string>();
  const snapshot = readFileSync(join(root, 'data', `${scenario}-2026/moments.jsonl`), 'utf8').trim().split('\n');
  for (const line of snapshot) {
    const moment = JSON.parse(line) as { candidate: { id: string; kind: string } };
    kindsById.set(moment.candidate.id, moment.candidate.kind);
  }

  const outDir = join(root, 'apps/web/public/recordings/audio', scenario);
  mkdirSync(outDir, { recursive: true });

  for (const moment of recording.moments) {
    const text = spokenLine(moment.headline);
    const big = BIG_KINDS.has(kindsById.get(moment.candidateId) ?? '');
    const rate = big ? '+13%' : '+8%';
    const file = join(outDir, `${moment.candidateId}.mp3`);
    execFileSync(
      'python',
      ['-m', 'edge_tts', '--voice', VOICE, '--rate', rate, '--text', text, '--write-media', file],
      { stdio: 'pipe' },
    );
    rendered++;
    console.log(`${scenario}/${moment.candidateId} ${big ? '[big]' : '     '} ${text}`);
  }
}

console.log(`\nrendered ${rendered} commentary clips with ${VOICE}`);
