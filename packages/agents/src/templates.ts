import type { MomentKind } from '@floodlight/engine';
import { scopedNumericFacts, type NumericFact } from './evidence';

export type Lang = 'en' | 'es' | 'fr';
export type Persona = 'analyst' | 'casual' | 'club' | 'player_focus';
export const LANGUAGES: Lang[] = ['en', 'es', 'fr'];
export const PERSONAS: Persona[] = ['analyst', 'casual', 'club', 'player_focus'];

export interface NarrativeContext {
  kind: MomentKind;
  minute: string;
  team: string;
  opponent: string;
  /** The side the story is about; absent on neutral, whole-match frames. */
  teamSide?: 'home' | 'away' | null;
  teamAbbr: string;
  opponentAbbr: string;
  player: string | null;
  score: string | null;
  facts: Record<string, string | number | boolean>;
  asOf?: number;
  window?: { t0: number; t1: number } | null;
  scoreAt?: { home: number; away: number };
}

export interface TemplateNarrative { headline: string; body: string }

const TITLES: Record<MomentKind, [string, string, string]> = {
  goal: ['Goal', 'Gol', 'But'],
  var_review: ['Under review', 'Bajo revisión', 'En cours de révision'],
  var_overturn: ['Goal overturned', 'Gol anulado', 'But annulé'],
  penalty: ['Penalty awarded', 'Penalti concedido', 'Penalty accordé'],
  red_card: ['Red card', 'Tarjeta roja', 'Carton rouge'],
  big_chance: ['Chance', 'Ocasión', 'Occasion'],
  big_save: ['Save', 'Parada', 'Arrêt'],
  momentum_shift: ['Momentum swing', 'Cambio de impulso', 'Changement de momentum'],
  siege: ['Sustained pressure', 'Presión sostenida', 'Pression soutenue'],
  comeback_trigger: ['Score update', 'Marcador actualizado', 'Score actualisé'],
  late_drama: ['Late goal', 'Gol tardío', 'But tardif'],
  milestone: ['Scorer update', 'Goleador', 'Buteur'],
  speed_flash: ['Speed check', 'Velocidad', 'Vitesse'],
  tactical_pressure: ['Pressure check', 'Presión', 'Pression'],
};

const METRIC_LABELS: Record<string, [string, string, string]> = {
  'shot distance': ['distance', 'distancia', 'distance'],
  'ball speed': ['ball speed', 'velocidad', 'vitesse'],
  'shot xG': ['xG', 'xG', 'xG'],
  'opposing shot xG': ['xG faced', 'xG recibido', 'xG concédé'],
  'save difficulty estimate': ['save difficulty', 'dificultad', 'difficulté'],
  goals: ['goals', 'goles', 'buts'],
  'observed speed': ['speed', 'velocidad', 'vitesse'],
  'deficit before goal': ['deficit', 'desventaja', 'retard'],
  'momentum index change': ['momentum', 'impulso', 'momentum'],
  'shots in window': ['shots', 'tiros', 'tirs'],
  'possession in window': ['possession', 'posesión', 'possession'],
};

type Phrase = {
  frame: (ctx: NarrativeContext) => string;
  goal: (ctx: NarrativeContext, subject: string) => string;
  bigChance: (ctx: NarrativeContext, subject: string) => string;
  siege: (ctx: NarrativeContext) => string;
  momentum: (ctx: NarrativeContext) => string;
  milestone: (ctx: NarrativeContext, subject: string) => string;
  speed: (ctx: NarrativeContext, subject: string) => string;
  comeback: (ctx: NarrativeContext) => string;
  review: string;
  overturn: string;
  penalty: string;
  red: (ctx: NarrativeContext, subject: string) => string;
  late: (ctx: NarrativeContext) => string;
  pressure: (ctx: NarrativeContext) => string;
};

const PHRASES: Record<Lang, Phrase> = {
  en: {
    frame: (ctx) => ctx.team === 'Match'
      ? `${ctx.minute} — score ${scoreText(ctx)}.`
      : `${ctx.minute} — ${ctx.team} ${scoreText(ctx)} ${ctx.opponent}.`,
    goal: (ctx, subject) => {
      const distance = value(ctx, 'distanceM', 'm');
      const speed = value(ctx, 'ballSpeedKph', 'km/h');
      const xg = value(ctx, 'xg', 'xG');
      const parts = [distance && `${subject} finished from ${distance}`, speed && `at ${speed}`, xg && `(${xg} expected goals)`]
        .filter(Boolean);
      return parts.length ? `${parts.join(' ')}.` : `${subject} found the net.`;
    },
    bigChance: (ctx, subject) => {
      const distance = value(ctx, 'distanceM', 'm');
      const xg = value(ctx, 'xg', 'xG');
      const parts = [`${subject} had a chance`, distance && `from ${distance}`, xg && `worth ${xg}`].filter(Boolean);
      return `${parts.join(' ')}.`;
    },
    siege: (ctx) => {
      const shots = value(ctx, 'shotsLast10', '');
      const oppShots = value(ctx, 'opponentShotsLast10', '');
      const possession = percent(ctx, 'possessionShare');
      const parts = [`Over the last ten minutes ${ctx.team} had ${shots ?? 'the better'} shots to ${oppShots ?? 'fewer'}`];
      if (possession) parts.push(`with ${possession} of the ball`);
      return `${parts.join(' ')}.`;
    },
    momentum: (ctx) => {
      const swing = value(ctx, 'swing', 'index');
      return swing ? `The momentum index moved ${swing} over the window.` : `The momentum has shifted toward ${ctx.team}.`;
    },
    milestone: (ctx, subject) => {
      const goals = value(ctx, 'goals', 'goals');
      return goals ? `${subject} now has ${goals} in this match.` : `${subject} is on the scoresheet again.`;
    },
    speed: (ctx, subject) => {
      const speed = value(ctx, 'speedKph', 'km/h');
      return speed ? `${subject} was clocked at ${speed}.` : `${subject} produced the standout run.`;
    },
    comeback: (ctx) => {
      const deficit = value(ctx, 'deficitBefore', 'goals');
      return deficit ? `${ctx.team} had trailed by ${deficit} before this goal.` : `${ctx.team} are back in the game.`;
    },
    review: 'The goal is under review.',
    overturn: 'The review has overturned the goal.',
    penalty: 'A penalty has been awarded.',
    red: (_ctx, subject) => `${subject} was shown a red card.`,
    late: (ctx) => `A late goal has changed the score to ${scoreText(ctx)}.`,
    pressure: (ctx) => `${ctx.team} are applying pressure.`,
  },
  es: {
    frame: (ctx) => ctx.team === 'Match'
      ? `${ctx.minute} — marcador ${scoreText(ctx)}.`
      : `${ctx.minute} — ${ctx.team} ${scoreText(ctx)} ${ctx.opponent}.`,
    goal: (ctx, subject) => {
      const distance = value(ctx, 'distanceM', 'm');
      const speed = value(ctx, 'ballSpeedKph', 'km/h');
      const xg = value(ctx, 'xg', 'xG');
      return `${subject} remató${distance ? ` desde ${distance}` : ''}${speed ? ` a ${speed}` : ''}${xg ? ` (${xg} de xG)` : ''}.`;
    },
    bigChance: (ctx, subject) => {
      const distance = value(ctx, 'distanceM', 'm');
      const xg = value(ctx, 'xg', 'xG');
      return `${subject} tuvo una ocasión${distance ? ` desde ${distance}` : ''}${xg ? ` de ${xg}` : ''}.`;
    },
    siege: (ctx) => {
      const shots = value(ctx, 'shotsLast10', '');
      const opp = value(ctx, 'opponentShotsLast10', '');
      const poss = percent(ctx, 'possessionShare');
      return `En los últimos diez minutos ${ctx.team} tiró ${shots ?? 'más'} veces frente a ${opp ?? 'menos'}${poss ? `, con ${poss} de posesión` : ''}.`;
    },
    momentum: (ctx) => {
      const swing = value(ctx, 'swing', 'index');
      return swing ? `El índice de impulso cambió ${swing} en el intervalo.` : `El impulso favorece a ${ctx.team}.`;
    },
    milestone: (ctx, subject) => {
      const goals = value(ctx, 'goals', 'goles');
      return goals ? `${subject} ya suma ${goals} en este partido.` : `${subject} vuelve a marcar.`;
    },
    speed: (ctx, subject) => {
      const speed = value(ctx, 'speedKph', 'km/h');
      return speed ? `${subject} alcanzó ${speed}.` : `${subject} firmó la carrera destacada.`;
    },
    comeback: (ctx) => {
      const deficit = value(ctx, 'deficitBefore', 'goles');
      return deficit ? `${ctx.team} perdía por ${deficit} antes de este gol.` : `${ctx.team} vuelve al partido.`;
    },
    review: 'El gol está bajo revisión.',
    overturn: 'La revisión ha anulado el gol.',
    penalty: 'Se ha concedido un penalti.',
    red: (_ctx, subject) => `${subject} vio la tarjeta roja.`,
    late: (ctx) => `Un gol tardío ha puesto el ${scoreText(ctx)}.`,
    pressure: (ctx) => `${ctx.team} está apretando.`,
  },
  fr: {
    frame: (ctx) => ctx.team === 'Match'
      ? `${ctx.minute} — score ${scoreText(ctx)}.`
      : `${ctx.minute} — ${ctx.team} ${scoreText(ctx)} ${ctx.opponent}.`,
    goal: (ctx, subject) => {
      const distance = value(ctx, 'distanceM', 'm');
      const speed = value(ctx, 'ballSpeedKph', 'km/h');
      const xg = value(ctx, 'xg', 'xG');
      return `${subject} a conclu${distance ? ` à ${distance}` : ''}${speed ? ` à ${speed}` : ''}${xg ? ` (${xg} xG)` : ''}.`;
    },
    bigChance: (ctx, subject) => {
      const distance = value(ctx, 'distanceM', 'm');
      const xg = value(ctx, 'xg', 'xG');
      return `${subject} a eu une occasion${distance ? ` à ${distance}` : ''}${xg ? ` de ${xg}` : ''}.`;
    },
    siege: (ctx) => {
      const shots = value(ctx, 'shotsLast10', '');
      const opp = value(ctx, 'opponentShotsLast10', '');
      const poss = percent(ctx, 'possessionShare');
      return `Sur les dix dernières minutes, ${ctx.team} a tiré ${shots ?? 'davantage'} fois contre ${opp ?? 'moins'}${poss ? `, avec ${poss} de possession` : ''}.`;
    },
    momentum: (ctx) => {
      const swing = value(ctx, 'swing', 'index');
      return swing ? `L'indice de momentum a évolué de ${swing} sur la période.` : `Le momentum est du côté de ${ctx.team}.`;
    },
    milestone: (ctx, subject) => {
      const goals = value(ctx, 'goals', 'buts');
      return goals ? `${subject} en est à ${goals} dans ce match.` : `${subject} marque à nouveau.`;
    },
    speed: (ctx, subject) => {
      const speed = value(ctx, 'speedKph', 'km/h');
      return speed ? `${subject} a été chronométré à ${speed}.` : `${subject} a signé la course clé.`;
    },
    comeback: (ctx) => {
      const deficit = value(ctx, 'deficitBefore', 'buts');
      return deficit ? `${ctx.team} était mené de ${deficit} avant ce but.` : `${ctx.team} revient dans le match.`;
    },
    review: 'Le but est en cours de révision.',
    overturn: 'La révision a annulé le but.',
    penalty: 'Un penalty a été accordé.',
    red: (_ctx, subject) => `${subject} a reçu un carton rouge.`,
    late: (ctx) => `Un but tardif porte le score à ${scoreText(ctx)}.`,
    pressure: (ctx) => `${ctx.team} met la pression.`,
  },
};

const languageIndex = (lang: Lang): number => LANGUAGES.indexOf(lang);

function scoreText(ctx: NarrativeContext): string {
  if (!ctx.scoreAt) return ctx.score ?? '0–0';
  return ctx.teamSide === 'away'
    ? `${ctx.scoreAt.away}–${ctx.scoreAt.home}`
    : `${ctx.scoreAt.home}–${ctx.scoreAt.away}`;
}

function factFor(ctx: NarrativeContext, key: string): NumericFact | undefined {
  return scopedNumericFacts(ctx).find((fact) => fact.id === key);
}

function value(ctx: NarrativeContext, key: string, unit: string): string | null {
  const fact = factFor(ctx, key);
  if (!fact) return null;
  if (fact.unit === 'fraction') return `${(fact.value * 100).toFixed(0)}%`;
  if (fact.unit === 'xG') return fact.value.toFixed(2);
  if (fact.unit === 'km/h') return `${fact.value.toFixed(1)} km/h`;
  if (fact.unit === 'm') return `${Math.round(fact.value)} m`;
  if (fact.unit === 'index' && unit === 'index') return `${fact.value > 0 ? '+' : ''}${fact.value.toFixed(2)}`;
  if (fact.unit === 'goals') return `${fact.value}`;
  return `${fact.value}${unit && fact.unit !== 'index' ? ` ${unit}` : ''}`.trim();
}

function percent(ctx: NarrativeContext, key: string): string | null {
  const fact = factFor(ctx, key);
  return fact ? `${Math.round(fact.value * 100)}%` : null;
}

function subjectFor(ctx: NarrativeContext, persona: Persona): string {
  if (persona === 'club') return ctx.team;
  if (persona === 'player_focus') return ctx.player ?? ctx.team;
  return ctx.player ?? ctx.team;
}

function kindSentence(ctx: NarrativeContext, persona: Persona, lang: Lang, subject: string): string {
  const p = PHRASES[lang];
  switch (ctx.kind) {
    case 'goal': return p.goal(ctx, subject);
    case 'big_chance': return p.bigChance(ctx, subject);
    case 'big_save': {
      const xg = value(ctx, 'xg', 'xG');
      if (lang === 'es') return `El portero evitó un tiro de ${xg ?? 'mucho'} xG.`;
      if (lang === 'fr') return `Le gardien a repoussé un tir de ${xg ?? 'beaucoup'} xG.`;
      return `The keeper denied a ${xg ?? 'high-value'} xG chance.`;
    }
    case 'siege': return p.siege(ctx);
    case 'momentum_shift': return p.momentum(ctx);
    case 'milestone': return p.milestone(ctx, subject);
    case 'speed_flash': return p.speed(ctx, subject);
    case 'comeback_trigger': return p.comeback(ctx);
    case 'var_review': return p.review;
    case 'var_overturn': return p.overturn;
    case 'penalty': return p.penalty;
    case 'red_card': return p.red(ctx, subject);
    case 'late_drama': return p.late(ctx);
    case 'tactical_pressure': return p.pressure(ctx);
    default: return '';
  }
}

/** Facts-only floor. No raw detail, outcome reason or model prose. */
export function metricOnlyNarrative(ctx: NarrativeContext, lang: Lang): TemplateNarrative {
  const i = languageIndex(lang);
  const score = scopedNumericFacts(ctx).filter((fact) => fact.metric === 'score');
  const time = Number.isFinite(ctx.asOf) ? `${ctx.asOf} s` : /^\d+(?:\+\d+)?'$/.test(ctx.minute) ? ctx.minute : '';
  const body = score.length === 2
    ? `${['Score (home–away)', 'Marcador (local–visitante)', 'Score (domicile–extérieur)'][i]}: ${score[0]!.value}–${score[1]!.value}.`
    : `${['Match observation', 'Observación del partido', 'Observation du match'][i]}.`;
  return { headline: `${['Match update', 'Actualización', 'Actualisation'][i]} · ${time}`.trim(), body };
}

/** Controlled, evidence-bound rendering. Every number comes from a typed
 *  fact (subject, metric, unit, as-of time); the verifier compares the exact
 *  rendering, so no model prose can inherit this approval. */
export function templateNarrative(ctx: NarrativeContext, persona: Persona, lang: Lang): TemplateNarrative {
  const i = languageIndex(lang);
  const subject = subjectFor(ctx, persona);
  const title = TITLES[ctx.kind]?.[i] ?? ['Match update', 'Actualización', 'Actualisation'][i];
  const frame = PHRASES[lang].frame(ctx);
  const detail = kindSentence(ctx, persona, lang, subject);
  return { headline: `${title} · ${subject}`, body: `${frame}${detail ? ` ${detail}` : ''}`.trim() };
}

export function tickerLine(ctx: NarrativeContext, lang: Lang): string {
  const narrative = templateNarrative(ctx, 'analyst', lang);
  return `${narrative.headline}. ${PHRASES[lang].frame(ctx)}`;
}
