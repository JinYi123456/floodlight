import type { InsightCandidate, MatchEngine, MomentKind } from '@floodlight/engine';
import { CrewRuntime, type TaskTrace } from './runtime';
import { ProviderGateway } from './providers';
import { liveFacts, type MatchFacts } from './facts';
import { buildEvidencePack, verifyDraft, verifyFinalNarration, type EvidencePack, type VerifierVerdict } from './verifier';
import { LANGUAGES, PERSONAS, metricOnlyNarrative, templateNarrative, tickerLine, type Lang, type NarrativeContext, type Persona } from './templates';

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
export type NarrationSource = 'model' | 'template' | 'recorded';
export interface NarrationVariant {
  persona: Persona;
  lang: Lang;
  headline: string;
  body: string;
  source?: NarrationSource;
}
export interface NarratedMoment {
  candidate: InsightCandidate;
  air: AirDecision;
  headline: string;
  body: string;
  lang: Lang;
  persona: Persona;
  provider: 'llm' | 'template';
  source: NarrationSource;
  ticker: string | null;
  tickerSource: NarrationSource | null;
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
  /** The live worker supplies the real SDK MCP client. */
  facts?: MatchFacts;
  generateVariants?: boolean;
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
  goal: 100, var_overturn: 100, red_card: 95, late_drama: 92, comeback_trigger: 88, penalty: 85,
  var_review: 80, milestone: 70, big_save: 65, siege: 60, momentum_shift: 58, big_chance: 55, tactical_pressure: 54, speed_flash: 52,
};
const TTL: Record<MomentKind, number> = {
  goal: 180, var_overturn: 120, red_card: 180, late_drama: 180, comeback_trigger: 150, penalty: 90,
  var_review: 90, milestone: 120, big_save: 25, siege: 300, momentum_shift: 240, big_chance: 25, tactical_pressure: 120, speed_flash: 12,
};
const SLOTS: Record<MomentKind, string[]> = {
  goal: ['lower_third', 'stat_bumper', 'goal_flash'], var_overturn: ['lower_third', 'goal_flash'],
  red_card: ['lower_third', 'stat_bumper'], late_drama: ['lower_third', 'goal_flash'],
  comeback_trigger: ['lower_third', 'momentum_ribbon'], penalty: ['lower_third', 'stat_bumper'],
  var_review: ['lower_third'], milestone: ['stat_bumper'], big_save: ['stat_bumper'],
  siege: ['stat_bumper', 'momentum_ribbon'], momentum_shift: ['momentum_ribbon', 'lower_third'],
  big_chance: ['telestration', 'stat_bumper'], tactical_pressure: ['stat_bumper'], speed_flash: ['player_tag'],
};

export class ProductionCrew {
  readonly runtime: CrewRuntime;
  private readonly options: CrewOptions;
  constructor(options: CrewOptions = {}) {
    this.options = options;
    this.runtime = options.runtime ?? new CrewRuntime();
    if (options.gateway) this.runtime.setProviderHint(() => options.gateway!.lastProvider());
  }

  async briefFor(candidate: InsightCandidate, engine: MatchEngine): Promise<MomentBrief> {
    const facts = this.options.facts ?? liveFacts(engine);
    const state = await facts.snapshot();
    const side = candidate.team === 'away' ? 'away' : 'home';
    const team = state.meta[side];
    const opponent = state.meta[side === 'home' ? 'away' : 'home'];
    const player = candidate.playerId ? state.players.find((p) => p.playerId === candidate.playerId)?.name ?? null : null;
    // Snapshot is used for identities only. Never put final totals into a past brief.
    const atTime = await facts.scoreAt(candidate.t);
    const window = candidate.window ?? { t0: Math.max(0, candidate.t - 300), t1: candidate.t };
    await facts.windowFeatures(window.t0, Math.min(window.t1, candidate.t));
    const context: NarrativeContext = {
      kind: candidate.kind, minute: candidate.minuteLabel,
      team: candidate.team === 'none' ? 'Match' : team.name,
      opponent: opponent.name, teamAbbr: team.abbr, opponentAbbr: opponent.abbr,
      player, score: `${atTime.home}–${atTime.away}`, scoreAt: atTime,
      facts: candidate.facts, asOf: candidate.t, window: candidate.window,
    };
    const vocabulary = ['Match', team.name, opponent.name, team.abbr, opponent.abbr,
      state.meta.venue.name, state.meta.venue.city, ...state.players.map((p) => p.name)];
    return { candidate, context, evidenceNumbers: [], vocabulary };
  }

  async evidenceFor(candidate: InsightCandidate, engine: MatchEngine): Promise<EvidencePack> {
    const brief = await this.briefFor(candidate, engine);
    return buildEvidencePack(candidate, [], brief.vocabulary, brief.context);
  }

  directorDecision(candidate: InsightCandidate): AirDecision {
    const priority = PRIORITY[candidate.kind] ?? 50;
    if (candidate.overturned) return { air: false, reason: 'retracted', priority, ttlSeconds: 0, slots: [] };
    if (priority < (this.options.minAirPriority ?? 50)) return { air: false, reason: 'below_threshold', priority, ttlSeconds: 0, slots: [] };
    return { air: true, reason: 'selected', priority, ttlSeconds: TTL[candidate.kind] ?? 60, slots: SLOTS[candidate.kind] ?? ['stat_bumper'] };
  }

  async processCandidate(candidate: InsightCandidate, engine: MatchEngine): Promise<NarratedMoment | null> {
    const air = this.directorDecision(candidate);
    if (!air.air) return null;
    const profile = this.options.profile ?? DEFAULT_PROFILE;
    const pack = await this.evidenceFor(candidate, engine);
    const context = pack.context!;
    const binding = { persona: profile.persona, lang: profile.lang, surface: 'narrative' as const };
    const safeNarrative = (persona: Persona, lang: Lang) => {
      const draft = templateNarrative(context, persona, lang);
      const verdict = verifyDraft(`${draft.headline} ${draft.body}`, pack, { binding: { persona, lang, surface: 'narrative' } });
      return verdict.approved ? draft : metricOnlyNarrative(context, lang);
    };
    const template = safeNarrative(profile.persona, profile.lang);
    const analystTask = async (revision: string | null, signal: AbortSignal) => {
      if (!this.options.gateway) throw new Error('no model configured');
      const result = await this.options.gateway.complete({
        system: 'Return strict JSON with headline and body. Copy the evidence-bound option exactly. Do not add explanations, causality, names or numbers.',
        user: JSON.stringify({ option: template, revision }),
      }, signal);
      if (!result) throw new Error('no model inference completed');
      const parsed = parseNarration(result.text);
      if (!parsed) throw new Error('analyst returned unparseable output');
      return parsed;
    };
    const outcome = await this.runtime.dispatch({
      agentId: 'analyst', kind: 'draft', input: null,
      run: (_, ctx) => analystTask(null, ctx.signal),
      fallback: () => template,
      maxAttempts: this.options.gateway ? 2 : 0,
    });
    let draft = outcome.output ?? template;
    let provider: NarratedMoment['provider'] = outcome.status === 'completed' ? 'llm' : 'template';
    let verdict = verifyDraft(`${draft.headline} ${draft.body}`, pack, { binding });
    if (!verdict.approved && provider === 'llm') {
      const rewrite = await this.runtime.dispatch({
        agentId: 'analyst', kind: 'rewrite', input: verdict.issues.join('; '),
        run: (revision, ctx) => analystTask(revision, ctx.signal), maxAttempts: 1,
      });
      if (rewrite.output) {
        const check = verifyDraft(`${rewrite.output.headline} ${rewrite.output.body}`, pack, { binding });
        if (check.approved) { draft = rewrite.output; verdict = check; }
      }
    }
    if (!verdict.approved) { draft = template; provider = 'template'; }

    let ticker: string | null = null;
    let tickerSource: NarrationSource | null = null;
    if (air.priority >= 55) {
      const safeTicker = tickerLine(context, profile.lang);
      const commentary = await this.runtime.dispatch({
        agentId: 'commentator', kind: 'ticker', input: null,
        run: async (_, ctx) => {
          if (!this.options.gateway) throw new Error('no model configured');
          const result = await this.options.gateway.complete({ system: 'Copy the evidence-bound ticker exactly. Return only the text.', user: safeTicker }, ctx.signal);
          if (!result) throw new Error('no model inference completed');
          return result.text;
        },
        fallback: () => safeTicker,
        maxAttempts: this.options.useLLMCommentary && this.options.gateway ? 1 : 0,
      });
      ticker = commentary.output;
      const tickerBinding = { ...binding, surface: 'ticker' as const };
      tickerSource = commentary.status === 'completed' ? 'model' : 'template';
      if (ticker === null || !verifyDraft(ticker, pack, { binding: tickerBinding }).approved) {
        ticker = verifyDraft(safeTicker, pack, { binding: tickerBinding }).approved ? safeTicker : null;
        tickerSource = ticker ? 'template' : null;
      }
    }
    const source: NarrationSource = provider === 'llm' ? 'model' : 'template';
    const variants: NarrationVariant[] = [];
    if (this.options.generateVariants) {
      for (const persona of PERSONAS) for (const lang of LANGUAGES) {
        const primary = persona === profile.persona && lang === profile.lang;
        variants.push({ persona, lang, ...(primary ? draft : safeNarrative(persona, lang)), source: primary ? source : 'template' });
      }
    }
    const moment: NarratedMoment = { candidate, air, ...draft, lang: profile.lang, persona: profile.persona, provider, source, ticker, tickerSource, verification: verdict, variants };
    moment.verification = verifyFinalNarration(moment, pack);
    // Even the facts-only floor must really pass. Never force an approved flag.
    if (!moment.verification.approved) return null;
    return moment;
  }

  async runMatch(candidates: InsightCandidate[], engine: MatchEngine): Promise<ProductionResult> {
    const moments: NarratedMoment[] = [];
    for (const candidate of candidates) {
      const moment = await this.processCandidate(candidate, engine);
      if (moment) moments.push(moment);
    }
    return { moments, traces: this.runtime.allTraces(), stats: this.runtime.stats() };
  }
}

export function parseNarration(text: string): { headline: string; body: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { headline?: unknown; body?: unknown };
    if (typeof parsed.headline === 'string' && typeof parsed.body === 'string' && parsed.headline.trim() && parsed.body.trim()) {
      return { headline: parsed.headline.trim(), body: parsed.body.trim() };
    }
  } catch { /* Invalid model output takes the deterministic path. */ }
  return null;
}
