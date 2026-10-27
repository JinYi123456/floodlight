/**
 * Analysis heuristics — control vs chaos, rhythm classification, momentum.
 * These read from per-minute feature buckets and are intentionally explicit:
 * every label is a documented function of measurable features, which is what
 * makes the explainability layer auditable.
 */

import { clamp, lerp, roundTo, type TeamSide } from '@floodlight/core';

export interface WindowFeatures {
  minutes: number;
  /** Possession share for the home team, 0..1 (time-weighted). */
  possessionHome: number;
  /** Pass completion rate across both teams. */
  completion: number;
  /** Lost possessions per minute (both teams). */
  turnoversPerMinute: number;
  /** Duels (tackles + fouls + interceptions) per minute. */
  duelsPerMinute: number;
  /** Average speed of attempted passes, km/h. */
  passSpeedAvgKph: number;
  /** Total shots in the window. */
  shots: number;
  /** Home team's xT accrual minus away's, in the window. */
  xtBalance: number;
  /** Tackles, interceptions and fouls in the opponent's defensive 60% per minute (pressing proxy). */
  highPressPerMinute: number;
}

export interface ControlChaosReading {
  control: number;
  chaos: number;
  label: 'controlled' | 'balanced' | 'contested' | 'chaotic';
}

/**
 * Control vs chaos: two poles of the same game-state.
 * Chaos rises with turnovers, duels and sped-up passing; control rises with
 * completion and stable possession.
 */
export function readControlChaos(f: WindowFeatures): ControlChaosReading {
  const turnovers = clamp(f.turnoversPerMinute / 14, 0, 1);
  const duels = clamp(f.duelsPerMinute / 16, 0, 1);
  const speed = clamp((f.passSpeedAvgKph - 28) / 42, 0, 1);
  const sloppiness = clamp((0.88 - f.completion) / 0.24, 0, 1);
  const chaos = clamp(0.3 * turnovers + 0.25 * duels + 0.2 * speed + 0.25 * sloppiness, 0, 1);

  const stability = clamp((f.completion - 0.62) / 0.3, 0, 1);
  const calm = clamp((10 - f.turnoversPerMinute) / 9, 0, 1);
  const dominance = clamp(Math.abs(f.possessionHome - 0.5) * 2.4 + 0.25, 0, 1);
  const control = clamp(0.45 * stability + 0.3 * calm + 0.25 * dominance, 0, 1);

  const label: ControlChaosReading['label'] =
    chaos >= 0.72 ? 'chaotic' : control >= 0.68 ? 'controlled' : chaos >= 0.55 ? 'contested' : 'balanced';
  return { control: roundTo(control, 3), chaos: roundTo(chaos, 3), label };
}

export type RhythmLabel =
  | 'settled possession'
  | 'high press'
  | 'end-to-end'
  | 'low-block siege'
  | 'contested football';

export interface RhythmReading {
  label: RhythmLabel;
  confidence: number;
}

/** Classify a window into a familiar game-rhythm phrase. */
export function readRhythm(f: WindowFeatures): RhythmReading {
  const even = Math.abs(f.possessionHome - 0.5) < 0.12;
  if (f.possessionHome >= 0.66 || f.possessionHome <= 0.34) {
    if (f.shots >= 4) return { label: 'low-block siege', confidence: roundTo(clamp(0.5 + (f.shots - 4) * 0.1, 0, 0.95), 2) };
    return { label: 'settled possession', confidence: 0.6 };
  }
  if (f.turnoversPerMinute >= 7 && f.shots >= 2 && even) {
    return { label: 'end-to-end', confidence: roundTo(clamp(0.45 + f.turnoversPerMinute * 0.05, 0, 0.95), 2) };
  }
  if (f.highPressPerMinute >= 3) return { label: 'high press', confidence: 0.65 };
  if (f.completion >= 0.84 && f.turnoversPerMinute <= 4) return { label: 'settled possession', confidence: 0.7 };
  return { label: 'contested football', confidence: 0.5 };
}

/**
 * Momentum: an exponentially smoothed, minute-level balance of attacking
 * threat (−1 = away in the ascendancy, +1 = home).
 */
export class MomentumTracker {
  private value = 0;
  private readonly alpha: number;

  constructor(alpha = 0.35) {
    this.alpha = alpha;
  }

  update(minuteThreatHome: number, minuteThreatAway: number): number {
    const diff = minuteThreatHome - minuteThreatAway;
    const normalized = Math.tanh(diff / 1.1);
    this.value = lerp(this.value, normalized, this.alpha);
    return this.value;
  }

  current(): number {
    return roundTo(this.value, 3);
  }
}

export function swingMagnitude(from: number, to: number): number {
  return roundTo(Math.abs(to - from), 3);
}

export function dominateSide(value: number): TeamSide | 'none' {
  if (value > 0.25) return 'home';
  if (value < -0.25) return 'away';
  return 'none';
}
