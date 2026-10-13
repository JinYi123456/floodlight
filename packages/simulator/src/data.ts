/**
 * The fictional world of the Meridian data set: clubs, venues, people.
 * Everything here is invented — any resemblance to real clubs or players
 * is coincidental, by design. All output of the engine is synthetic.
 */

import type { Club, Role, TeamTactics, Venue } from '@floodlight/core';

export interface ClubProfile {
  club: Club;
  /** Underlying footballing strength 0..1 used by the simulator. */
  strength: number;
  defaultTactics: TeamTactics;
}

const tactics = (partial: Partial<TeamTactics>): TeamTactics => ({
  directness: 0.5,
  pressing: 0.55,
  width: 0.6,
  lineHeight: 0.55,
  risk: 0.5,
  formation: '4-3-3',
  baseTempo: 1,
  ...partial,
});

export const CLUBS: ClubProfile[] = [
  {
    club: { id: 'riverside', name: 'Riverside Athletic', abbr: 'RIV', primary: '#d7263d', secondary: '#ffffff', onPrimary: '#ffffff' },
    strength: 0.74,
    defaultTactics: tactics({ pressing: 0.72, directness: 0.42, risk: 0.58, formation: '4-3-3' }),
  },
  {
    club: { id: 'northgate', name: 'Northgate United', abbr: 'NOR', primary: '#1f4e9c', secondary: '#f2c14e', onPrimary: '#ffffff' },
    strength: 0.76,
    defaultTactics: tactics({ pressing: 0.6, directness: 0.5, risk: 0.55, formation: '4-2-3-1' }),
  },
  {
    club: { id: 'harbour', name: 'Harbour City', abbr: 'HAR', primary: '#59c3e0', secondary: '#12263a', onPrimary: '#12263a' },
    strength: 0.68,
    defaultTactics: tactics({ width: 0.72, directness: 0.38, formation: '4-3-3' }),
  },
  {
    club: { id: 'ironworks', name: 'Ironworks FC', abbr: 'IRN', primary: '#2b2b2b', secondary: '#f2a541', onPrimary: '#f2a541' },
    strength: 0.6,
    defaultTactics: tactics({ pressing: 0.7, directness: 0.62, lineHeight: 0.62, risk: 0.6, formation: '4-4-2' }),
  },
  {
    club: { id: 'kingsbridge', name: 'Kingsbridge Town', abbr: 'KBR', primary: '#5d3fd3', secondary: '#e9d8ff', onPrimary: '#ffffff' },
    strength: 0.63,
    defaultTactics: tactics({ directness: 0.45, pressing: 0.5, formation: '4-2-3-1' }),
  },
  {
    club: { id: 'eastgate', name: 'Eastgate Rovers', abbr: 'EAS', primary: '#2e8b57', secondary: '#f5f5f5', onPrimary: '#ffffff' },
    strength: 0.55,
    defaultTactics: tactics({ directness: 0.66, pressing: 0.45, lineHeight: 0.45, risk: 0.42, formation: '4-4-2' }),
  },
  {
    club: { id: 'oldtower', name: 'Old Tower FC', abbr: 'OLD', primary: '#7b2d26', secondary: '#d9c9a3', onPrimary: '#f4e9d8' },
    strength: 0.52,
    defaultTactics: tactics({ pressing: 0.4, directness: 0.55, lineHeight: 0.42, risk: 0.4, formation: '4-4-2' }),
  },
  {
    club: { id: 'westerly', name: 'Westerly Wanderers', abbr: 'WES', primary: '#e07a1f', secondary: '#14342b', onPrimary: '#14342b' },
    strength: 0.58,
    defaultTactics: tactics({ width: 0.66, pressing: 0.62, risk: 0.56, formation: '4-3-3' }),
  },
];

export const VENUES: Record<string, Venue> = {
  riverside: { id: 'riverside-park', name: 'Riverside Park', city: 'Riverside', capacity: 52400 },
  northgate: { id: 'northgate-arena', name: 'Northgate Arena', city: 'Northgate', capacity: 61800 },
  harbour: { id: 'harbour-bowl', name: 'Harbour Bowl', city: 'Harbour', capacity: 47300 },
  ironworks: { id: 'the-foundry', name: 'The Foundry', city: 'Ironworks', capacity: 39800 },
  kingsbridge: { id: 'kingsbridge-ground', name: 'Kingsbridge Ground', city: 'Kingsbridge', capacity: 41200 },
  eastgate: { id: 'eastgate-stadium', name: 'Eastgate Stadium', city: 'Eastgate', capacity: 32400 },
  oldtower: { id: 'tower-field', name: 'Tower Field', city: 'Old Tower', capacity: 28700 },
  westerly: { id: 'westerly-park', name: 'Westerly Park', city: 'Westerly', capacity: 36600 },
};

export function venueForClub(clubId: string): Venue {
  const venue = VENUES[clubId];
  if (!venue) throw new Error(`No venue registered for club ${clubId}`);
  return venue;
}

export const MANAGERS: Record<string, string> = {
  riverside: 'Dana Whitfield',
  northgate: 'Marek Ostrowski',
  harbour: 'Ines Carmo',
  ironworks: 'Callum Brae',
  kingsbridge: 'Priya Nandakumar',
  eastgate: 'Tom Ashby',
  oldtower: 'Gareth Lyle',
  westerly: 'Nora Kestrel',
};

export const REFEREES: string[] = [
  'Amelia Farrow',
  'Victor Lindqvist',
  'Rosa Delgado',
  'Ken Okafor',
  'Harriet Blythe',
];

const FIRST_NAMES: string[] = [
  'Alden', 'Bram', 'Cassian', 'Dario', 'Elias', 'Felix', 'Gustav', 'Hugo', 'Ivo', 'Jonah',
  'Kasper', 'Leon', 'Mateo', 'Nils', 'Oscar', 'Pavel', 'Quentin', 'Ravi', 'Silas', 'Tobias',
  'Ulric', 'Viggo', 'Wade', 'Xavier', 'Yannick', 'Zane', 'Adrian', 'Bruno', 'Cedric', 'Dmitri',
  'Emil', 'Franco', 'Gabriel', 'Henrik', 'Isaac', 'Julian', 'Karim', 'Lars', 'Milan', 'Noel',
  'Otto', 'Piotr', 'Rafael', 'Samir', 'Theo', 'Valentin', 'Wim', 'Yusuf', 'Aron', 'Bastian',
  'Clive', 'Duncan', 'Ezra', 'Fionn', 'Gregor', 'Halvard', 'Ilya', 'Jamal', 'Klaus', 'Lucien',
];

const LAST_NAMES: string[] = [
  'Anselm', 'Bergqvist', 'Calderon', 'Duarte', 'Eriksen', 'Fontaine', 'Gallagher', 'Havlik', 'Iversen', 'Jankovic',
  'Keller', 'Lindberg', 'Moreau', 'Novak', 'Okonkwo', 'Pereira', 'Quintero', 'Rasmussen', 'Solberg', 'Tavares',
  'Ustinov', 'Vandermeer', 'Weiss', 'Ximenes', 'Yilmaz', 'Zielinski', 'Anders', 'Bouchard', 'Cardenas', 'Dahl',
  'Escobar', 'Falk', 'Grigoryan', 'Heikkila', 'Ibarra', 'Jonsson', 'Kovac', 'Larsen', 'Mendez', 'Nystrom',
  'Ortega', 'Palmgren', 'Reyes', 'Stankovic', 'Tuominen', 'Valdez', 'Wagner', 'Zander', 'Aslan', 'Bianchi',
  'Christou', 'Demir', 'Engberg', 'Farrell', 'Giordano', 'Halvorsen', 'Ivanov', 'Jelinek', 'Karlsson', 'Lombardi',
  'Marchetti', 'Nilsen', 'Oduya', 'Petrov', 'Rahman', 'Salvatore', 'Tran', 'Ustinova', 'Varga', 'Whitlock',
];

export const NAME_POOLS = { FIRST_NAMES, LAST_NAMES };

export interface FormationSlot {
  role: Role;
  /** Normalised anchor position when attacking toward +x: x ∈ [0,1] own goal → opponent goal, y ∈ [-1,1]. */
  x: number;
  y: number;
  /** Lateral lane index 0..4 (left touchline → right touchline) for structure metrics. */
  lane: number;
}

const slot = (role: Role, x: number, y: number): FormationSlot => ({
  role,
  x,
  y,
  lane: Math.round(((y + 1) / 2) * 4),
});

export const FORMATIONS: Record<string, FormationSlot[]> = {
  '4-3-3': [
    slot('GK', 0.03, 0),
    slot('DF', 0.2, -0.62), slot('DF', 0.16, -0.24), slot('DF', 0.16, 0.24), slot('DF', 0.2, 0.62),
    slot('MF', 0.42, 0), slot('MF', 0.5, -0.34), slot('MF', 0.5, 0.34),
    slot('FW', 0.74, -0.62), slot('FW', 0.8, 0), slot('FW', 0.74, 0.62),
  ],
  '4-4-2': [
    slot('GK', 0.03, 0),
    slot('DF', 0.2, -0.62), slot('DF', 0.16, -0.24), slot('DF', 0.16, 0.24), slot('DF', 0.2, 0.62),
    slot('MF', 0.5, -0.66), slot('MF', 0.44, -0.22), slot('MF', 0.44, 0.22), slot('MF', 0.5, 0.66),
    slot('FW', 0.78, -0.2), slot('FW', 0.78, 0.2),
  ],
  '4-2-3-1': [
    slot('GK', 0.03, 0),
    slot('DF', 0.2, -0.62), slot('DF', 0.16, -0.24), slot('DF', 0.16, 0.24), slot('DF', 0.2, 0.62),
    slot('MF', 0.38, -0.2), slot('MF', 0.38, 0.2),
    slot('MF', 0.62, -0.5), slot('MF', 0.64, 0), slot('MF', 0.62, 0.5),
    slot('FW', 0.82, 0),
  ],
  '3-5-2': [
    slot('GK', 0.03, 0),
    slot('DF', 0.15, -0.4), slot('DF', 0.13, 0), slot('DF', 0.15, 0.4),
    slot('MF', 0.4, -0.78), slot('MF', 0.42, -0.3), slot('MF', 0.4, 0), slot('MF', 0.42, 0.3), slot('MF', 0.4, 0.78),
    slot('FW', 0.78, -0.18), slot('FW', 0.78, 0.18),
  ],
};
