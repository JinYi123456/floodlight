import { scopedNumericFacts, matchesNumericFact, type NumericClaim, type NumericFact } from './evidence';
import { LANGUAGES, PERSONAS, metricOnlyNarrative, templateNarrative, tickerLine, type Lang, type NarrativeContext, type Persona } from './templates';

export const VERIFIER_VERSION = 'evidence-bound-v2';
export type VerificationBasis = 'evidence_bound' | 'supported_heuristic' | 'rejected';
export interface EvidencePack {
  /** Legacy input retained for callers; a number bag grants no authority. */
  allowedNumbers: number[];
  vocabulary: string[];
  numericFacts?: NumericFact[];
  context?: NarrativeContext;
}
export interface VerifierVerdict {
  approved: boolean;
  issues: string[];
  basis: VerificationBasis;
}

export function buildEvidencePack(
  candidate: { facts: Record<string, string | number | boolean>; minuteLabel: string; t?: number },
  _extraNumbers: number[], vocabulary: string[], context?: NarrativeContext,
): EvidencePack {
  // The caller supplies trusted match identities/score, never model or recording fields.
  const bound = context ? structuredClone({ ...context, facts: candidate.facts, minute: candidate.minuteLabel, asOf: candidate.t ?? context.asOf }) : undefined;
  return { allowedNumbers: [], vocabulary: [...vocabulary], numericFacts: bound ? scopedNumericFacts(bound) : [], context: bound };
}

export function verifyNumericClaim(claim: NumericClaim, pack: EvidencePack): VerifierVerdict {
  const approved = (pack.numericFacts ?? []).some((fact) => matchesNumericFact(claim, fact));
  return { approved, issues: approved ? [] : ['numeric claim has no matching subject/metric/unit/time evidence'], basis: approved ? 'evidence_bound' : 'rejected' };
}

export interface DraftBinding {
  persona: Persona;
  lang: Lang;
  surface: 'narrative' | 'ticker';
}

/** Exact canonical render membership, NOT semantic verification of free-form prose.
 * Even correctly copied numbers cannot license causality, names or number words.
 */
export function verifyDraft(text: string, pack: EvidencePack, options: { checkEntities?: boolean; binding?: DraftBinding } = {}): VerifierVerdict {
  const ctx = pack.context;
  const binding = options.binding;
  const reject = (issue: string): VerifierVerdict => ({ approved: false, issues: [issue], basis: 'rejected' });
  if (!ctx || !binding) return reject('unbound free-form text is not semantically verified');
  if (!PERSONAS.includes(binding.persona) || !LANGUAGES.includes(binding.lang)) return reject('unsupported audience binding');
  if (!Number.isFinite(ctx.asOf) || (ctx.window && (ctx.window.t0 > ctx.window.t1 || ctx.window.t1 > ctx.asOf!))) return reject('invalid or future evidence time');
  const floor = metricOnlyNarrative(ctx, binding.lang);
  if (binding.surface === 'narrative' && text === `${floor.headline} ${floor.body}`) {
    return { approved: true, issues: [], basis: 'evidence_bound' };
  }
  const allowedNames = new Set(pack.vocabulary.map((name) => name.toLocaleLowerCase()));
  if ([ctx.team, ctx.opponent, ctx.player].some((name) => name && !allowedNames.has(name.toLocaleLowerCase()))) return reject('unrecognised bound entity');
  const rendered = templateNarrative(ctx, binding.persona, binding.lang);
  const expected = binding.surface === 'ticker' ? tickerLine(ctx, binding.lang) : `${rendered.headline} ${rendered.body}`;
  if (text !== expected) return reject('text differs from its evidence-bound rendering');
  const heuristic = ['big_chance', 'big_save', 'momentum_shift', 'siege', 'late_drama', 'comeback_trigger', 'tactical_pressure'].includes(ctx.kind);
  return { approved: true, issues: [], basis: heuristic ? 'supported_heuristic' : 'evidence_bound' };
}

export interface FinalNarration {
  headline: string;
  body: string;
  persona: Persona;
  lang: Lang;
  ticker: string | null;
  variants: Array<{ headline: string; body: string; persona: Persona; lang: Lang }>;
}

/** Re-run this AFTER every override. No inherited verdict can approve new copy. */
export function verifyFinalNarration(output: FinalNarration, pack: EvidencePack): VerifierVerdict {
  const checks = [verifyDraft(`${output.headline} ${output.body}`, pack, { binding: { persona: output.persona, lang: output.lang, surface: 'narrative' } })];
  if (output.ticker !== null) checks.push(verifyDraft(output.ticker, pack, { binding: { persona: output.persona, lang: output.lang, surface: 'ticker' } }));
  for (const variant of output.variants) checks.push(verifyDraft(`${variant.headline} ${variant.body}`, pack, { binding: { persona: variant.persona, lang: variant.lang, surface: 'narrative' } }));
  const issues = checks.flatMap((check, i) => check.issues.map((issue) => `surface ${i}: ${issue}`));
  return { approved: issues.length === 0, issues, basis: issues.length ? 'rejected' : checks.some((check) => check.basis === 'supported_heuristic') ? 'supported_heuristic' : 'evidence_bound' };
}
