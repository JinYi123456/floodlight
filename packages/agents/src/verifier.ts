/**
 * The Verifier — the crew's fact-checking gate.
 *
 * Every number in a draft must trace to the evidence pack; every named
 * entity must exist in the match vocabulary; record/season/history claims
 * are rejected because they are not derivable from live data. The verifier
 * is deterministic on purpose: model output can propose, only the
 * deterministic gate can approve.
 */

export interface EvidencePack {
  /** Every number the draft is allowed to cite. */
  allowedNumbers: number[];
  /** Every entity name (players, clubs, abbreviations) in scope. */
  vocabulary: string[];
}

export interface VerifierVerdict {
  approved: boolean;
  issues: string[];
}

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; issue: string }> = [
  { pattern: /\brecord\b/i, issue: 'record claims are not derivable from live data' },
  { pattern: /\bseason\b/i, issue: 'season-level claims are not derivable from live data' },
  { pattern: /\bcareer\b/i, issue: 'career claims are not derivable from live data' },
  { pattern: /\bhistory\b/i, issue: 'historical claims are not derivable from live data' },
  { pattern: /\bnever\b/i, issue: 'absolute claim "never" cannot be verified' },
  { pattern: /\balways\b/i, issue: 'absolute claim "always" cannot be verified' },
  { pattern: /\bguaranteed?\b/i, issue: 'certainty claims cannot be verified' },
  { pattern: /\bstatistically\b/i, issue: 'statistical rigor claims exceed the evidence' },
];

const NUMBER_PATTERN = /-?\d+(?:[.,]\d+)?/g;

export function buildEvidencePack(candidate: { facts: Record<string, string | number | boolean>; minuteLabel: string }, extraNumbers: number[], vocabulary: string[]): EvidencePack {
  const numbers: number[] = [...extraNumbers];
  for (const value of Object.values(candidate.facts)) {
    if (typeof value === 'number') numbers.push(value);
    if (typeof value === 'string') {
      for (const match of value.match(NUMBER_PATTERN) ?? []) {
        numbers.push(parseFloat(match.replace(',', '.')));
      }
    }
  }
  // Clock labels count as numbers too (70' → 70).
  for (const match of candidate.minuteLabel.match(NUMBER_PATTERN) ?? []) {
    numbers.push(parseFloat(match));
  }
  return { allowedNumbers: numbers, vocabulary };
}

export function verifyDraft(text: string, pack: EvidencePack, options: { checkEntities?: boolean } = {}): VerifierVerdict {
  const issues: string[] = [];

  for (const { pattern, issue } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) issues.push(issue);
  }

  const numbers = text.match(NUMBER_PATTERN) ?? [];
  for (const raw of numbers) {
    const value = parseFloat(raw.replace(',', '.'));
    const matches = (candidate: number): boolean => {
      if (Number.isNaN(candidate)) return false;
      const tolerance = Math.max(Math.abs(candidate) * 0.06, 0.05);
      if (Math.abs(value - candidate) <= tolerance) return true;
      // Rates near zero-to-one may appear as percentages (0.62 ↔ 62%).
      if (candidate > 0 && candidate < 1 && Math.abs(value - candidate * 100) <= Math.max(candidate * 100 * 0.06, 1)) return true;
      if (value > 0 && value < 1 && Math.abs(value * 100 - candidate) <= tolerance * 100) return true;
      return false;
    };
    if (!pack.allowedNumbers.some(matches)) {
      issues.push(`unverifiable number "${raw}"`);
    }
  }

  if (options.checkEntities !== false) {
    const allowed = new Set(pack.vocabulary.map((v) => v.toLowerCase()));
    const tokens = text.match(/\b[A-Z][a-zà-ÿ''-]{2,}\b/g) ?? [];
    const ignored = new Set([
      'The', 'A', 'An', 'And', 'But', 'Or', 'So', 'With', 'From', 'After', 'Before', 'This', 'That', 'It', 'He', 'She', 'His', 'Her',
      'Goal', 'Goals', 'Save', 'Saves', 'Chance', 'Chances', 'Pressure', 'Possession', 'Momentum', 'Review', 'Overturned', 'Offside',
      'Penalty', 'VAR', 'GOAL', 'HT', 'FT', 'Minute', 'Meridian', 'League', 'Monday', 'Saturday', 'Sunday', 'First', 'Second', 'Then',
      'Now', 'When', 'What', 'Why', 'Who', 'Here', 'There', 'Under', 'Over', 'Into', 'Inside', 'Outside', 'Still', 'Again', 'Only',
      'Set', 'Right', 'Left', 'Head', 'Foot', 'Box', 'Area', 'Half', 'Time', 'Full', 'Late', 'Early', 'Back', 'Front', 'Well',
      'Simply', 'Really', 'Almost', 'Nearly', 'Just', 'Even', 'Perhaps', 'Maybe', 'Those', 'These', 'They', 'We', 'Us', 'Our', 'You',
    ]);
    for (const token of tokens) {
      // Possessives of a known entity are still that entity: "Escobar's" is fine
      // when "Escobar" is in the vocabulary.
      const bare = token.replace(/[’']s$/, '');
      const lower = bare.toLowerCase();
      if (ignored.has(token) || ignored.has(bare) || allowed.has(lower)) continue;
      // Surnames count as valid if they appear inside a known full name.
      if ([...allowed].some((name) => name.includes(lower))) continue;
      issues.push(`unrecognised entity "${token}"`);
    }
  }

  return { approved: issues.length === 0, issues };
}
