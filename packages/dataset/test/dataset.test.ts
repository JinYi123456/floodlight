/**
 * The dataset exporters must be boring and exact: same seed, same bytes;
 * CSV that survives headline copy; a data card that tells the whole story.
 */

import { describe, expect, it } from 'vitest';
import { prepareMatch } from '../src/pipeline';
import {
  buildDataCard,
  csvEscape,
  eventsCsv,
  exportMatch,
  matchJson,
  momentsCsv,
  playersCsv,
  toCsv,
  toJsonl,
} from '../src/exporters';

const prepared = await prepareMatch({ scenarioId: 'comeback', seed: 2026 });

describe('prepareMatch', () => {
  it('runs the whole pipeline and finds the authored story', async () => {
    expect(prepared.scenario?.id).toBe('comeback');
    expect(prepared.simulation.events.length).toBeGreaterThan(500);
    // The insight feed is a distillation, not a mirror: far fewer candidates than events.
    expect(prepared.candidates.length).toBeGreaterThan(15);
    expect(prepared.candidates.length).toBeLessThan(prepared.simulation.events.length / 20);
    expect(prepared.moments.length).toBeGreaterThan(4);
    expect(prepared.cues.cues.length).toBeGreaterThan(0);
    const goals = prepared.simulation.events.filter((event) => event.type === 'shot' && (event as { outcome?: string }).outcome === 'goal');
    expect(goals.length).toBe(5);
  });

  it('is deterministic end to end', async () => {
    const again = await prepareMatch({ scenarioId: 'comeback', seed: 2026 });
    expect(JSON.stringify(again.simulation.events)).toBe(JSON.stringify(prepared.simulation.events));
    expect(JSON.stringify(again.candidates)).toBe(JSON.stringify(prepared.candidates));
    expect(JSON.stringify(again.moments)).toBe(JSON.stringify(prepared.moments));
    expect(JSON.stringify(again.cues)).toBe(JSON.stringify(prepared.cues));
  });

  it('rejects unknown scenarios by name', async () => {
    await expect(prepareMatch({ scenarioId: 'nope', seed: 1 })).rejects.toThrow('unknown scenario: nope');
  });
});

describe('serialisation', () => {
  it('escapes commas, quotes and newlines in CSV cells', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('two\nlines')).toBe('"two\nlines"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('writes one JSON object per line', () => {
    const lines = toJsonl([{ a: 1 }, { b: 'x' }]).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({ b: 'x' });
    expect(toJsonl([])).toBe('');
  });

  it('keeps the requested column order even for empty rows', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b\n');
  });
});

describe('exports', () => {
  const data = exportMatch(prepared);

  it('exports events in both fidelities with the same row count', () => {
    const csv = eventsCsv(data.events);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(data.events.length + 1);
    expect(lines[0]).toContain('ballSpeedKph');
    expect(csv).toContain('ballSpeedKph');
  });

  it('exports stories with their verification verdict intact', () => {
    const csv = momentsCsv(data.moments);
    const dataLines = csv.trimEnd().split('\n').slice(1);
    expect(dataLines).toHaveLength(data.moments.length);
    expect(csv.split('\n')[0]).toContain('headline');
    // Every exported story cleared the verifier.
    expect(data.moments.every((moment) => moment.verification.approved)).toBe(true);
  });

  it('exports one player row per squad member', () => {
    expect(playersCsv(data.players).trimEnd().split('\n')).toHaveLength(data.players.length + 1);
  });

  it('summarises the match in match.json', () => {
    const summary = JSON.parse(matchJson(data)) as {
      counts: Record<string, number>;
      finalScore: { home: number; away: number };
    };
    expect(summary.counts['events']).toBe(data.events.length);
    expect(summary.counts['moments']).toBe(data.moments.length);
    expect(summary.finalScore.home + summary.finalScore.away).toBe(5);
  });

  it('carries provenance, counts and the regeneration command in the data card', () => {
    const card = buildDataCard(data);
    expect(card).toContain('# Data card — ');
    expect(card).toContain('synthetic');
    expect(card).toContain('npm run export:dataset');
    expect(card).toContain('| `events.jsonl` | JSONL | ' + data.events.length);
    expect(card).toContain('| `cues.json` | JSON | ' + data.cues.cues.length);
    expect(card).toContain('## Event stream composition');
    expect(card).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no wall-clock stamps: byte-stable exports
  });
});
