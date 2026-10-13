/**
 * Cue sheet compiler — the Render contract.
 *
 * Turns verified, narrated moments into a timed, machine-readable cue sheet:
 * what graphic goes to which screen slot, at which match second, with what
 * payload, priority, animation and expiry. This is the artifact a broadcast
 * graphics renderer consumes — the same structure Floodlight's own control
 * room renders on screen.
 *
 * Rules enforced here:
 *  - one story per slot at a time (newer higher-priority cues preempt)
 *  - nothing airs after its story went stale (expiry)
 *  - every cue carries its evidence ids for audit
 */

import type { MatchEvent, MatchMeta } from '@floodlight/core';
import { roundTo } from '@floodlight/core';
import type { NarratedMoment } from '@floodlight/agents';

export type CueSlot = 'lower_third' | 'stat_bumper' | 'momentum_ribbon' | 'telestration' | 'player_tag' | 'goal_flash';

export type CueAnimation = 'slide_in' | 'draw' | 'flash' | 'pulse' | 'pinned';

export interface Cue {
  id: string;
  /** Match seconds the cue goes on air. */
  t0: number;
  /** Match seconds the cue leaves air. */
  t1: number;
  slot: CueSlot;
  priority: number;
  animation: CueAnimation;
  /** Render data; shape depends on slot (see schema in this package). */
  payload: Record<string, unknown>;
  source: {
    momentId: string;
    candidateId: string;
    evidenceEventIds: string[];
    verified: boolean;
  };
  /** The story is stale after this match time and must not air. */
  expiresAt: number;
}

export interface CueSheet {
  version: '1.0';
  matchId: string;
  cues: Cue[];
  meta: {
    homeAbbr: string;
    awayAbbr: string;
    competition: string;
    generatedBy: string;
  };
}

interface SlotSpec {
  duration: number;
  animation: CueAnimation;
  exclusive: boolean;
}

const SLOT_SPECS: Record<CueSlot, SlotSpec> = {
  lower_third: { duration: 8, animation: 'slide_in', exclusive: true },
  stat_bumper: { duration: 6, animation: 'slide_in', exclusive: true },
  momentum_ribbon: { duration: 12, animation: 'pulse', exclusive: true },
  telestration: { duration: 7, animation: 'draw', exclusive: true },
  player_tag: { duration: 5, animation: 'pinned', exclusive: true },
  goal_flash: { duration: 3, animation: 'flash', exclusive: false },
};

export interface CompileOptions {
  /** Evidence lookup: event id → event, used for telestration geometry. */
  events?: Map<string, MatchEvent>;
  /** Cues cannot air earlier than this match time (e.g. current clock). */
  fromT?: number;
}

let cueSeq = 0;

export function compileCues(moments: NarratedMoment[], meta: MatchMeta, options: CompileOptions = {}): CueSheet {
  cueSeq = 0;
  const cues: Cue[] = [];
  const sorted = [...moments].sort((a, b) => a.candidate.t - b.candidate.t);

  for (const moment of sorted) {
    if (!moment.air.air || moment.candidate.overturned) continue;
    const t = moment.candidate.t;
    const expiresAt = t + moment.air.ttlSeconds;

    if (moment.air.slots.includes('goal_flash')) {
      pushCue(cues, {
        t0: t,
        t1: t + SLOT_SPECS.goal_flash.duration,
        slot: 'goal_flash',
        priority: moment.air.priority,
        animation: 'flash',
        payload: { team: moment.candidate.team, headline: moment.headline },
        moment,
        expiresAt,
      });
    }

    for (const slotName of moment.air.slots) {
      const slot = slotName as CueSlot;
      if (!(slot in SLOT_SPECS) || slot === 'goal_flash') continue;
      const spec = SLOT_SPECS[slot];
      const base = slotStart(cues, slot, t, expiresAt, moment.air.priority);
      if (base === null) continue; // stale — dropped on purpose
      pushCue(cues, {
        t0: base,
        t1: base + spec.duration,
        slot,
        priority: moment.air.priority,
        animation: spec.animation,
        payload: payloadFor(slot, moment, options),
        moment,
        expiresAt,
      });
    }
  }

  cues.sort((a, b) => a.t0 - b.t0 || a.slot.localeCompare(b.slot));
  return {
    version: '1.0',
    matchId: meta.id,
    cues,
    meta: {
      homeAbbr: meta.home.abbr,
      awayAbbr: meta.away.abbr,
      competition: meta.competition,
      generatedBy: 'floodlight-cuesheet',
    },
  };
}

/**
 * Find the earliest legal start for a cue in an exclusive slot: the story's
 * timestamp if the slot is free, otherwise the end of the blocking cue —
 * unless the new cue outranks it, in which case it preempts.
 */
function slotStart(cues: Cue[], slot: CueSlot, t: number, expiresAt: number, priority: number): number | null {
  const blocking = cues.filter((c) => c.slot === slot && c.t1 > t && c.t0 <= t + SLOT_SPECS[slot].duration).sort((a, b) => a.t0 - b.t0);
  if (blocking.length === 0) return t;
  const first = blocking[0]!;
  if (priority > first.priority && SLOT_SPECS[slot].exclusive) {
    // Preempt: truncate the blocking cue — or remove it entirely when the
    // preemption leaves it no airtime at all.
    const truncated = Math.max(first.t0, t);
    if (truncated - first.t0 < 0.05) {
      cues.splice(cues.indexOf(first), 1);
    } else {
      first.t1 = truncated;
    }
    return t;
  }
  const start = Math.max(...blocking.map((c) => c.t1));
  return start <= expiresAt ? start : null;
}

function pushCue(cues: Cue[], input: {
  t0: number;
  t1: number;
  slot: CueSlot;
  priority: number;
  animation: CueAnimation;
  payload: Record<string, unknown>;
  moment: NarratedMoment;
  expiresAt: number;
}): void {
  cueSeq++;
  cues.push({
    id: `cue-${String(cueSeq).padStart(4, '0')}`,
    t0: roundTo(input.t0, 1),
    t1: roundTo(input.t1, 1),
    slot: input.slot,
    priority: input.priority,
    animation: input.animation,
    payload: input.payload,
    source: {
      momentId: `${input.moment.candidate.id}`,
      candidateId: input.moment.candidate.id,
      evidenceEventIds: input.moment.candidate.evidenceEventIds,
      verified: input.moment.verification.approved,
    },
    expiresAt: roundTo(input.expiresAt, 1),
  });
}

function payloadFor(slot: CueSlot, moment: NarratedMoment, options: CompileOptions): Record<string, unknown> {
  const { candidate, headline, body, lang, persona, provider } = moment;
  const base = { headline, body, lang, persona, provider, minuteLabel: candidate.minuteLabel };
  switch (slot) {
    case 'lower_third':
      return { ...base, team: candidate.team, kind: candidate.kind };
    case 'stat_bumper': {
      const stats = Object.entries(candidate.facts)
        .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
        .slice(0, 3)
        .map(([label, value]) => ({ label, value }));
      return { ...base, stats };
    }
    case 'momentum_ribbon':
      return { direction: candidate.team, swing: candidate.facts['swing'] ?? null, ...base };
    case 'telestration': {
      const event = candidate.evidenceEventIds.map((id) => options.events?.get(id)).find(Boolean);
      return {
        ...base,
        from: event ? { x: event.at.x, y: event.at.y } : null,
        to: event?.endAt ? { x: event.endAt.x, y: event.endAt.y } : null,
      };
    }
    case 'player_tag':
      return { ...base, playerId: candidate.playerId, speedKph: candidate.facts['speedKph'] ?? null };
    default:
      return base;
  }
}

export interface ValidationIssue {
  cueId: string;
  issue: string;
}

export function validateCueSheet(sheet: CueSheet): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bySlot = new Map<CueSlot, Cue[]>();
  for (const cue of sheet.cues) {
    if (!(cue.t1 > cue.t0)) issues.push({ cueId: cue.id, issue: 'non-positive duration' });
    if (cue.t0 < 0) issues.push({ cueId: cue.id, issue: 'negative start time' });
    if (cue.t0 > cue.expiresAt) issues.push({ cueId: cue.id, issue: 'aired after expiry' });
    if (Object.keys(cue.payload).length === 0) issues.push({ cueId: cue.id, issue: 'empty payload' });
    const list = bySlot.get(cue.slot) ?? [];
    list.push(cue);
    bySlot.set(cue.slot, list);
  }
  for (const [slot, cues] of bySlot) {
    if (!SLOT_SPECS[slot].exclusive) continue;
    const sorted = [...cues].sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.t0 < prev.t1) {
        issues.push({ cueId: cur.id, issue: `slot "${slot}" double-booked (overlaps ${prev.id})` });
      }
    }
  }
  return issues;
}

/** JSON Schema for graphics partners integrating Floodlight cue sheets. */
export const CUESHEET_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Floodlight Cue Sheet',
  type: 'object',
  required: ['version', 'matchId', 'cues', 'meta'],
  properties: {
    version: { const: '1.0' },
    matchId: { type: 'string' },
    meta: {
      type: 'object',
      required: ['homeAbbr', 'awayAbbr', 'competition'],
      properties: {
        homeAbbr: { type: 'string' },
        awayAbbr: { type: 'string' },
        competition: { type: 'string' },
        generatedBy: { type: 'string' },
      },
    },
    cues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 't0', 't1', 'slot', 'priority', 'animation', 'payload', 'source', 'expiresAt'],
        properties: {
          id: { type: 'string' },
          t0: { type: 'number', description: 'match seconds, cue goes on air' },
          t1: { type: 'number', description: 'match seconds, cue leaves air' },
          slot: { enum: ['lower_third', 'stat_bumper', 'momentum_ribbon', 'telestration', 'player_tag', 'goal_flash'] },
          priority: { type: 'integer', minimum: 0, maximum: 100 },
          animation: { enum: ['slide_in', 'draw', 'flash', 'pulse', 'pinned'] },
          payload: { type: 'object' },
          source: {
            type: 'object',
            required: ['momentId', 'evidenceEventIds', 'verified'],
            properties: {
              momentId: { type: 'string' },
              candidateId: { type: 'string' },
              evidenceEventIds: { type: 'array', items: { type: 'string' } },
              verified: { type: 'boolean' },
            },
          },
          expiresAt: { type: 'number' },
        },
      },
    },
  },
};
