/**
 * Auto-eventing tests — the pipeline watches a rendered feed for ninety
 * seconds of a real match and must re-derive the football from pixels:
 * passes, a shot, ball and player speeds, and possession.
 */

import { describe, expect, it } from 'vitest';
import { SCENARIOS, simulateMatch } from '@floodlight/simulator';
import {
  analyzeWindow,
  buildReport,
  detectEntities,
  EventDeriver,
  learnPalettes,
  projection,
  renderFeedFrame,
  renderPixels,
  runVisionPass,
  TrackingLayer,
  visionWindowFor,
  homeIdSet,
} from '@floodlight/vision';
import { trackingWindow } from '@floodlight/simulator';

const comeback = () => simulateMatch(2026, SCENARIOS.find((s) => s.id === 'comeback'));

describe('rendered feed + detection', () => {
  it('finds the players and the ball in clean-ish pixels', () => {
    const sim = comeback();
    const frame = renderFeedFrame(sim, 3005, 320, 208);
    const palettes = learnPalettes(frame);
    const entities = detectEntities(frame, { projection: projection(320, 208), palettes });
    const players = entities.filter((e) => e.cls !== 'ball');
    const ball = entities.find((e) => e.cls === 'ball');
    // Contact clusters merge some players into one blob per cluster, but the
    // bulk of the team must be found.
    expect(players.length).toBeGreaterThanOrEqual(14);
    expect(players.length).toBeLessThanOrEqual(32);
    expect(ball).toBeDefined();
    const err = Math.hypot(ball!.x - frame.truth.ball.x, ball!.y - frame.truth.ball.y);
    expect(err).toBeLessThan(1.0);
  });

  it('tracks are stable: speeds within a few km/h of truth', () => {
    const sim = comeback();
    const frames = trackingWindow(sim, 3050, 3060, { hz: 10 });
    const tracker = new TrackingLayer();
    const colors = homeIdSet(sim);
    let palettes = null as ReturnType<typeof learnPalettes> | null;
    let err = 0;
    let n = 0;
    const trail: typeof frames = [];
    for (const tf of frames) {
      if (tf.t < 3051) continue;
      const frame = renderPixels(tf, trail.slice(-3), {
        width: 320,
        height: 208,
        homePrimary: sim.meta.home.primary,
        awayPrimary: sim.meta.away.primary,
        homeIds: colors,
      });
      trail.push(tf);
      if (!palettes) palettes = learnPalettes(frame);
      const entities = detectEntities(frame, { projection: projection(320, 208), palettes });
      const tracks = tracker.update(entities, 0.1).filter((t) => t.cls !== 'ball' && t.age >= 5);
      const ballFrame = frame.truth.ball;
      for (const t of tracks) {
        const truth = frame.truth.players.reduce((best, p) => {
          const d = Math.hypot(p.x - t.x, p.y - t.y);
          return !best || d < best.d ? { d, p } : best;
        }, null as null | { d: number; p: (typeof frame.truth.players)[number] });
        if (truth && truth.d < 1.2) {
          err += Math.abs(t.speedKph - truth.p.speedKph);
          n++;
        }
      }
      void ballFrame;
    }
    expect(n).toBeGreaterThan(100);
    expect(err / n).toBeLessThan(4);
  });

  it('derives a shot from pixels that matches the real shot', () => {
    const sim = comeback();
    const full = runVisionPass(sim);
    const shots = full.events.filter((e) => e.type === 'shot');
    expect(shots.length).toBeGreaterThanOrEqual(1);
    const truthShot = sim.events.find((e) => e.type === 'shot' && Math.abs(e.t - shots[0]!.t) < 1.5);
    expect(truthShot).toBeDefined();
    expect(shots[0]!.speedKph).toBeGreaterThan(58);
  });
});

describe('analysis window report', () => {
  it('reaches honest accuracy on the marquee window', () => {
    const sim = comeback();
    const result = runVisionPass(sim);
    const { report } = result;
    expect(report.framesProcessed).toBeGreaterThan(850);
    expect(report.detected.passes).toBeGreaterThanOrEqual(4);
    expect(report.detected.shots).toBe(report.groundTruth.shots);
    expect(report.passPrecision).toBeGreaterThanOrEqual(0.85);
    expect(report.passRecall).toBeGreaterThanOrEqual(0.3);
    expect(report.passF1).toBeGreaterThanOrEqual(0.5);
    expect(report.ballSpeedMaeKph).toBeLessThan(5);
    expect(report.playerSpeedMaeKph).toBeLessThan(3);
    expect(report.possessionAgreement).toBeGreaterThan(0.75);
  });

  it('is deterministic for the same seed', () => {
    const sim = comeback();
    const a = runVisionPass(sim);
    const b = runVisionPass(sim);
    expect(a.report).toEqual(b.report);
    expect(a.events).toEqual(b.events);
  });

  it('reports samples over the window for the chart', async () => {
    const sim = comeback();
    const result = runVisionPass(sim);
    expect(result.report.samples.length).toBeGreaterThan(80);
    expect(result.report.samples[0]!.t).toBeGreaterThanOrEqual(result.report.window.t0);
  });

  it('the window anchors on a goal after the fortieth minute', () => {
    const sim = comeback();
    const window = visionWindowFor(sim);
    expect(window.t1 - window.t0).toBe(90);
    const goal = sim.events.find(
      (e) => e.type === 'shot' && (e as { outcome: string }).outcome === 'goal' && e.t > 40 * 60,
    );
    expect(goal).toBeDefined();
    expect(goal!.t).toBeGreaterThanOrEqual(window.t0);
  });

  it('the deriver never invents a shot from a slow ball', () => {
    const deriver = new EventDeriver();
    // A ball creeping through midfield with a player beside it.
    const ball = { id: 99, cls: 'ball' as const, x: 0, y: 0, vx: 0, vy: 0, speedKph: 8, age: 30, missed: 0 };
    const player = { id: 1, cls: 'home' as const, x: 1, y: 0, vx: 0, vy: 0, speedKph: 4, age: 30, missed: 0 };
    for (let t = 0; t < 6; t += 0.1) {
      ball.x += 0.2;
      player.x = ball.x + 1;
      deriver.update(t, ball, [player]);
    }
    expect(deriver.all().filter((e) => e.type === 'shot')).toHaveLength(0);
  });

  it('analysis is tunable — a coarse pass tracks possession like the fine pass', () => {
    const sim = comeback();
    // A contact-heavy stretch; both rates find it hard.
    const window = { t0: 3000, t1: 3040 };
    const fine = buildReport(sim, analyzeWindow(sim, { ...window, hz: 10, warmupS: 20 }), window);
    const coarse = buildReport(sim, analyzeWindow(sim, { ...window, hz: 5, warmupS: 20 }), window);
    expect(fine.possessionAgreement).toBeGreaterThan(0.8);
    expect(coarse.possessionAgreement).toBeGreaterThan(0.65);
    // Half the sample rate costs a little ownership fidelity; the two runs
    // must stay in the same band rather than collapse — the pipeline is not
    // overfitted to one frame rate.
    expect(Math.abs(coarse.possessionAgreement - fine.possessionAgreement)).toBeLessThan(0.15);
  });
});
