/**
 * Pitch geometry helpers shared by every package.
 */

import { PITCH, type Vec2 } from './types';
import { clamp, roundTo } from './math';

export type AttackSign = 1 | -1;

/**
 * Expected-threat surface (0..1) for a ball position, hand-calibrated for the
 * synthetic league. The simulator and the intelligence engine both call this
 * function, so every xT number in the product traces back to one definition.
 */
export function expectedThreat(pos: Vec2, attackSign: AttackSign): number {
  const own = (pos.x * attackSign + PITCH.halfLength) / PITCH.length;
  const central = 1 - Math.abs(pos.y) / PITCH.halfWidth;
  const t = clamp(own, 0, 1);
  const base = 0.003 + 0.18 * t ** 2.6;
  const box = clamp((t - 0.78) / 0.22, 0, 1);
  const boxBoost = 0.55 * box ** 1.8 * (0.35 + 0.65 * central);
  return roundTo(clamp(base + boxBoost * 0.42, 0, 0.92), 4);
}

/** Distance from the opponent goal line along the attack direction. */
export function distanceToGoalLine(pos: Vec2, attackSign: AttackSign): number {
  return (attackSign * PITCH.halfLength - pos.x) * attackSign;
}

/** True when the position is inside the attacking penalty area. */
export function isInAttackingBox(pos: Vec2, attackSign: AttackSign): boolean {
  const dx = distanceToGoalLine(pos, attackSign);
  return dx >= 0 && dx <= PITCH.penaltyAreaLength && Math.abs(pos.y) <= PITCH.penaltyAreaWidth / 2;
}

/** True when the position is in the attacking third. */
export function isInFinalThird(pos: Vec2, attackSign: AttackSign): boolean {
  return distanceToGoalLine(pos, attackSign) < PITCH.length / 3;
}
