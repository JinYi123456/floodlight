/**
 * Display metadata for insight moment kinds — labels and accent colours used
 * across the rundown, the ledger and the overlay layer.
 */

import type { MomentKind } from '@floodlight/engine';

export interface KindStyle {
  label: string;
  color: string;
}

export const KIND_STYLES: Record<MomentKind, KindStyle> = {
  goal: { label: 'GOAL', color: '#ffd166' },
  var_review: { label: 'VAR CHECK', color: '#b388ff' },
  var_overturn: { label: 'OVERTURNED', color: '#ff5c7a' },
  penalty: { label: 'PENALTY', color: '#ffd166' },
  red_card: { label: 'RED CARD', color: '#ff4d4d' },
  big_chance: { label: 'BIG CHANCE', color: '#7dd3fc' },
  big_save: { label: 'BIG SAVE', color: '#7dd3fc' },
  momentum_shift: { label: 'MOMENTUM', color: '#a3e635' },
  siege: { label: 'SIEGE', color: '#f97316' },
  comeback_trigger: { label: 'COMEBACK', color: '#f472b6' },
  late_drama: { label: 'LATE DRAMA', color: '#f87171' },
  milestone: { label: 'MILESTONE', color: '#facc15' },
  speed_flash: { label: 'SPEED', color: '#38bdf8' },
  tactical_pressure: { label: 'PRESSURE', color: '#94a3b8' },
};

export function kindStyle(kind: MomentKind): KindStyle {
  return KIND_STYLES[kind] ?? { label: kind.toUpperCase(), color: '#94a3b8' };
}
