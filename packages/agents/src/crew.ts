/**
 * The production crew — five agents, one broadcast.
 *
 *   Director      decides what deserves air and for how long
 *   Analyst       writes why a moment matters, citing evidence
 *   Commentator   writes the live ticker line
 *   Verifier      deterministic fact gate — nothing unchecked reaches air
 *   Personalizer  shapes the same verified story for each audience
 *
 * They coordinate through a shared evidence pack and hand off work through
 * the crew runtime, which provides retries, timeouts and template
 * fallbacks. A single story failing never stalls the production.
 */

import type { InsightCandidate, MatchEngine, MomentKind } from '@floodlight/engine';
import { CrewRuntime, type TaskTrace } from './runtime';
import { ProviderGateway } from './providers';
import { buildEvidencePack, verifyDraft, type VerifierVerdict } from './verifier';
import { LANGUAGES, PERSONAS, templateNarrative, tickerLine, type Lang, type NarrativeContext, type Persona } from './templates';

export interface ViewerProfile {
  persona: Persona;
  lang: Lang;
  clubId: string | null;
  playerId: string | null;
  metric: string | null;
}

export const DEFAULT_PROFILE: ViewerProfile = { persona: 'analyst', lang: 'en', clubId: null, playerId: null, metric: null };

export interface AirDecision {
  air: boolean;
  reason: 'selected' | 'below_threshold' | 'retracted';
  priority: number;
  ttlSeconds: number;
  slots: string[];
}

export interface NarrationVariant {
  persona: Persona;
  lang: Lang;
  headline: string;
  body: string;
}

export interface NarratedMoment {
  candidate: InsightCandidate;
  air: AirDecision;
  headline: string;
  body: string;
  lang: Lang;
  persona: Persona;
  provider: 'llm' | 'template';
  ticker: string | null;
  verification: VerifierVerdict;
  variants: NarrationVariant[];
}

export interface ProductionResult {
  moments: NarratedMoment[];
  traces: TaskTrace[];
  stats: ReturnType<CrewRuntime['stats']>;
}

export interface CrewOptions {
  gateway?: ProviderGateway;
  runtime?: CrewRuntime;
  profile?: ViewerProfile;
  /** Generate all persona × language variants (recording mode). */
  generateVariants?: boolean;
  /** Allow model-written ticker lines (recording mode). */
  useLLMCommentary?: boolean;
  minAirPriority?: number;
}

interface MomentBrief {
  candidate: InsightCandidate;
  context: NarrativeContext;
  evidenceNumbers: number[];
  vocabulary: string[];
}

const PRIORITY: Record<MomentKind, number> = {
  goal: 100,
  var_overturn: 100,
  red_card: 95,
  late_drama: 92,
  comeback_trigger: 88,
  penalty: 85,
  var_review: 80,
  milestone: 70,
  big_save: 65,
  siege: 60,
  momentum_shift: 58,
  big_chance: 55,
  tactical_pressure: 54,
  speed_flash: 52,
};

const TTL: Record<MomentKind, number> = {
  goal: 180,
  var_overturn: 120,
  red_card: 180,
  late_drama: 180,
  comeback_trigger: 150,
  penalty: 90,
  var_review: 90,
  milestone: 120,
  big_save: 25,
  siege: 300,
  momentum_shift: 240,
  big_chance: 25,
  tactical_pressure: 120,
  speed_flash: 12,
};

const SLOTS: Record<MomentKind, string[]> = {
  goal: ['lower_third', 'stat_bumper', 'goal_flash'],
  var_overturn: ['lower_third', 'goal_flash'],
  red_card: ['lower_third', 'stat_bumper'],
  late_drama: ['lower_third', 'goal_flash'],
  comeback_trigger: ['lower_third', 'momentum_ribbon'],
  penalty: ['lower_third', 'stat_bumper'],
  var_review: ['lower_third'],
  milestone: ['stat_bumper'],
  big_save: ['stat_bumper'],
  siege: ['stat_bumper', 'momentum_ribbon'],
  momentum_shift: ['momentum_ribbon', 'lower_third'],
  big_chance: ['telestration', 'stat_bumper'],
  tactical_pressure: ['stat_bumper'],
  speed_flash: ['player_tag'],
};

const LANG_NAME: Record<Lang, string> = { en: 'English', es: 'Spanish', fr: 'French' };

export class ProductionCrew {
  readonly runtime: CrewRuntime;
  private readonly options: CrewOptions;

  constructor(options: CrewOptions = {}) {
    this.options = options;
    this.runtime = options.runtime ?? new CrewRuntime();
    if (options.gateway) {
      this.runtime.setProviderHint(() => options.gateway!.lastProvider());
    }
  }

  /** Build the per-candidate brief once; every agent reads from it. */
  briefFor(candidate: InsightCandidate, engine: MatchEngine): MomentBrief {
    const state = engine.snapshot();
    const meta = state.meta;
    const side = candidate.team === 'away' ? 'away' : 'home';
    const team = meta[side];
    const opponent = meta[side === 'home' ? 'away' : 'home'];
    const player = candidate.playerId ? state.players.find((p) => p.playerId === candidate.playerId)?.name ?? null : null;
    const score = typeof candidate.facts['score'] === 'string'
      ? (candidate.facts['score'] as string)
      : (() => {
          const at = engine.scoreAt(candidate.t);
          return `${at.home}–${at.away}`;
        })();
    const window = candidate.window ?? { t0: Math.max(0, candidate.t - 300), t1: candidate.t };
    const features = engine.windowFeatures(window.t0, window.t1);
    const context: NarrativeContext = {
      kind: candidate.kind,
      minute: candidate.minuteLabel,
      team: team.name,
      opponent: opponent.name,
      teamAbbr: team.abbr,
      opponentAbbr: opponent.abbr,
      player,
      score,
      facts: candidate.facts,
    };
    const atTime = engine.scoreAt(candidate.t);
    const evidenceNumbers: number[] = [
      atTime.home,
      atTime.away,
      state.score.home,
      state.score.away,
      features.possessionHome,
      1 - features.possessionHome,
      features.completion,
      features.turnoversPerMinute,
      features.duelsPerMinute,
      features.passSpeedAvgKph,
      features.shots,
      Math.abs(features.xtBalance),
      state.controlChaos.control,
      state.controlChaos.chaos,
      Math.round(candidate.t / 60),
      parseFloat(candidate.minuteLabel) || 0,
    ];
    const vocabulary = [
      team.name, opponent.name, team.abbr, opponent.abbr,
      meta.venue.name, meta.venue.city,
      ...state.players.map((p) => p.name),
      ...state.players.map((p) => p.name.split(' ').slice(-1)[0]!) ,
    ];
    return { candidate, context, evidenceNumbers, vocabulary };
  }

  directorDecision(candidate: InsightCandidate): AirDecision {
    const priority = PRIORITY[candidate.kind] ?? 50;
    const minAir = this.options.minAirPriority ?? 50;
    if (candidate.overturned) {
      return { air: false, reason: 'retracted', priority, ttlSeconds: 0, slots: [] };
    }
    if (priority < minAir) {
      return { air: false, reason: 'below_threshold', priority, ttlSeconds: 0, slots: [] };
    }
    return { air: true, reason: 'selected', priority, ttlSeconds: TTL[candidate.kind] ?? 60, slots: SLOTS[candidate.kind] ?? ['stat_bumper'] };
  }

  /**
   * Process one candidate end to end: direction → analysis → verification →
   * commentary → personalization. Returns null when the director passes.
   */
  async processCandidate(candidate: InsightCandidate, engine: MatchEngine): Promise<NarratedMoment | null> {
    const air = this.directorDecision(candidate);
    if (!air.air) return null;

    const profile = this.options.profile ?? DEFAULT_PROFILE;
    const brief = this.briefFor(candidate, engine);
    const pack = buildEvidencePack(candidate, brief.evidenceNumbers, brief.vocabulary);

    // --- Analyst: model draft first, then a guided rewrite, then template.
    let headline = '';
    let body = '';
    let provider: 'llm' | 'template' = 'template';
    let issues: string[] = [];

    const analystTask = async (revision: string | null) => {
      if (!this.options.gateway) return null;
      const prompt = this.analystPrompt(brief, profile, revision);
      const result = await this.options.gateway.complete(prompt);
      if (!result) return null;
      const parsed = parseNarration(result.text);
      if (!parsed) throw new Error('analyst returned unparseable output');
      return parsed;
    };

    const outcome = await this.runtime.dispatch<{ revision: string | null }, { headline: string; body: string } | null>({
      agentId: 'analyst',
      kind: 'draft',
      input: { revision: null },
      run: async (input) => analystTask(input.revision),
      fallback: () => {
        const t = templateNarrative(brief.context, profile.persona, profile.lang);
        return { headline: t.headline, body: t.body };
      },
    });

    if (outcome.output) {
      headline = outcome.output.headline;
      body = outcome.output.body;
      provider = outcome.status === 'fallback' ? 'template' : 'llm';
    } else {
      const t = templateNarrative(brief.context, profile.persona, profile.lang);
      headline = t.headline;
      body = t.body;
      provider = 'template';
    }

    // Entity vocabulary constrains model free-text; authored templates are
    // trusted prose (their numbers are still verified against the evidence).
    let verdict: VerifierVerdict = verifyDraft(`${headline} ${body}`, pack, {
      checkEntities: provider === 'llm',
    });

    // One guided rewrite if the model produced unverifiable claims.
    if (!verdict.approved && provider === 'llm') {
      const rewrite = await this.runtime.dispatch<{ revision: string | null }, { headline: string; body: string } | null>({
        agentId: 'analyst',
        kind: 'rewrite',
        input: { revision: verdict.issues.join('; ') },
        run: async (input) => analystTask(input.revision),
        fallback: null as never,
        maxAttempts: 1,
      });
      if (rewrite.output) {
        const candidateVerdict = verifyDraft(`${rewrite.output.headline} ${rewrite.output.body}`, pack);
        if (candidateVerdict.approved) {
          headline = rewrite.output.headline;
          body = rewrite.output.body;
          verdict = candidateVerdict;
        }
      }
    }

    // Deterministic floor: templates can always clear the gate.
    if (!verdict.approved) {
      const t = templateNarrative(brief.context, profile.persona, profile.lang);
      headline = t.headline;
      body = t.body;
      provider = 'template';
      verdict = verifyDraft(`${headline} ${body}`, pack, { checkEntities: false });
      if (!verdict.approved) {
        // Metric-only fallback: the director airs the numbers, not a story.
        headline = `${brief.context.minute} ${brief.context.teamAbbr}`;
        body = Object.entries(candidate.facts)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        verdict = { approved: true, issues: [`template failed: ${verdict.issues.join('; ')}`] };
      }
    }

    // --- Commentator: the ticker line.
    let ticker: string | null = null;
    if (air.priority >= 55) {
      const commentary = await this.runtime.dispatch<null, string>({
        agentId: 'commentator',
        kind: 'ticker',
        input: null,
        run: async () => {
          if (!this.options.useLLMCommentary || !this.options.gateway) throw new Error('template path');
          const result = await this.options.gateway.complete(this.tickerPrompt(brief, profile));
          if (!result) throw new Error('no provider');
          const cleaned = result.text.split('\n')[0]!.trim();
          const check = verifyDraft(cleaned, pack);
          if (!check.approved) throw new Error('ticker failed verification');
          return cleaned;
        },
        fallback: () => tickerLine(brief.context, profile.lang),
        maxAttempts: 1,
      });
      ticker = commentary.output;
    }

    // --- Personalizer: audience variants.
    const variants: NarrationVariant[] = [];
    if (this.options.generateVariants) {
      for (const persona of PERSONAS) {
        for (const lang of LANGUAGES) {
          if (persona === profile.persona && lang === profile.lang) {
            variants.push({ persona, lang, headline, body });
            continue;
          }
          const t = templateNarrative(brief.context, persona, lang);
          variants.push({ persona, lang, headline: t.headline, body: t.body });
        }
      }
    }

    return {
      candidate,
      air,
      headline,
      body,
      lang: profile.lang,
      persona: profile.persona,
      provider,
      ticker,
      verification: verdict,
      variants,
    };
  }

  /** Process a whole match's candidate feed in order. */
  async runMatch(candidates: InsightCandidate[], engine: MatchEngine): Promise<ProductionResult> {
    const moments: NarratedMoment[] = [];
    for (const candidate of candidates) {
      const moment = await this.processCandidate(candidate, engine);
      if (moment) moments.push(moment);
    }
    return { moments, traces: this.runtime.allTraces(), stats: this.runtime.stats() };
  }

  /* ----------------------------- prompts ----------------------------- */

  private analystPrompt(brief: MomentBrief, profile: ViewerProfile, revision: string | null): { system: string; user: string } {
    const personaBrief: Record<Persona, string> = {
      analyst: 'metric-dense and precise',
      casual: 'plain language, energetic, zero jargon',
      club: `written for supporters of ${brief.context.team} — warm, partisan, "we"`,
      player_focus: `focused on ${brief.context.player ?? 'the key player'} — what they did and why it mattered`,
    };
    const system = [
      "You are the Analyst in Floodlight's live football production crew.",
      'Explain WHY the moment matters, never just what happened.',
      'Use ONLY numbers and names present in the evidence JSON.',
      `Write in ${LANG_NAME[profile.lang]}. Tone: ${personaBrief[profile.persona]}.`,
      'At most two sentences. Return strict JSON: {"headline": string, "body": string}.',
      'The minute is displayed separately — do not prefix or repeat it in the headline.',
      revision ? `A previous draft was rejected by the verifier for: ${revision}. Fix exactly these problems.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const user = JSON.stringify({
      moment: brief.context.kind,
      minute: brief.context.minute,
      team: brief.context.team,
      opponent: brief.context.opponent,
      player: brief.context.player,
      score: brief.context.score,
      facts: brief.context.facts,
    });
    return { system, user };
  }

  private tickerPrompt(brief: MomentBrief, profile: ViewerProfile): { system: string; user: string } {
    const system = [
      'You are the Commentator in a live football broadcast.',
      'Write ONE short ticker line (max 12 words) for the moment. Use only evidence numbers.',
      `Write in ${LANG_NAME[profile.lang]}. Return plain text, no quotes, no JSON.`,
    ].join('\n');
    const user = JSON.stringify({ moment: brief.context.kind, minute: brief.context.minute, facts: brief.context.facts, score: brief.context.score });
    return { system, user };
  }
}

/** Tolerant JSON extraction from model output. */
export function parseNarration(text: string): { headline: string; body: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { headline?: unknown; body?: unknown };
    if (typeof parsed.headline === 'string' && typeof parsed.body === 'string' && parsed.headline.length > 0 && parsed.body.length > 0) {
      return { headline: parsed.headline.trim(), body: parsed.body.trim() };
    }
  } catch {
    // fall through
  }
  return null;
}
