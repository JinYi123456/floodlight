import type { InsightCandidate } from '@floodlight/engine';
import type { MatchEvent } from '@floodlight/core';
import type { NarratedMoment, NarrationSource } from './crew';
import { LANGUAGES, PERSONAS } from './templates';
import { VERIFIER_VERSION, verifyFinalNarration, type EvidencePack, type FinalNarration } from './verifier';

export const RECORDING_SCHEMA_VERSION = 2;
export interface RecordingBinding {
  schemaVersion: typeof RECORDING_SCHEMA_VERSION;
  verifierVersion: typeof VERIFIER_VERSION;
  scenarioId: string | null;
  seed: number;
  evidenceFingerprint: string;
}
export interface RecordedMoment extends FinalNarration {
  candidateId: string;
  provider: 'llm' | 'template';
}
export interface StudioRecording extends RecordingBinding {
  provider: string;
  model: string;
  moments: RecordedMoment[];
}
export interface RecordingEvidence {
  scenarioId: string | null;
  seed: number;
  meta: unknown;
  events: readonly MatchEvent[];
  candidates: readonly InsightCandidate[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** Browser/Node WebCrypto; local computation only, never an API call. */
export async function createRecordingBinding(evidence: RecordingEvidence): Promise<RecordingBinding> {
  const data = new TextEncoder().encode(canonical(evidence));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const evidenceFingerprint = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return { schemaVersion: RECORDING_SCHEMA_VERSION, verifierVersion: VERIFIER_VERSION,
    scenarioId: evidence.scenarioId, seed: evidence.seed, evidenceFingerprint };
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function audience(v: unknown): boolean {
  return object(v) && PERSONAS.includes(v.persona as never) && LANGUAGES.includes(v.lang as never)
    && typeof v.headline === 'string' && v.headline.length > 0 && typeof v.body === 'string' && v.body.length > 0;
}
export function validateRecording(value: unknown, expected: RecordingBinding): { recording: StudioRecording | null; issues: string[] } {
  const issues: string[] = [];
  if (!object(value)) return { recording: null, issues: ['recording unavailable or invalid'] };
  for (const key of ['schemaVersion', 'verifierVersion', 'scenarioId', 'seed', 'evidenceFingerprint'] as const) {
    if (value[key] !== expected[key]) issues.push(`recording ${key} mismatch`);
  }
  if (typeof value.provider !== 'string' || typeof value.model !== 'string' || !Array.isArray(value.moments)) issues.push('invalid recording schema');
  const ids = new Set<string>();
  if (Array.isArray(value.moments)) for (const m of value.moments) {
    if (!object(m) || !audience(m) || typeof m.candidateId !== 'string' || ids.has(m.candidateId)
      || !['llm', 'template'].includes(m.provider as string) || !(m.ticker === null || typeof m.ticker === 'string')
      || !Array.isArray(m.variants) || !m.variants.every(audience)) {
      issues.push('invalid or duplicate recorded moment');
      continue;
    }
    ids.add(m.candidateId);
  }
  return { recording: issues.length ? null : value as unknown as StudioRecording, issues };
}

/** Never mutate the fresh fallback or trust serialized verification flags. */
export function applyRecordedMoment(fresh: NarratedMoment, recorded: RecordedMoment, pack: EvidencePack): { moment: NarratedMoment; issues: string[] } {
  const keys = (variants: FinalNarration['variants']) => variants.map((v) => `${v.persona}:${v.lang}`).sort().join('|');
  if (recorded.candidateId !== fresh.candidate.id || recorded.lang !== fresh.lang || recorded.persona !== fresh.persona
    || keys(recorded.variants) !== keys(fresh.variants)) return { moment: fresh, issues: ['recording candidate/audience binding mismatch'] };
  const verification = verifyFinalNarration(recorded, pack);
  if (!verification.approved) return { moment: fresh, issues: verification.issues };
  return { moment: { ...fresh, headline: recorded.headline, body: recorded.body, ticker: recorded.ticker,
    variants: recorded.variants.map((variant) => ({ ...variant, source: 'recorded' })),
    source: 'recorded', tickerSource: recorded.ticker === null ? null : 'recorded', provider: recorded.provider, verification }, issues: [] };
}

export interface ProviderSummary {
  /** Task outcomes, not aired prose counts. No-provider/null calls are fallbacks. */
  completed: number;
  fallback: number;
  failed: number;
  recorded: boolean;
  /** Counts by actual primary narrative source; not by attempted inference. */
  aired: Record<NarrationSource, number>;
  /** Includes the narrative, ticker and each audience variant separately. */
  airedSurfaces: Record<NarrationSource, number>;
  recordingStatus: 'not_requested' | 'rejected' | 'accepted' | 'partial';
  recordingIssues: string[];
}
export function summarizeProviders(moments: NarratedMoment[], stats: { completed: number; fallback: number; failed: number }, requested: boolean, recordingIssues: string[]): ProviderSummary {
  const aired = { model: 0, template: 0, recorded: 0 };
  const airedSurfaces = { model: 0, template: 0, recorded: 0 };
  for (const moment of moments) {
    aired[moment.source]++;
    airedSurfaces[moment.source]++;
    if (moment.ticker !== null && moment.tickerSource) airedSurfaces[moment.tickerSource]++;
    for (const variant of moment.variants) airedSurfaces[variant.source ?? 'template']++;
  }
  return { completed: stats.completed, fallback: stats.fallback, failed: stats.failed, aired, airedSurfaces,
    recorded: aired.recorded > 0, recordingIssues,
    recordingStatus: !requested ? 'not_requested' : aired.recorded === 0 ? 'rejected' : recordingIssues.length ? 'partial' : 'accepted' };
}
