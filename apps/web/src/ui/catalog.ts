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
    tagline: 'Riverside Athletic host Northgate United. Follow the story as it unfolds.',
    home: { abbr: 'RIV', name: 'Riverside Athletic', primary: '#d7263d', onPrimary: '#ffffff' },
    away: { abbr: 'NOR', name: 'Northgate United', primary: '#1f4e9c', onPrimary: '#ffffff' },
    beat: 'Momentum shifts and late pressure',
  },
  {
    id: 'siege',
    name: 'The Siege',
    tagline: 'Harbour City face Old Tower FC. Watch their contrasting styles compete.',
    home: { abbr: 'HAR', name: 'Harbour City', primary: '#59c3e0', onPrimary: '#12263a' },
    away: { abbr: 'OLD', name: 'Old Tower FC', primary: '#7b2d26', onPrimary: '#f4e9d8' },
    beat: 'Sustained pressure and goalkeeping',
  },
  {
    id: 'derby',
    name: 'The Derby',
    tagline: 'Ironworks meet Westerly in a local rivalry. Every decision matters.',
    home: { abbr: 'IRN', name: 'Ironworks FC', primary: '#2b2b2b', onPrimary: '#f2a541' },
    away: { abbr: 'WES', name: 'Westerly Wanderers', primary: '#e07a1f', onPrimary: '#14342b' },
    beat: 'Rivalry, set pieces and officiating',
  },
  {
    id: 'freeplay',
    name: 'Free Play',
    tagline: 'No script. Pure seeded simulation — every run tells its own story.',
    home: { abbr: '???', name: 'Drawn from the seed', primary: '#3a4a6b', onPrimary: '#cfe3ff' },
    away: { abbr: '???', name: 'Drawn from the seed', primary: '#6b3a5a', onPrimary: '#ffd9ef' },
    beat: 'Fully emergent from the seed',
  },
];
