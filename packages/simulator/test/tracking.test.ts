import { describe, expect, it } from 'vitest';
import { stableHash } from '@floodlight/core';
import { simulateMatch, trackingWindow } from '@floodlight/simulator';

describe('tracking generation', () => {
  const result = simulateMatch(12345);

  it('produces 10 frames per second over the requested window', () => {
    const frames = trackingWindow(result, 600, 660);
    expect(frames).toHaveLength(600);
    expect(frames[0]!.t).toBeCloseTo(600.1, 5);
    expect(frames[frames.length - 1]!.t).toBeCloseTo(660, 5);
  });

  it('is deterministic across calls', () => {
    const a = trackingWindow(result, 1200, 1260);
    const b = trackingWindow(result, 1200, 1260);
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it('all players are on the pitch and inside the bounds', () => {
    const frames = trackingWindow(result, 300, 310);
    for (const frame of frames) {
      expect(frame.players.length).toBe(22);
      for (const p of frame.players) {
        expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(52.5);
        expect(Math.abs(p.pos.y)).toBeLessThanOrEqual(34);
        expect(p.speedKph).toBeGreaterThanOrEqual(0);
        expect(p.speedKph).toBeLessThanOrEqual(37);
      }
      expect(Math.abs(frame.ball.pos.x)).toBeLessThanOrEqual(53);
      expect(Math.abs(frame.ball.pos.y)).toBeLessThanOrEqual(35);
    }
  });

  it('ball speed is positive during passes', () => {
    const frames = trackingWindow(result, 0, 30);
    const movingFrames = frames.filter((f) => f.ball.speedKph > 0);
    expect(movingFrames.length).toBeGreaterThan(10);
    // Between passes the ball rests — both states must appear.
    const stillFrames = frames.filter((f) => f.ball.speedKph === 0);
    expect(stillFrames.length).toBeGreaterThan(0);
  });

  it('sprint speeds occur occasionally but never exceed human limits', () => {
    const frames = trackingWindow(result, 1800, 2400);
    let sprints = 0;
    for (const frame of frames) {
      for (const p of frame.players) {
        if (p.speedKph >= 25.2) sprints++;
        expect(p.speedKph).toBeLessThan(37);
      }
    }
    expect(sprints).toBeGreaterThan(0);
  });

  it('players near the ball move toward it (possession pull)', () => {
    const frames = trackingWindow(result, 900, 915);
    let nearestDistances: number[] = [];
    for (const frame of frames) {
      let min = Infinity;
      for (const p of frame.players) min = Math.min(min, Math.hypot(p.pos.x - frame.ball.pos.x, p.pos.y - frame.ball.pos.y));
      nearestDistances.push(min);
    }
    const avg = nearestDistances.reduce((a, b) => a + b, 0) / nearestDistances.length;
    // Somebody should be reasonably close to the ball most of the time.
    expect(avg).toBeLessThan(14);
  });
});
