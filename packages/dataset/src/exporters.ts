/**
 * Dataset writers — a finished pipeline run as portable files.
 *
 * Two fidelities per stream: JSONL carries every field exactly as the
 * pipeline produced it, CSV offers a flat, spreadsheet-friendly view. No
 * wall-clock timestamps are written anywhere: same scenario and seed, same
 * bytes.
 */

import type { MatchEvent } from '@floodlight/core';
import type { InsightCandidate, PlayerMatchStats, TeamMatchStats } from '@floodlight/engine';
import type { NarratedMoment } from '@floodlight/agents';
import type { CueSheet } from '@floodlight/cuesheet';
import type { PreparedPipeline } from './pipeline';

export interface ExportedMatch {
  scenario: { id: string; name: string; tagline: string } | null;
  seed: number;
  meta: PreparedPipeline['simulation']['meta'];
  timing: { halfTimeT: number; fullTimeT: number };
  finalScore: { home: number; away: number };
  teamStats: { home: TeamMatchStats; away: TeamMatchStats };
  events: MatchEvent[];
  candidates: InsightCandidate[];
  moments: NarratedMoment[];
  cues: CueSheet;
  players: PlayerMatchStats[];
}

export function exportMatch(prepared: PreparedPipeline): ExportedMatch {
  const state = prepared.engine.snapshot();
  const { simulation } = prepared;
  return {
    scenario: prepared.scenario ? { id: prepared.scenario.id, name: prepared.scenario.name, tagline: prepared.scenario.tagline } : null,
    seed: prepared.seed,
    meta: simulation.meta,
    timing: { halfTimeT: simulation.timing.halfTimeT, fullTimeT: simulation.timing.fullTimeT },
    finalScore: { home: state.score.home, away: state.score.away },
    teamStats: { home: state.teams.home, away: state.teams.away },
    events: simulation.events,
    candidates: prepared.candidates,
    moments: prepared.moments,
    cues: prepared.cues,
    players: state.players,
  };
}

export function matchJson(data: ExportedMatch): string {
  return (
    JSON.stringify(
      {
        scenario: data.scenario,
        seed: data.seed,
        meta: data.meta,
        timing: data.timing,
        finalScore: data.finalScore,
        teamStats: data.teamStats,
        counts: {
          events: data.events.length,
          candidates: data.candidates.length,
          moments: data.moments.length,
          cues: data.cues.cues.length,
          players: data.players.length,
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/* --------------------------- serialisation --------------------------- */

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  const cols = columns ?? (rows.length > 0 ? Object.keys(rows[0]!) : []);
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((column) => csvEscape(row[column])).join(','));
  return lines.join('\n') + '\n';
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/* ----------------------------- projections ---------------------------- */

const EVENT_COLUMNS = [
  'id', 'index', 't', 'minute', 'period', 'type', 'team', 'playerId',
  'x', 'y', 'endX', 'endY', 'outcome', 'lengthM', 'angleDeg', 'height',
  'xg', 'ballSpeedKph', 'difficulty', 'xtSwing', 'progressive', 'lineBreak',
  'underPressure', 'bigChance', 'isPenalty', 'recipientId', 'assistPlayerId',
  'card', 'reason', 'foulType', 'opponentId', 'duelType',
];

export function eventsCsv(events: MatchEvent[]): string {
  const rows = events.map((event) => {
    const e = event as unknown as Record<string, unknown>;
    return {
      id: e['id'], index: e['index'], t: e['t'], minute: Math.floor((e['t'] as number) / 60), period: e['period'],
      type: e['type'], team: e['team'], playerId: e['playerId'],
      x: e['at'] ? (e['at'] as { x: number }).x : null, y: e['at'] ? (e['at'] as { y: number }).y : null,
      endX: e['endAt'] ? (e['endAt'] as { x: number }).x : null, endY: e['endAt'] ? (e['endAt'] as { y: number }).y : null,
      outcome: e['outcome'] ?? e['tackleOutcome'] ?? null,
      lengthM: e['lengthM'] ?? null, angleDeg: e['angleDeg'] ?? null, height: e['height'] ?? null,
      xg: e['xg'] ?? null, ballSpeedKph: e['ballSpeedKph'] ?? null, difficulty: e['difficulty'] ?? null,
      xtSwing: e['xtSwing'] ?? null, progressive: e['progressive'] ?? null, lineBreak: e['lineBreak'] ?? null,
      underPressure: e['underPressure'] ?? null, bigChance: e['bigChance'] ?? null, isPenalty: e['isPenalty'] ?? null,
      recipientId: e['recipientId'] ?? e['intendedRecipientId'] ?? null, assistPlayerId: e['assistPlayerId'] ?? null,
      card: e['card'] ?? null, reason: e['reason'] ?? null, foulType: e['foulType'] ?? null,
      opponentId: e['opponentId'] ?? null, duelType: e['duelType'] ?? null,
    };
  });
  return toCsv(rows, EVENT_COLUMNS);
}

const MOMENT_COLUMNS = [
  'candidateId', 't', 'minute', 'kind', 'salience', 'team', 'playerId', 'priority', 'airReason',
  'slots', 'ttlSeconds', 'headline', 'body', 'lang', 'persona', 'provider', 'ticker', 'verified',
  'issues', 'evidenceEventIds', 'facts',
];

export function momentsCsv(moments: NarratedMoment[]): string {
  const rows = moments.map((moment) => ({
    candidateId: moment.candidate.id,
    t: moment.candidate.t,
    minute: Math.floor(moment.candidate.t / 60),
    kind: moment.candidate.kind,
    salience: moment.candidate.salience,
    team: moment.candidate.team,
    playerId: moment.candidate.playerId,
    priority: moment.air.priority,
    airReason: moment.air.reason,
    slots: moment.air.slots.join(';'),
    ttlSeconds: moment.air.ttlSeconds,
    headline: moment.headline,
    body: moment.body,
    lang: moment.lang,
    persona: moment.persona,
    provider: moment.provider,
    ticker: moment.ticker,
    verified: moment.verification.approved,
    issues: moment.verification.issues.join(';'),
    evidenceEventIds: moment.candidate.evidenceEventIds.join(';'),
    facts: moment.candidate.facts,
  }));
  return toCsv(rows, MOMENT_COLUMNS);
}

const PLAYER_COLUMNS = [
  'playerId', 'name', 'shirt', 'team', 'role', 'goals', 'assists', 'shots', 'xg', 'passes',
  'passesCompleted', 'keyPasses', 'progressivePasses', 'xtGenerated', 'carries', 'tackles',
  'interceptions', 'foulsCommitted', 'yellowCards', 'redCards', 'touches', 'distanceKm',
  'topSpeedKph', 'sprints', 'duelsWon',
];

export function playersCsv(players: PlayerMatchStats[]): string {
  return toCsv(players as unknown as Array<Record<string, unknown>>, PLAYER_COLUMNS);
}

/* ------------------------------ data card ----------------------------- */

function histogram(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function table(rows: Array<[string, number]>): string {
  return ['| value | rows |', '| --- | ---: |', ...rows.map(([value, count]) => `| ${value} | ${count} |`)].join('\n');
}

export function buildDataCard(data: ExportedMatch): string {
  const home = data.meta.home.name;
  const away = data.meta.away.name;
  const scenarioLine = data.scenario
    ? `Story scenario: **${data.scenario.name}** (\`${data.scenario.id}\`) — ${data.scenario.tagline}`
    : 'Story scenario: none — free play, pure seeded stochastic simulation.';

  return `# Data card — ${home} vs ${away}

${scenarioLine}

Seed: \`${data.seed}\` · competition: ${data.meta.competition} · venue: ${data.meta.venue.name}, ${data.meta.venue.city}
Final score: ${data.finalScore.home}–${data.finalScore.away} · match id: \`${data.meta.id}\`

## Provenance

Every row in this export is **synthetic**. There are no real match records, no real
player names and no real club identities anywhere in it: the clubs, squads, venues and
officials are fictional, and the event stream is a seeded stochastic simulation with
authored narrative directives on top. Nothing was scraped, licensed or derived from
real football data.

The run is deterministic. The same scenario and seed produce byte-identical files —
there are no timestamps, no random ids and no machine-dependent values inside.
Regenerate with:

\`\`\`sh
npm run export:dataset -- --scenario ${data.scenario?.id ?? 'freeplay'} --seed ${data.seed} --out data
\`\`\`

## Files

| file | format | rows | notes |
| --- | --- | ---: | --- |
| \`match.json\` | JSON | 1 | meta, timing, final score, team stats, record counts |
| \`events.jsonl\` | JSONL | ${data.events.length} | the raw match event stream, every field as produced |
| \`events.csv\` | CSV | ${data.events.length} | flat view of the same stream; type-specific columns are empty where they do not apply |
| \`candidates.jsonl\` | JSONL | ${data.candidates.length} | the insight feed after interpretation — one candidate per line, with supporting evidence ids |
| \`moments.jsonl\` | JSONL | ${data.moments.length} | candidates that passed direction, with verified story copy |
| \`moments.csv\` | CSV | ${data.moments.length} | flat view of the same stories |
| \`players.csv\` | CSV | ${data.players.length} | per-player match stats (distance, top speed, sprints, xG, xT) |
| \`cues.json\` | JSON | ${data.cues.cues.length} | the compiled cue sheet — timed broadcast graphics with slots and expiry |
| \`DATA_CARD.md\` | MD | 1 | this file |

## Conventions

- Times are match seconds from kickoff (period 1 starts at 0); minute 45+ wraps through half-time.
- Positions are metres on a 105×68 pitch, origin at the centre spot, home attacks toward +x in the first half.
- Speeds are km/h, distances km (players) or metres (events). xG and xT are model outputs of this pipeline, not third-party numbers.
- \`provider\` on a story is \`template\` when the deterministic crew wrote it and \`llm\` when the recorded studio voice was applied.

## Event stream composition

${table(histogram(data.events.map((event) => event.type)))}

## Stories aired

${table(histogram(data.moments.map((moment) => moment.candidate.kind)))}

## Cue sheet slots

${table(histogram(data.cues.cues.map((cue) => cue.slot)))}

## Usage

Exports are covered by the repository license (MIT). If you build on this data,
credit the project and keep the synthetic provenance visible — do not present it
as a record of real matches.
`;
}
