/**
 * Template narratives — the crew's deterministic floor.
 *
 * Templates only ever interpolate values from the evidence pack, so a
 * template draft can never contain an unverifiable number. They are the
 * fallback when no model is available and the baseline every model draft is
 * measured against. Three languages ship out of the box.
 */

import type { MomentKind } from '@floodlight/engine';

export type Lang = 'en' | 'es' | 'fr';
export type Persona = 'analyst' | 'casual' | 'club' | 'player_focus';

export const LANGUAGES: Lang[] = ['en', 'es', 'fr'];
export const PERSONAS: Persona[] = ['analyst', 'casual', 'club', 'player_focus'];

export interface NarrativeContext {
  kind: MomentKind;
  minute: string;
  team: string;
  opponent: string;
  teamAbbr: string;
  opponentAbbr: string;
  player: string | null;
  score: string | null;
  facts: Record<string, string | number | boolean>;
}

interface PhraseSet {
  goalHeadline: (c: NarrativeContext) => string;
  goalBody: (c: NarrativeContext) => string;
  goalCasual: (c: NarrativeContext) => string;
  goalClub: (c: NarrativeContext) => string;
  goalPlayer: (c: NarrativeContext) => string;
  varReview: (c: NarrativeContext) => string;
  varOverturn: (c: NarrativeContext) => string;
  penalty: (c: NarrativeContext) => string;
  redCard: (c: NarrativeContext) => string;
  bigChance: (c: NarrativeContext) => string;
  bigSave: (c: NarrativeContext) => string;
  momentum: (c: NarrativeContext) => string;
  siege: (c: NarrativeContext) => string;
  comeback: (c: NarrativeContext) => string;
  lateDrama: (c: NarrativeContext) => string;
  milestone: (c: NarrativeContext) => string;
  speedFlash: (c: NarrativeContext) => string;
  tacticalPressure: (c: NarrativeContext) => string;
}

const num = (v: string | number | boolean | undefined, fallback = ''): string => (v === undefined ? fallback : String(v));
const pct = (v: string | number | boolean | undefined): string => {
  if (v === undefined) return '';
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? '' : n > 1 ? `${Math.round(n)}%` : `${Math.round(n * 100)}%`;
};

const EN: PhraseSet = {
  goalHeadline: (c) => `GOAL — ${c.player ?? c.teamAbbr} makes it ${c.score ?? ''}`.trim(),
  goalBody: (c) =>
    `${c.player ?? 'The finisher'} strikes from ${num(c.facts['distanceM'])} metres at ${num(c.facts['ballSpeedKph'])} km/h — a ${num(c.facts['xg'])} xG chance${c.facts['isPenalty'] ? ' from the spot' : ''}. The scoreline now reads ${c.score ?? ''}.`,
  goalCasual: (c) => `It's in! ${c.player ?? c.teamAbbr} scores and the score is ${c.score ?? ''}. The stadium erupts.`,
  goalClub: (c) => `YES! ${c.player ?? 'Our number nine'} buries it — ${c.score ?? ''} and this one matters. Come on!`,
  goalPlayer: (c) => `Watch ${c.player ?? 'the scorer'} here: a clean strike from ${num(c.facts['distanceM'])} metres, worth ${num(c.facts['xg'])} xG.`,
  varReview: () => 'The referee is checking... the goal is under review. Hold everything.',
  varOverturn: () => 'OVERTURNED. The goal is chalked off and the scoreline rolls back. The insights surrounding that moment are retracted.',
  penalty: (c) => `Penalty to ${c.team}! A huge chance at ${c.minute}.`,
  redCard: (c) => `RED CARD — ${num(c.facts['player'], 'a player')} is off (${num(c.facts['reason'], 'serious foul play')}). ${c.team} are down to ten.`,
  bigChance: (c) =>
    `Big chance for ${c.team}: ${c.player ?? 'the attacker'} gets a ${num(c.facts['xg'])} xG look from ${num(c.facts['distanceM'])} metres — ${num(c.facts['outcome'])}.`,
  bigSave: (c) => `What a save! Difficulty ${num(c.facts['difficulty'])} — ${c.player ?? 'the keeper'} denies a ${num(c.facts['xg'])} xG chance.`,
  momentum: (c) => `Momentum has swung to ${c.team} — a ${num(c.facts['swing'])} shift over the last five minutes.`,
  siege: (c) => `${c.team} are laying siege: ${num(c.facts['shotsLast10'])} shots in ten minutes with ${pct(c.facts['possessionShare'])} of the ball.`,
  comeback: (c) => `They're back in it! ${c.player ?? c.team} halves the deficit — ${c.score ?? ''}.`,
  lateDrama: (c) => `LATE DRAMA at ${c.minute}! ${c.team} strike with the clock nearly out — ${c.score ?? ''}.`,
  milestone: (c) => `${c.player ?? 'The scorer'} completes a ${num(c.facts['milestone'], 'special moment')} — ${num(c.facts['goals'])} goals today.`,
  speedFlash: (c) => `Blistering pace from ${num(c.facts['player'], 'the winger')}: ${num(c.facts['speedKph'])} km/h — the fastest of the match so far.`,
  tacticalPressure: (c) => `${c.team} have shifted the pressure: ${num(c.facts['detail'], 'higher line and quicker pressure')}.`,
};

const ES: PhraseSet = {
  goalHeadline: (c) => `GOL — ${c.player ?? c.teamAbbr} pone el ${c.score ?? ''}`.trim(),
  goalBody: (c) =>
    `${c.player ?? 'El delantero'} dispara desde ${num(c.facts['distanceM'])} metros a ${num(c.facts['ballSpeedKph'])} km/h — una ocasión de ${num(c.facts['xg'])} xG${c.facts['isPenalty'] ? ' desde el punto de penalti' : ''}. El marcador queda ${c.score ?? ''}.`,
  goalCasual: (c) => `¡Es gol! ${c.player ?? c.teamAbbr} marca y el resultado es ${c.score ?? ''}. Explota el estadio.`,
  goalClub: (c) => `¡SÍ! ${c.player ?? 'nuestro nueve'} la manda a guardar — ${c.score ?? ''} y esto importa. ¡Vamos!`,
  goalPlayer: (c) => `Mira a ${c.player ?? 'el goleador'}: un golpeo limpio desde ${num(c.facts['distanceM'])} metros, ${num(c.facts['xg'])} xG.`,
  varReview: () => 'El árbitro está revisando... el gol está bajo revisión. Esperen.',
  varOverturn: () => 'ANULADO. El gol se anula y el marcador retrocede. Las narrativas de ese momento quedan retiradas.',
  penalty: (c) => `¡Penalti para ${c.team}! Una ocasión enorme al ${c.minute}.`,
  redCard: (c) => `TARJETA ROJA — ${num(c.facts['player'], 'un jugador')} se va (${num(c.facts['reason'], 'juego brusco grave')}). ${c.team} se queda con diez.`,
  bigChance: (c) => `Ocasión clarísima para ${c.team}: ${c.player ?? 'el atacante'} con ${num(c.facts['xg'])} xG desde ${num(c.facts['distanceM'])} metros — ${num(c.facts['outcome'])}.`,
  bigSave: (c) => `¡Qué parada! Dificultad ${num(c.facts['difficulty'])} — ${c.player ?? 'el portero'} niega una ocasión de ${num(c.facts['xg'])} xG.`,
  momentum: (c) => `El momento cambió hacia ${c.team} — un giro de ${num(c.facts['swing'])} en cinco minutos.`,
  siege: (c) => `${c.team} asedia: ${num(c.facts['shotsLast10'])} remates en diez minutos con ${pct(c.facts['possessionShare'])} del balón.`,
  comeback: (c) => `¡Vuelven a meterse! ${c.player ?? c.team} recorta distancias — ${c.score ?? ''}.`,
  lateDrama: (c) => `¡DRAMA AL FINAL al ${c.minute}! ${c.team} golpea con el tiempo casi agotado — ${c.score ?? ''}.`,
  milestone: (c) => `${c.player ?? 'El goleador'} completa un ${num(c.facts['milestone'], 'momento especial')} — ${num(c.facts['goals'])} goles hoy.`,
  speedFlash: (c) => `Velocidad explosiva de ${num(c.facts['player'], 'el extremo')}: ${num(c.facts['speedKph'])} km/h — la más alta del partido hasta ahora.`,
  tacticalPressure: (c) => `${c.team} cambió la presión: ${num(c.facts['detail'], 'línea más alta y presión más rápida')}.`,
};

const FR: PhraseSet = {
  goalHeadline: (c) => `BUT — ${c.player ?? c.teamAbbr} porte le score à ${c.score ?? ''}`.trim(),
  goalBody: (c) =>
    `${c.player ?? "L'attaquant"} frappe depuis ${num(c.facts['distanceM'])} mètres à ${num(c.facts['ballSpeedKph'])} km/h — une occasion de ${num(c.facts['xg'])} xG${c.facts['isPenalty'] ? ' sur penalty' : ''}. Le score est de ${c.score ?? ''}.`,
  goalCasual: (c) => `C'est but ! ${c.player ?? c.teamAbbr} marque et le score est de ${c.score ?? ''}. Le stade explose.`,
  goalClub: (c) => `OUI ! ${c.player ?? 'notre numéro neuf'} la met au fond — ${c.score ?? ''} et ça compte. Allez !`,
  goalPlayer: (c) => `Regardez ${c.player ?? 'le buteur'} : une frappe propre depuis ${num(c.facts['distanceM'])} mètres, ${num(c.facts['xg'])} xG.`,
  varReview: () => "L'arbitre vérifie... le but est en cours de révision. Patientez.",
  varOverturn: () => 'ANNULÉ. Le but est refusé et le score revient en arrière. Les analyses de ce moment sont retirées.',
  penalty: (c) => `Penalty pour ${c.team} ! Une occasion énorme à la ${c.minute}.`,
  redCard: (c) => `CARTON ROUGE — ${num(c.facts['player'], 'un joueur')} sort (${num(c.facts['reason'], 'jeu dangereux')}). ${c.team} est réduit à dix.`,
  bigChance: (c) => `Grosse occasion pour ${c.team} : ${c.player ?? "l'attaquant"} avec ${num(c.facts['xg'])} xG depuis ${num(c.facts['distanceM'])} mètres — ${num(c.facts['outcome'])}.`,
  bigSave: (c) => `Quel arrêt ! Difficulté ${num(c.facts['difficulty'])} — ${c.player ?? 'le gardien'} repousse une occasion de ${num(c.facts['xg'])} xG.`,
  momentum: (c) => `Le momentum a basculé vers ${c.team} — un écart de ${num(c.facts['swing'])} sur cinq minutes.`,
  siege: (c) => `${c.team} assiège : ${num(c.facts['shotsLast10'])} tirs en dix minutes avec ${pct(c.facts['possessionShare'])} du ballon.`,
  comeback: (c) => `Ils reviennent ! ${c.player ?? c.team} réduit l'écart — ${c.score ?? ''}.`,
  lateDrama: (c) => `DRAME EN FIN DE MATCH à la ${c.minute} ! ${c.team} frappe à l'ultime moment — ${c.score ?? ''}.`,
  milestone: (c) => `${c.player ?? 'Le buteur'} réalise un ${num(c.facts['milestone'], 'moment spécial')} — ${num(c.facts['goals'])} buts aujourd'hui.`,
  speedFlash: (c) => `Vitesse fulgurante de ${num(c.facts['player'], "l'ailier")} : ${num(c.facts['speedKph'])} km/h — la plus élevée du match jusqu'ici.`,
  tacticalPressure: (c) => `${c.team} a changé la pression : ${num(c.facts['detail'], 'ligne plus haute et pressing plus rapide')}.`,
};

const PHRASES: Record<Lang, PhraseSet> = { en: EN, es: ES, fr: FR };

export interface TemplateNarrative {
  headline: string;
  body: string;
}

export function templateNarrative(ctx: NarrativeContext, persona: Persona, lang: Lang): TemplateNarrative {
  const p = PHRASES[lang];
  switch (ctx.kind) {
    case 'goal': {
      const headline = persona === 'club' ? p.goalClub(ctx) : persona === 'casual' ? p.goalCasual(ctx) : p.goalHeadline(ctx);
      const body = persona === 'player_focus' ? p.goalPlayer(ctx) : p.goalBody(ctx);
      return { headline, body };
    }
    case 'var_review':
      return { headline: 'Under review', body: p.varReview(ctx) };
    case 'var_overturn':
      return { headline: 'Overturned', body: p.varOverturn(ctx) };
    case 'penalty':
      return { headline: 'Penalty', body: p.penalty(ctx) };
    case 'red_card':
      return { headline: 'Red card', body: p.redCard(ctx) };
    case 'big_chance':
      return { headline: 'Big chance', body: p.bigChance(ctx) };
    case 'big_save':
      return { headline: 'Big save', body: p.bigSave(ctx) };
    case 'momentum_shift':
      return { headline: 'Momentum shift', body: p.momentum(ctx) };
    case 'siege':
      return { headline: 'Sustained pressure', body: p.siege(ctx) };
    case 'comeback_trigger':
      return { headline: 'Back in it', body: p.comeback(ctx) };
    case 'late_drama':
      return { headline: 'Late drama', body: p.lateDrama(ctx) };
    case 'milestone':
      return { headline: 'Milestone', body: p.milestone(ctx) };
    case 'speed_flash':
      return { headline: 'Fastest of the match', body: p.speedFlash(ctx) };
    case 'tactical_pressure':
      return { headline: 'Pressure shift', body: p.tacticalPressure(ctx) };
    default:
      return { headline: 'Moment', body: `${ctx.team} — ${ctx.minute}.` };
  }
}

/** Short ticker line for the live commentary feed. */
export function tickerLine(ctx: NarrativeContext, lang: Lang): string {
  const p = PHRASES[lang];
  switch (ctx.kind) {
    case 'goal':
      return p.goalHeadline(ctx);
    case 'var_overturn':
      return p.varOverturn(ctx);
    case 'red_card':
      return p.redCard(ctx);
    case 'penalty':
      return p.penalty(ctx);
    case 'big_save':
      return p.bigSave(ctx);
    case 'momentum_shift':
      return p.momentum(ctx);
    default:
      return `${ctx.minute} ${ctx.team}`;
  }
}
