/**
 * Squad generation — every club owns a stable, deterministic 18-player squad.
 * The same club always fields the same people; ability ratings are derived
 * from the club's underlying strength plus per-player personality noise.
 */

import { clamp, createRng, deriveSeed } from '@floodlight/core';
import type { Player, Role, TeamSide } from '@floodlight/core';
import { CLUBS, NAME_POOLS } from './data';

export interface PlayerAbility {
  passing: number;
  shooting: number;
  pace: number;
  defending: number;
  physical: number;
}

export interface SquadPlayer extends Player {
  ability: PlayerAbility;
}

interface RolePlan {
  role: Role;
  count: number;
}

const SQUAD_PLAN: RolePlan[] = [
  { role: 'GK', count: 2 },
  { role: 'DF', count: 6 },
  { role: 'MF', count: 6 },
  { role: 'FW', count: 4 },
];

/** Stable squad for a club id — same output for the same club, forever. */
export function squadFor(clubId: string): SquadPlayer[] {
  const profile = CLUBS.find((c) => c.club.id === clubId);
  if (!profile) throw new Error(`Unknown club: ${clubId}`);
  const rng = createRng(deriveSeed(0x51_c0de, clubId));

  const players: SquadPlayer[] = [];
  let index = 0;

  const usedNames = new Set<string>();
  const pickName = (): string => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const name = `${rng.pick(NAME_POOLS.FIRST_NAMES)} ${rng.pick(NAME_POOLS.LAST_NAMES)}`;
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    // Extremely unlikely fallback that stays deterministic.
    const fallback = `${rng.pick(NAME_POOLS.FIRST_NAMES)} ${rng.pick(NAME_POOLS.LAST_NAMES)} ${index + 1}`;
    usedNames.add(fallback);
    return fallback;
  };

  const numbers = rng.shuffle(Array.from({ length: 34 }, (_, i) => i + 1));

  for (const plan of SQUAD_PLAN) {
    for (let i = 0; i < plan.count; i++) {
      const base = profile.strength + rng.gaussian(0, 0.07);
      const starFactor = i === 0 ? 0.06 : i < plan.count / 2 ? 0.02 : -0.03;
      const abilityFor = (bias: number): number =>
        clamp(base + starFactor + bias + rng.gaussian(0, 0.045), 0.3, 0.99);

      const ability: PlayerAbility = {
        passing: abilityFor(plan.role === 'GK' ? -0.18 : plan.role === 'FW' ? 0.0 : 0.04),
        shooting: abilityFor(plan.role === 'FW' ? 0.06 : plan.role === 'MF' ? -0.02 : -0.16),
        pace: abilityFor(plan.role === 'FW' ? 0.05 : plan.role === 'GK' ? -0.22 : plan.role === 'DF' ? 0.02 : 0.03),
        defending: abilityFor(plan.role === 'DF' ? 0.08 : plan.role === 'MF' ? 0.02 : plan.role === 'GK' ? 0.05 : -0.12),
        physical: abilityFor(plan.role === 'DF' ? 0.05 : plan.role === 'GK' ? 0.04 : 0),
      };

      players.push({
        id: `${clubId}-p${index + 1}`,
        name: pickName(),
        shirt: numbers[index]!,
        squadNumber: numbers[index]!,
        team: 'home',
        role: plan.role,
        slot: index,
        ability,
      });
      index++;
    }
  }

  // Keep squads ordered by role then descending ability for stable lineups.
  players.sort((a, b) => {
    const order: Record<Role, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };
    const roleDelta = order[a.role] - order[b.role];
    if (roleDelta !== 0) return roleDelta;
    const qualityB = quality(b.ability);
    const qualityA = quality(a.ability);
    return qualityB - qualityA || (a.squadNumber - b.squadNumber);
  });
  // Rebuild slots to reflect the sorted order.
  players.forEach((p, i) => {
    p.slot = i;
  });
  return players;
}

export function quality(ability: PlayerAbility): number {
  return (ability.passing + ability.shooting + ability.pace + ability.defending + ability.physical) / 5;
}

export interface Lineup {
  team: TeamSide;
  clubId: string;
  starters: SquadPlayer[];
  bench: SquadPlayer[];
}

/**
 * Pick a starting XI for a formation. The formation template carries role
 * slots in a fixed order (GK first, then outfield); we select the best
 * available player for each role.
 */
export function pickLineup(
  clubId: string,
  team: TeamSide,
  formationOrder: Role[],
): Lineup {
  const squad = squadFor(clubId);
  const available = [...squad];
  const starters: SquadPlayer[] = [];

  for (const role of formationOrder) {
    let bestIndex = -1;
    let bestQuality = -Infinity;
    for (let i = 0; i < available.length; i++) {
      const candidate = available[i]!;
      if (candidate.role !== role) continue;
      // Prefer strikers for FW slots etc. — exact role match only.
      const q = quality(candidate.ability);
      if (q > bestQuality) {
        bestQuality = q;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) throw new Error(`No ${role} available in squad ${clubId}`);
    const [chosen] = available.splice(bestIndex, 1);
    if (chosen) {
      chosen.team = team;
    }
    starters.push(chosen!);
  }

  const bench = available.slice(0, 7).map((p) => ({ ...p, team }));
  return { team, clubId, starters: starters.map((p) => ({ ...p, team })), bench };
}
