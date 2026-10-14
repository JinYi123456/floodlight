import { describe, expect, it } from 'vitest';
import { MatchService, liveFacts } from '@floodlight/dataservice';
import { MatchEngine } from '@floodlight/engine';
import { SCENARIOS, simulateMatch } from '@floodlight/simulator';

describe('match data service', () => {
  const service = new MatchService();

  it('lists the four scenarios with their clubs', () => {
    const rows = service.listScenarios();
    expect(rows.map((r) => r.id)).toEqual(['comeback', 'siege', 'derby', 'freeplay']);
    expect(rows[0]!.home.name.length).toBeGreaterThan(2);
  });

  it('prepares a match once and serves consistent counts', async () => {
    const summary = await service.prepare('comeback', 2026);
    expect(summary.finalScore.home + summary.finalScore.away).toBeGreaterThan(0);
    expect(summary.counts.events).toBeGreaterThan(1000);
    expect(summary.counts.stories).toBeGreaterThan(10);
    const again = await service.prepare('comeback', 2026);
    expect(again.matchId).toBe(summary.matchId);
  });

  it('reduces the state at a past minute like the scoreboard did', async () => {
    const full = await service.prepare('comeback', 2026);
    const firstHalf = await service.stateAt('comeback', 2026, 2700);
    const shots = firstHalf.shots.home + firstHalf.shots.away;
    expect(shots).toBeGreaterThan(0);
    expect(shots).toBeLessThanOrEqual(full.counts.events);
    expect(firstHalf.possessionShare.home + firstHalf.possessionShare.away).toBeCloseTo(1, 2);
    expect(firstHalf.period).toBe(1);
  });

  it('answers event, moment and player queries', async () => {
    const shots = await service.queryEvents('derby', 2026, { type: 'shot', limit: 5 });
    expect(shots.length).toBe(5);
    const goals = await service.queryMoments('derby', 2026, 'goal');
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0]!.verified).toBe(true);
    const players = await service.playerStats('derby', 2026, 'bergqvist');
    expect(players.length).toBeGreaterThan(0);
  });

  it('serves the cue sheet and the vision report', async () => {
    const cues = await service.cueSheet('siege', 2026);
    expect(cues.cues.length).toBeGreaterThan(20);
    const vision = await service.visionPass('comeback', 2026);
    expect(vision.report.framesProcessed).toBeGreaterThan(800);
    expect(vision.derivedEvents).toBeGreaterThan(0);
  }, 60_000);

  it('exposes live facts with the same numbers as the engine', async () => {
    const sim = simulateMatch(2026, SCENARIOS.find((s) => s.id === 'comeback'));
    const engine = new MatchEngine(sim.meta, sim.lineups);
    for (const event of sim.events) engine.ingestEvent(event);
    const facts = liveFacts(engine);
    const snapshot = await facts.snapshot();
    const direct = engine.snapshot();
    expect(snapshot.score).toEqual(direct.score);
    expect(snapshot.players.length).toBe(direct.players.length);
    const at = await facts.scoreAt(1000);
    expect(at).toEqual(engine.scoreAt(1000));
    const features = await facts.windowFeatures(0, 600);
    expect(features.minutes).toBe(engine.windowFeatures(0, 600).minutes);
  });
});
