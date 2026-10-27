import { describe, expect, it } from 'vitest';
import { stableHash } from '@floodlight/core';
import { SCENARIOS, simulateMatch } from '@floodlight/simulator';
import { MatchEngine } from '@floodlight/engine';
import { ProductionCrew, type NarratedMoment } from '@floodlight/agents';
import { compileCues, CUESHEET_JSON_SCHEMA, validateCueSheet, type Cue } from '@floodlight/cuesheet';

async function fullPipeline(seed: number, scenarioId: string) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const result = simulateMatch(seed, scenario);
  const engine = new MatchEngine(result.meta, result.lineups);
  const candidates = result.events.flatMap((e) => engine.ingestEvent(e));
  const crew = new ProductionCrew({});
  const production = await crew.runMatch(candidates, engine);
  const events = new Map(result.events.map((e) => [e.id, e]));
  const sheet = compileCues(production.moments, result.meta, { events });
  return { result, production, sheet };
}

describe('cue sheet compiler', () => {
  it('compiles a valid, sorted sheet from a full match', async () => {
    const { sheet } = await fullPipeline(12345, 'comeback');
    expect(sheet.version).toBe('1.0');
    expect(sheet.cues.length).toBeGreaterThan(10);
    expect(validateCueSheet(sheet)).toEqual([]);
    for (let i = 1; i < sheet.cues.length; i++) {
      expect(sheet.cues[i]!.t0).toBeGreaterThanOrEqual(sheet.cues[i - 1]!.t0);
    }
  });

  it('goals air a goal flash and a lower third with evidence attached', async () => {
    const { sheet } = await fullPipeline(12345, 'comeback');
    const flashes = sheet.cues.filter((c) => c.slot === 'goal_flash');
    expect(flashes.length).toBeGreaterThanOrEqual(3);
    const thirds = sheet.cues.filter((c) => c.slot === 'lower_third' && c.source.verified);
    expect(thirds.length).toBeGreaterThan(3);
    for (const cue of thirds) {
      expect(cue.payload['headline']).toBeTypeOf('string');
      expect(cue.payload['body']).toBeTypeOf('string');
    }
  });

  it('telestration cues carry pitch geometry from evidence', async () => {
    const { sheet } = await fullPipeline(12345, 'derby');
    const telestrations = sheet.cues.filter((c) => c.slot === 'telestration');
    expect(telestrations.length).toBeGreaterThan(0);
    for (const cue of telestrations) {
      expect(cue.payload['from']).not.toBeNull();
    }
  });

  it('is deterministic for identical inputs', async () => {
    const a = await fullPipeline(777, 'siege');
    const b = await fullPipeline(777, 'siege');
    expect(stableHash(a.sheet)).toBe(stableHash(b.sheet));
  });

  it('drops stories that went stale before airtime', () => {
    const moment = (id: string, t: number, priority: number, ttl: number, slots: string[]): NarratedMoment =>
      ({
        candidate: {
          id,
          t,
          minuteLabel: `${Math.floor(t / 60)}'`,
          kind: 'big_chance',
          salience: 0.6,
          team: 'home',
          playerId: null,
          facts: { xg: 0.3 },
          evidenceEventIds: [],
          window: null,
          provisional: false,
          overturned: false,
        },
        air: { air: true, reason: 'selected', priority, ttlSeconds: ttl, slots },
        headline: 'H',
        body: 'B',
        lang: 'en',
        persona: 'analyst',
        provider: 'template',
        source: 'template',
        ticker: null,
        tickerSource: null,
        verification: { approved: true, issues: [], basis: 'evidence_bound' },
        variants: [],
      }) as NarratedMoment;

    const meta = simulateMatch(1).meta;
    // A long live telestration blocks the slot; a stale short-lived chance
    // cannot wait for it and must be dropped, while a high-priority cue
    // preempts it instead.
    const sheet = compileCues(
      [moment('m1', 100, 55, 300, ['telestration']), moment('m2', 102, 55, 4, ['telestration']), moment('m3', 104, 90, 60, ['telestration'])],
      meta,
    );
    const ids = sheet.cues.map((c) => c.source.momentId);
    expect(ids).toContain('m1');
    expect(ids).not.toContain('m2'); // stale
    expect(ids).toContain('m3'); // preempted in
    const m3 = sheet.cues.find((c) => c.source.momentId === 'm3')!;
    const m1 = sheet.cues.find((c) => c.source.momentId === 'm1')!;
    expect(m1.t1).toBeLessThanOrEqual(m3.t0); // truncated, not overlapping
    expect(validateCueSheet(sheet)).toEqual([]);
  });

  it('exposes a schema for graphics partners', () => {
    expect(CUESHEET_JSON_SCHEMA['title']).toBe('Floodlight Cue Sheet');
    const cueProps = (CUESHEET_JSON_SCHEMA['properties'] as Record<string, { items?: { required: string[] } }>)['cues'];
    expect(cueProps.items?.required).toContain('payload');
  });
});

describe('cue sheet slot sanity at scale', () => {
  it('no slot is ever double-booked across a whole match', async () => {
    const { sheet } = await fullPipeline(2024, 'derby');
    const bySlot = new Map<string, Cue[]>();
    for (const cue of sheet.cues) {
      const list = bySlot.get(cue.slot) ?? [];
      list.push(cue);
      bySlot.set(cue.slot, list);
    }
    for (const [slot, cues] of bySlot) {
      if (slot === 'goal_flash') continue;
      const sorted = [...cues].sort((a, b) => a.t0 - b.t0);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.t0, `${slot} overlap`).toBeGreaterThanOrEqual(sorted[i - 1]!.t1);
      }
    }
  });
});
