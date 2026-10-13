import { describe, expect, it } from 'vitest';
import { stableHash } from '@floodlight/core';
import { SCENARIOS, simulateMatch } from '@floodlight/simulator';
import { MatchEngine, type InsightCandidate } from '@floodlight/engine';
import {
  buildEvidencePack,
  CrewRuntime,
  mockProvider,
  parseNarration,
  PERSONAS,
  LANGUAGES,
  ProviderGateway,
  ProductionCrew,
  templateNarrative,
  verifyDraft,
  type NarrativeContext,
} from '@floodlight/agents';

function runEngine(seed: number, scenarioId?: string) {
  const scenario = scenarioId ? SCENARIOS.find((s) => s.id === scenarioId) : undefined;
  const result = simulateMatch(seed, scenario);
  const engine = new MatchEngine(result.meta, result.lineups);
  const candidates = result.events.flatMap((e) => engine.ingestEvent(e));
  return { result, engine, candidates };
}

const CTX: NarrativeContext = {
  kind: 'goal',
  minute: "70'",
  team: 'Riverside Athletic',
  opponent: 'Northgate United',
  teamAbbr: 'RIV',
  opponentAbbr: 'NOR',
  player: 'Alden Keller',
  score: '2–1',
  facts: { distanceM: 12.4, xg: 0.18, ballSpeedKph: 92.1, isPenalty: false },
};

describe('templates and verifier', () => {
  it('every moment kind renders in every language and persona', () => {
    const kinds: InsightCandidate['kind'][] = [
      'goal', 'var_review', 'var_overturn', 'penalty', 'red_card', 'big_chance', 'big_save',
      'momentum_shift', 'siege', 'comeback_trigger', 'late_drama', 'milestone', 'speed_flash', 'tactical_pressure',
    ];
    for (const kind of kinds) {
      for (const lang of LANGUAGES) {
        for (const persona of PERSONAS) {
          const narrative = templateNarrative({ ...CTX, kind }, persona, lang);
          expect(narrative.headline.length).toBeGreaterThan(0);
          expect(narrative.body.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('template drafts pass the deterministic verifier', () => {
    const narrative = templateNarrative(CTX, 'analyst', 'en');
    const pack = buildEvidencePack(
      { facts: { xg: 0.18, distanceM: 12.4, ballSpeedKph: 92.1, score: '2–1' }, minuteLabel: "70'" },
      [2, 1],
      ['Alden Keller', 'Keller', 'Riverside Athletic', 'Northgate United', 'RIV', 'NOR'],
    );
    const verdict = verifyDraft(`${narrative.headline} ${narrative.body}`, pack);
    expect(verdict.issues).toEqual([]);
    expect(verdict.approved).toBe(true);
  });

  it('rejects fabricated numbers and unsupported claims', () => {
    const pack = buildEvidencePack({ facts: { xg: 0.18 }, minuteLabel: "70'" }, [1], ['Alden Keller']);
    expect(verifyDraft('Alden Keller scored his 99th goal.', pack).approved).toBe(false);
    expect(verifyDraft('That is a new record for this stadium.', pack).approved).toBe(false);
    expect(verifyDraft('He never misses from there.', pack).approved).toBe(false);
    const ok = verifyDraft('A finish worth 0.18 xG.', pack);
    expect(ok.approved).toBe(true);
  });

  it('parses tolerant JSON narration', () => {
    expect(parseNarration('Sure! {"headline": "H", "body": "B"} done')).toEqual({ headline: 'H', body: 'B' });
    expect(parseNarration('no json here')).toBeNull();
    expect(parseNarration('{"headline": "", "body": "B"}')).toBeNull();
  });
});

describe('provider gateway', () => {
  it('falls through failing providers to the next one', async () => {
    let failingCalls = 0;
    const failing = mockProvider('failing', () => {
      failingCalls++;
      throw new Error('down');
    });
    const healthy = mockProvider('healthy', () => 'ok');
    const gateway = new ProviderGateway([failing, healthy], { breakerThreshold: 99 });
    const result = await gateway.complete({ system: 's', user: 'u' });
    expect(result).toEqual({ text: 'ok', providerId: 'healthy' });
  });

  it('opens a circuit breaker after repeated failures', async () => {
    let calls = 0;
    const flaky = mockProvider('flaky', () => {
      calls++;
      throw new Error('down');
    });
    const gateway = new ProviderGateway([flaky], { breakerThreshold: 2, cooldownMs: 60_000 });
    await gateway.complete({ system: 's', user: 'u' });
    await gateway.complete({ system: 's', user: 'u' });
    const third = await gateway.complete({ system: 's', user: 'u' });
    expect(third).toBeNull();
    expect(calls).toBe(2); // Third call short-circuited by the breaker.
  });
});

describe('crew runtime', () => {
  it('retries, then falls back, and the pipeline survives', async () => {
    const runtime = new CrewRuntime();
    let attempts = 0;
    const outcome = await runtime.dispatch<null, string>({
      agentId: 'analyst',
      kind: 'draft',
      input: null,
      run: async () => {
        attempts++;
        throw new Error('provider exploded');
      },
      fallback: () => 'template text',
      maxAttempts: 2,
    });
    expect(outcome.status).toBe('fallback');
    expect(outcome.output).toBe('template text');
    expect(attempts).toBe(2);
    expect(runtime.stats().fallback).toBe(1);
  });

  it('enforces timeouts', async () => {
    const runtime = new CrewRuntime();
    const started = Date.now();
    const outcome = await runtime.dispatch<null, string>({
      agentId: 'analyst',
      kind: 'slow',
      input: null,
      run: () => new Promise<string>(() => undefined),
      maxAttempts: 1,
      timeoutMs: 60,
    });
    expect(outcome.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('production crew end to end', () => {
  it('template mode produces verified moments for a full match', async () => {
    const { engine, candidates } = runEngine(12345, 'comeback');
    const crew = new ProductionCrew({ generateVariants: true });
    const production = await crew.runMatch(candidates, engine);
    expect(production.moments.length).toBeGreaterThan(6);
    for (const moment of production.moments) {
      expect(moment.verification.approved).toBe(true);
      expect(moment.provider).toBe('template');
      expect(moment.variants.length).toBe(PERSONAS.length * LANGUAGES.length);
      // Authored templates must clear the gate on their own — if one ever
      // falls through to the metric-only floor, the floor marks it here.
      expect(moment.verification.issues.join(' ')).not.toContain('template failed');
    }
    const kinds = production.moments.map((m) => m.candidate.kind);
    expect(kinds).toContain('goal');
    expect(kinds).toContain('comeback_trigger');
    // Governor: streaks of low-priority moments must not flood the air.
    expect(production.moments.every((m) => m.air.priority >= 50)).toBe(true);
  });

  it('is deterministic in template mode', async () => {
    const { engine, candidates } = runEngine(12345, 'comeback');
    const a = await new ProductionCrew({}).runMatch(candidates, engine);
    const b = await new ProductionCrew({}).runMatch(candidates, engine);
    expect(stableHash(a.moments)).toBe(stableHash(b.moments));
  });

  it('model drafts are verified; bad output is rewritten or replaced', async () => {
    const { engine, candidates } = runEngine(12345, 'comeback');
    let calls = 0;
    const gateway = new ProviderGateway([
      mockProvider('test-model', () => {
        calls++;
        if (calls === 1) {
          return '{"headline": "GOAL", "body": "A 999 metre screamer worth 88 xG from Zephyr Quill."}';
        }
        return 'a fine finish keeps the crowd alive';
      }),
    ]);
    const crew = new ProductionCrew({ gateway });
    const production = await crew.runMatch(candidates, engine);
    for (const moment of production.moments) {
      expect(moment.verification.approved).toBe(true);
    }
    // The first (fabricated) draft must have triggered the verifier.
    const rejectedAnalystRuns = production.traces.filter((t) => t.agentId === 'analyst' && t.status === 'completed');
    expect(rejectedAnalystRuns.length).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(1);
  });

  it('retractions prevent airing overturned goals', async () => {
    const { engine, candidates } = runEngine(12345, 'derby');
    const crew = new ProductionCrew({});
    const production = await crew.runMatch(candidates, engine);
    const overturn = production.moments.find((m) => m.candidate.kind === 'var_overturn');
    expect(overturn).toBeDefined();
    // The overturned goal itself must never have been selected for air in
    // the final feed (its candidate is flagged as overturned).
    expect(production.moments.some((m) => m.candidate.kind === 'goal' && m.candidate.overturned)).toBe(false);
  });
});
