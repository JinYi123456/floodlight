/**
 * Scripted scenarios.
 *
 * Free-play matches are pure stochastic simulation; scenarios add narrative
 * directives — forced goals, cards, VAR overturns, momentum windows — so the
 * pipeline has a guaranteed story to discover, explain and retract.
 * Everything remains seeded and reproducible.
 */

import type { TeamSide } from '@floodlight/core';

export type Directive =
  | { kind: 'intent'; team: TeamSide; fromMinute: number; toMinute: number; attackBias: number; pressBias: number; directBias: number }
  | { kind: 'force_goal'; team: TeamSide; byMinute: number; style: 'open_play' | 'screamer' | 'penalty'; scorerId?: string }
  | { kind: 'force_red_card'; team: TeamSide; atMinute: number }
  | { kind: 'force_var_overturn'; team: TeamSide; atMinute: number }
  | { kind: 'force_big_save'; team: TeamSide; atMinute: number };

export interface Scenario {
  id: string;
  name: string;
  tagline: string;
  homeClubId: string;
  awayClubId: string;
  /** In-match narrative directives, applied in order. */
  directives: Directive[];
  /**
   * Windows where natural (non-forced) goals are suppressed, so the authored
   * storyline keeps its intended shape — e.g. a siege being 0-0 until late.
   */
  naturalGoalBlocks?: Array<{ fromMinute: number; toMinute: number; team: TeamSide | 'both' }>;
  /** Optional overrides to the clubs' default tactics. */
  tacticsOverrides?: {
    home?: Partial<{ pressing: number; directness: number; lineHeight: number; risk: number; width: number }>;
    away?: Partial<{ pressing: number; directness: number; lineHeight: number; risk: number; width: number }>;
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'comeback',
    name: 'The Comeback',
    tagline: 'Two down inside half an hour. Then the floodlights changed everything.',
    homeClubId: 'riverside',
    awayClubId: 'northgate',
    naturalGoalBlocks: [{ fromMinute: 0, toMinute: 100, team: 'both' }],
    directives: [
      { kind: 'force_goal', team: 'away', byMinute: 9, style: 'open_play' },
      { kind: 'force_goal', team: 'away', byMinute: 29, style: 'screamer' },
      { kind: 'intent', team: 'home', fromMinute: 31, toMinute: 90, attackBias: 0.34, pressBias: 0.28, directBias: 0.12 },
      { kind: 'intent', team: 'away', fromMinute: 32, toMinute: 90, attackBias: -0.2, pressBias: -0.15, directBias: -0.1 },
      { kind: 'force_goal', team: 'home', byMinute: 53, style: 'open_play' },
      { kind: 'force_goal', team: 'home', byMinute: 71, style: 'open_play' },
      { kind: 'force_goal', team: 'home', byMinute: 86, style: 'open_play' },
    ],
  },
  {
    id: 'siege',
    name: 'The Siege',
    tagline: 'Twenty-eight shots, one goal, and a wall that almost held forever.',
    homeClubId: 'harbour',
    awayClubId: 'oldtower',
    naturalGoalBlocks: [{ fromMinute: 0, toMinute: 86, team: 'both' }],
    tacticsOverrides: {
      home: { pressing: 0.7, risk: 0.62, directness: 0.4 },
      away: { pressing: 0.18, directness: 0.85, lineHeight: 0.28, risk: 0.35 },
    },
    directives: [
      { kind: 'intent', team: 'home', fromMinute: 15, toMinute: 90, attackBias: 0.45, pressBias: 0.2, directBias: 0.05 },
      { kind: 'force_big_save', team: 'home', atMinute: 61 },
      { kind: 'force_goal', team: 'home', byMinute: 89, style: 'screamer' },
    ],
  },
  {
    id: 'derby',
    name: 'The Derby',
    tagline: 'Seven goals, a red card, a VAR overturn — ninety minutes of beautiful chaos.',
    homeClubId: 'ironworks',
    awayClubId: 'westerly',
    naturalGoalBlocks: [{ fromMinute: 0, toMinute: 100, team: 'both' }],
    directives: [
      { kind: 'force_goal', team: 'home', byMinute: 13, style: 'open_play' },
      { kind: 'force_goal', team: 'away', byMinute: 25, style: 'open_play' },
      { kind: 'force_goal', team: 'away', byMinute: 39, style: 'open_play' },
      { kind: 'force_var_overturn', team: 'home', atMinute: 41 },
      { kind: 'force_goal', team: 'home', byMinute: 45, style: 'open_play' },
      { kind: 'force_goal', team: 'home', byMinute: 50, style: 'open_play' },
      { kind: 'force_red_card', team: 'away', atMinute: 55 },
      { kind: 'intent', team: 'home', fromMinute: 56, toMinute: 90, attackBias: 0.3, pressBias: 0.24, directBias: 0.1 },
      { kind: 'force_goal', team: 'home', byMinute: 64, style: 'penalty' },
      { kind: 'force_goal', team: 'away', byMinute: 80, style: 'open_play' },
      { kind: 'force_goal', team: 'home', byMinute: 94, style: 'open_play' },
    ],
  },
  {
    id: 'freeplay',
    name: 'Free Play',
    tagline: 'No script. Pure seeded simulation — every run tells its own story.',
    homeClubId: '',
    awayClubId: '',
    directives: [],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
