/**
 * Shared positional model — the single source of truth for where players
 * stand. Both the simulator (for pass targeting and pressure) and the
 * tracking generator (for the 10 Hz feed) use these anchors, so events and
 * positions can never drift apart.
 */

import { clamp, PITCH, type TeamSide, type TeamTactics, type Vec2 } from '@floodlight/core';
import { FORMATIONS, type FormationSlot } from './data';

export const attackingDirection: Record<TeamSide, 1 | -1> = { home: 1, away: -1 };

export function formationSlotFor(formation: string, slotIndex: number): FormationSlot {
  const shape = FORMATIONS[formation] ?? FORMATIONS['4-3-3']!;
  return shape[slotIndex % shape.length]!;
}

/**
 * Formation anchor in world coordinates.
 *
 * @param slot        the player's formation slot
 * @param team        the player's team
 * @param selfTeam    possession context: which team currently has the ball
 * @param tactics     team tactics
 * @param ball        current ball position
 */
export function anchorPosition(
  slot: FormationSlot,
  team: TeamSide,
  possessionTeam: TeamSide,
  tactics: TeamTactics,
  ball: Vec2,
): Vec2 {
  const sign = attackingDirection[team];
  const inPossession = possessionTeam === team;

  const ballShift = (ball.x * sign) / PITCH.halfLength;
  const slide = clamp(ballShift * 0.18, -0.18, 0.18);
  let x = slot.x + slide;
  if (!inPossession) {
    x = x * (0.55 + tactics.lineHeight * 0.5) - 0.06 * (1 - tactics.lineHeight);
  }
  const widthScale = inPossession ? 0.9 + tactics.width * 0.35 : 0.82;
  const y = slot.y * widthScale + ((ball.y * sign) / PITCH.halfWidth) * 0.12;

  return {
    x: clamp(sign * (-PITCH.halfLength + x * PITCH.length), -PITCH.halfLength + 0.5, PITCH.halfLength - 0.5),
    y: clamp(y * PITCH.halfWidth, -PITCH.halfWidth + 0.5, PITCH.halfWidth - 0.5),
  };
}

/** Goalkeeper anchor: on the goal line, shuffling with the ball's y. */
export function goalkeeperAnchor(team: TeamSide, ball: Vec2): Vec2 {
  const sign = attackingDirection[team];
  return {
    x: sign * (PITCH.halfLength - 2.5),
    y: clamp(ball.y * 0.06, -3.5, 3.5),
  };
}
