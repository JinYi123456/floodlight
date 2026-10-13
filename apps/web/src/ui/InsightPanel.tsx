/**
 * The insight desk — the drill-down on a single moment: what was said, why
 * the director aired it, which numbers passed the verifier, and the exact
 * events the story is anchored to. Also hosts the retraction view for goals
 * that VAR chalked off after the broadcast had already built the story.
 */

import { useMemo } from 'react';
import { formatClock } from '@floodlight/core';
import type { MatchEvent } from '@floodlight/core';
import type { InsightCandidate } from '@floodlight/engine';
import type { NarratedMoment } from '@floodlight/agents';
import { useAppStore } from '../state/store';
import { viewerText } from '../state/derive';
import { kindStyle } from './kinds';

const PERSONA_LABELS: Record<string, string> = {
  analyst: 'Analyst',
  casual: 'Casual',
  club: 'Club heart',
  player_focus: 'Player focus',
};

const LANG_LABELS: Record<string, string> = { en: 'EN', es: 'ES', fr: 'FR' };

type DeskView =
  | { type: 'moment'; moment: NarratedMoment }
  | { type: 'retracted'; candidate: InsightCandidate }
  | null;

export function InsightPanel() {
  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.t);
  const prefs = useAppStore((state) => state.prefs);
  const selectedMomentId = useAppStore((state) => state.selectedMomentId);
  const scrub = useAppStore((state) => state.scrub);
  const pause = useAppStore((state) => state.pause);

  const view: DeskView = useMemo(() => {
    if (!match) return null;
    if (selectedMomentId) {
      const picked = match.moments.find((m) => m.candidate.id === selectedMomentId);
      if (picked) return { type: 'moment', moment: picked };
      const retracted = match.candidates.find((c) => c.id === selectedMomentId && c.overturned);
      if (retracted) return { type: 'retracted', candidate: retracted };
    }
    const aired = match.moments.filter((m) => m.air.air && m.candidate.t <= t);
    const latest = aired.at(-1) ?? match.moments.find((m) => m.air.air) ?? null;
    return latest ? { type: 'moment', moment: latest } : null;
  }, [match, selectedMomentId, t]);

  if (!match) return null;

  const followLive = () => useAppStore.getState().selectMoment(null);

  if (!view) {
    return (
      <section className="insight-panel empty">
        <h2>Insight desk</h2>
        <p>Waiting for the first story of the match…</p>
      </section>
    );
  }

  if (view.type === 'retracted') {
    const { candidate } = view;
    const overturn = match.moments.find((m) => m.candidate.kind === 'var_overturn');
    const playerName =
      [...match.lineups.home, ...match.lineups.away].find((p) => p.id === candidate.playerId)?.name ?? 'The scorer';
    const evidence = candidate.evidenceEventIds
      .map((id) => match.events.find((e) => e.id === id))
      .filter((e): e is MatchEvent => Boolean(e));
    return (
      <section className="insight-panel">
        <header className="desk-head">
          <h2>Insight desk</h2>
          <button type="button" className="ghost small" onClick={followLive}>
            follow live
          </button>
        </header>
        <div className="desk-card retracted">
          <div className="desk-meta">
            <span className="kind-badge" style={{ background: '#ff5c7a' }}>
              RETRACTED
            </span>
            <span className="desk-minute">{candidate.minuteLabel}</span>
            <span className="verify-chip warn">pulled by VAR</span>
          </div>
          <h3>Goal chalked off — story pulled</h3>
          <p className="desk-body">
            {playerName} had the ball in the net and the production line had already drafted the moment. The review at{' '}
            {overturn ? overturn.candidate.minuteLabel : 'the next stoppage'} overturned it: the scoreline rolled back,
            the lower third was killed, and every asset bound to this story was retracted before it could air.
          </p>
          <div className="desk-actions">
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                pause();
                scrub(Math.max(0, candidate.t - 6));
              }}
            >
              replay the disallowed goal
            </button>
            {overturn && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  pause();
                  scrub(Math.max(0, overturn.candidate.t - 4));
                }}
              >
                jump to the review ({overturn.candidate.minuteLabel})
              </button>
            )}
          </div>
        </div>
        <FactsBlock facts={Object.entries(candidate.facts)} />
        <EvidenceBlock evidence={evidence} match={match} />
      </section>
    );
  }

  const { moment } = view;
  const style = kindStyle(moment.candidate.kind);
  const text = viewerText(moment, prefs.persona, prefs.lang);
  const facts = Object.entries(moment.candidate.facts);
  const evidence = moment.candidate.evidenceEventIds
    .map((id) => match.events.find((e) => e.id === id))
    .filter((e): e is MatchEvent => Boolean(e));

  return (
    <section className="insight-panel">
      <header className="desk-head">
        <h2>Insight desk</h2>
        <button type="button" className="ghost small" onClick={followLive}>
          follow live
        </button>
      </header>

      <div className="desk-card">
        <div className="desk-meta">
          <span className="kind-badge" style={{ background: style.color }}>
            {style.label}
          </span>
          <span className="desk-minute">{moment.candidate.minuteLabel}</span>
          <span className={`verify-chip ${moment.verification.approved ? 'ok' : 'warn'}`}>
            {moment.verification.approved ? 'verified' : 'template floor'}
          </span>
        </div>
        <h3>{text.headline}</h3>
        <p className="desk-body">{text.body}</p>
        <div className="desk-tags">
          <span>
            {PERSONA_LABELS[prefs.persona] ?? prefs.persona} · {LANG_LABELS[prefs.lang] ?? prefs.lang}
          </span>
          <span>priority {moment.air.priority}</span>
          <span>ttl {moment.air.ttlSeconds}s</span>
          {moment.provider === 'llm' && <span className="llm-chip">model voice</span>}
        </div>
        <div className="desk-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              pause();
              scrub(Math.max(0, moment.candidate.t - 6));
            }}
          >
            replay from 6s before
          </button>
          {moment.candidate.window && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                pause();
                scrub(Math.max(0, (moment.candidate.window?.t0 ?? moment.candidate.t) - 4));
              }}
            >
              evidence window {formatClock(moment.candidate.window.t0)}–{formatClock(moment.candidate.window.t1)}
            </button>
          )}
        </div>
      </div>

      <FactsBlock facts={facts} />

      <EvidenceBlock evidence={evidence} match={match} />

      {moment.verification.issues.length > 0 && (
        <div className="desk-block warn">
          <h4>Verifier notes</h4>
          <ul>
            {moment.verification.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function FactsBlock({ facts }: { facts: Array<[string, string | number | boolean]> }) {
  if (facts.length === 0) return null;
  return (
    <div className="desk-block">
      <h4>What the numbers say</h4>
      <ul className="facts-grid">
        {facts.map(([key, value]) => (
          <li key={key}>
            <span>{labelize(key)}</span>
            <strong>{String(value)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceBlock({
  evidence,
  match,
}: {
  evidence: MatchEvent[];
  match: NonNullable<ReturnType<typeof useAppStore.getState>['match']>;
}) {
  if (evidence.length === 0) return null;
  return (
    <div className="desk-block">
      <h4>Evidence trail</h4>
      <ul className="evidence-list">
        {evidence.map((event) => (
          <li key={event.id}>
            <span className="evidence-t">{formatClock(event.t)}</span>
            <span className="evidence-type">{event.type.replace(/_/g, ' ')}</span>
            <span className="evidence-desc">{describeEvent(event, match)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeEvent(
  event: MatchEvent,
  match: NonNullable<ReturnType<typeof useAppStore.getState>['match']>,
): string {
  const nameOf = (id: string | null | undefined) =>
    [...match.lineups.home, ...match.lineups.away].find((p) => p.id === id)?.name ?? '—';

  switch (event.type) {
    case 'pass':
      return `${nameOf(event.playerId)} → ${nameOf(event.recipientId)}, ${Math.round(event.lengthM)}m${
        event.outcome === 'complete' ? '' : ` (${event.outcome})`
      }`;
    case 'carry':
      return `${nameOf(event.playerId)} carries ${Math.round(event.lengthM)}m`;
    case 'shot':
      return `${nameOf(event.playerId)} shoots — ${String(event.outcome).replace(/_/g, ' ')}, ${event.xg.toFixed(2)} xG`;
    case 'tackle':
      return `${nameOf(event.playerId)} tackles — ${event.tackleOutcome} vs ${nameOf(event.opponentId)}`;
    case 'foul':
      return `${nameOf(event.playerId)} fouls ${nameOf(event.fouledPlayerId)}`;
    case 'yellow_card':
    case 'red_card':
      return `${nameOf(event.playerId)} — ${event.reason}`;
    case 'corner':
    case 'goal_kick':
    case 'throw_in':
    case 'offside':
    case 'penalty':
    case 'var_check':
      return event.detail;
    case 'substitution':
      return `${nameOf(event.playerOffId)} off, ${nameOf(event.playerId)} on`;
    case 'possession_change':
      return `possession to ${event.toTeam} (${event.cause})`;
    default:
      return String((event as { type: string }).type);
  }
}

function labelize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
