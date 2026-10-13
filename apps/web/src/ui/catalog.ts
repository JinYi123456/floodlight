/**
 * Launch-screen catalog — display metadata for the authored scenarios.
 * The heavy simulation code stays in the worker; this is only what the
 * picker needs to render a card.
 */

export interface ScenarioCard {
  id: string;
  name: string;
  tagline: string;
  home: { abbr: string; name: string; primary: string; onPrimary: string };
  away: { abbr: string; name: string; primary: string; onPrimary: string };
  beat: string;
}

export const SCENARIO_CARDS: ScenarioCard[] = [
  {
    id: 'comeback',
    name: 'The Comeback',
    tagline: 'Two down inside half an hour. Then the floodlights changed everything.',
    home: { abbr: 'RIV', name: 'Riverside Athletic', primary: '#d7263d', onPrimary: '#ffffff' },
    away: { abbr: 'NOR', name: 'Northgate United', primary: '#1f4e9c', onPrimary: '#ffffff' },
    beat: 'Momentum swings, siege detection, late drama',
  },
  {
    id: 'siege',
    name: 'The Siege',
    tagline: 'Twenty-eight shots, one goal, and a wall that almost held forever.',
    home: { abbr: 'HAR', name: 'Harbour City', primary: '#59c3e0', onPrimary: '#12263a' },
    away: { abbr: 'OLD', name: 'Old Tower FC', primary: '#7b2d26', onPrimary: '#f4e9d8' },
    beat: 'Control vs chaos, pressure waves, the big save',
  },
  {
    id: 'derby',
    name: 'The Derby',
    tagline: 'Seven goals, a red card, a VAR overturn — ninety minutes of beautiful chaos.',
    home: { abbr: 'IRN', name: 'Ironworks FC', primary: '#2b2b2b', onPrimary: '#f2a541' },
    away: { abbr: 'WES', name: 'Westerly Wanderers', primary: '#e07a1f', onPrimary: '#14342b' },
    beat: 'VAR retraction, red cards, penalty, milestone tracking',
  },
  {
    id: 'freeplay',
    name: 'Free Play',
    tagline: 'No script. Pure seeded simulation — every run tells its own story.',
    home: { abbr: '???', name: 'Drawn from the seed', primary: '#3a4a6b', onPrimary: '#cfe3ff' },
    away: { abbr: '???', name: 'Drawn from the seed', primary: '#6b3a5a', onPrimary: '#ffd9ef' },
    beat: 'Nothing forced — the engine finds its own moments',
  },
];
