import { describe, expect, it } from 'vitest';
import { runCalibrationBatch } from '@floodlight/simulator';

describe('calibration — football realism', () => {
  // Regression fixture: 20 seeded free-play matches. Seeded batches are
  // deterministic; bounds guard against model drift over time.
  const batch = runCalibrationBatch(20, 2026);

  it('aggregate texture matches football-realistic ranges', () => {
    for (const check of batch.checks) {
      expect(check.pass, `${check.name}=${check.value.toFixed(3)} not in [${check.min}, ${check.max}]`).toBe(true);
    }
  });

  it('every individual match stays in plausible bounds', () => {
    for (const s of batch.summaries) {
      const goals = s.goalsHome + s.goalsAway;
      // Blowouts happen in football; beyond twelve goals would signal a bug.
      expect(goals, `seed ${s.seed}`).toBeLessThanOrEqual(12);
      expect(s.shots, `seed ${s.seed}`).toBeLessThanOrEqual(60);
      expect(s.passAccuracy).toBeGreaterThan(0.6);
      expect(s.passAccuracy).toBeLessThan(0.97);
      expect(s.events).toBeGreaterThan(500);
    }
  });

  it('calibration runs fast enough for CI', () => {
    const t0 = Date.now();
    runCalibrationBatch(4, 500);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
