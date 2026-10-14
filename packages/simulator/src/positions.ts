/**
 * Shared positional model — the single source of truth for where players
 * stand when the tracking feed is generated. Events and positions can never
 * drift apart: every anchor is computed from the governing event state.
 *
 * The model is a block, the way teams actually move: each player holds a
 * role line (defence / midfield / attack), the lines shift together with
 * the ball inside bounds a coach would recognise — a back line never
 * collapses onto its own goal line, a front line never abandons the halfway
 * line to hunt the ball — and the block narrows when defending and
 * stretches with the ball. The vocabulary (line height, compactness) is the
 * one tracking-data analysis uses.
 */

import { clamp, PITCH, type TeamSide, type TeamTactics, type Vec2 } from '@floodlight/core';
import { FORMATIONS, type FormationSlot } from './data';

export const attackingDirection: Record<TeamSide, 1 | -1> = { home: 1, away: -1 };

export function formationSlotFor(formation: string, slotIndex: number): FormationSlot {
  const shape = FORMATIONS[formation] ?? FORMATIONS['4-3-3']!;
  return shape[slotIndex % shape.length]!;
}

type RoleLine = 'def' | 'mid' | 'fwd';

function lineOf(slot: FormationSlot): RoleLine {
  if (slot.x < 0.34) return 'def';
  if (slot.x < 0.68) return 'mid';
  return 'fwd';
}

/**
 * Formation anchor in world coordinates — the player's station within the
 * team's moving block.
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
  const line = lineOf(slot);

  // Ball progress in this team's frame: 0 = own goal line, 105 = theirs.
  const progress = clamp(ball.x * sign + PITCH.halfLength, 0, PITCH.length);

  // The block shifts as a unit — higher with the ball, deeper when it is
  // lost — within bounds a compact mid-block would recognise.
  const shift = inPossession
    ? clamp((progress - PITCH.halfLength) * 0.3, -16, 18)
    : clamp((progress - PITCH.halfLength) * 0.24, -20, 12);

  // Line targets, in metres from the team's own goal.
  const lineTarget =
    line === 'def'
      ? clamp(16 + shift, 9, 42)
      : line === 'mid'
        ? clamp(36 + shift, 22, 58)
        : clamp(56 + shift * 0.65, 32, 72);

  // Within a line the formation's own shape survives — centre-backs ahead
  // of the keeper, wide players off the centre — scaled so a line stays a
  // line rather than stretching across two thirds of the pitch.
  const ref = line === 'def' ? 0.17 : line === 'mid' ? 0.5 : 0.84;
  const spread = line === 'def' ? 38 : line === 'mid' ? 44 : 40;
  let depth = lineTarget + (slot.x - ref) * spread;

  // Full-backs and wingers overlap into the attack when their team has it;
  // the line-height tactic squeezes the whole block forward or back.
  if (inPossession && Math.abs(slot.y) > (line === 'def' ? 0.55 : 0.5)) depth += line === 'def' ? 6 : 3;
  depth += (tactics.lineHeight - 0.5) * (line === 'def' ? 10 : line === 'mid' ? 8 : 4);

  depth = clamp(
    depth,
    line === 'def' ? 8 : line === 'mid' ? 20 : 30,
    line === 'def' ? 46 : line === 'mid' ? 62 : 74,
  );

  // Width: the block narrows out of possession, and everyone leans a touch
  // toward the ball's side — more so the further up the pitch they play.
  const widthScale = inPossession ? 0.9 + tactics.width * 0.2 : 0.62 + tactics.width * 0.12;
  const lean = clamp(ball.y * (line === 'def' ? 0.1 : line === 'mid' ? 0.16 : 0.2), -8, 8);
  const y = clamp(slot.y * PITCH.halfWidth * widthScale + lean, -PITCH.halfWidth + 0.5, PITCH.halfWidth - 0.5);

  const x = clamp(
    sign > 0 ? -PITCH.halfLength + depth : PITCH.halfLength - depth,
    -PITCH.halfLength + 0.5,
    PITCH.halfLength - 0.5,
  );
  return { x, y };
}

/** Goalkeeper anchor: on the goal line, shuffling with the ball's y. */
export function goalkeeperAnchor(team: TeamSide, ball: Vec2): Vec2 {
  const sign = attackingDirection[team];
  return {
    x: sign * (PITCH.halfLength - 2.5),
    y: clamp(ball.y * 0.06, -3.5, 3.5),
  };
}
