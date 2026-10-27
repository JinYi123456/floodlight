import { useMemo } from 'react';
import { formatClock, type MatchEvent } from '@floodlight/core';
import { useAppStore } from '../state/store';
import { deskAt, retractionAt, textForViewer } from '../state/derive';
import { kindStyle } from './kinds';
import type { PreparedMatch } from '../pipeline/protocol';

const PERSONA_LABELS: Record<string, string> = { analyst: 'Analyst', casual: 'Casual', club: 'Club heart', player_focus: 'Player focus' };
const LANG_LABELS: Record<string, string> = { en: 'EN', es: 'ES', fr: 'FR' };

export function InsightPanel() {
  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.t);
  const prefs = useAppStore((state) => state.prefs);
  const selectedMomentId = useAppStore((state) => state.selectedMomentId);
  const replay = useAppStore((state) => state.replay);
  const view = useMemo(() => match ? deskAt(match, t, selectedMomentId, prefs) : null, [match, selectedMomentId, t, prefs]);
  if (!match) return null;
  const followLive = () => useAppStore.getState().selectMoment(null);
  if (!view) return (
    <section className="insight-panel empty">
      <h2>Insight desk</h2>
      <p>{prefs.clubId || prefs.playerId || prefs.metric ? 'No aired story matches this focus yet. The desk updates as matching evidence arrives.' : 'Waiting for the first story of the match…'}</p>
    </section>
  );

  if (view.type === 'retracted') {
    const { candidate } = view;
    const decisionT = retractionAt(match, candidate);
    const scorer = nameOf(match, candidate.playerId);
    const evidence = candidate.evidenceEventIds.map((id) => match.events.find((e) => e.id === id && e.t <= t))
      .filter((e): e is MatchEvent => Boolean(e));
    return (
      <section className="insight-panel">
        <header className="desk-head"><h2>Insight desk</h2><button type="button" className="ghost small" onClick={followLive}>follow live</button></header>
        <div className="desk-card retracted">
          <div className="desk-meta"><span className="kind-badge" style={{ background: '#ff5c7a' }}>RETRACTED</span><span className="verify-chip warn">pulled by VAR</span></div>
          <h3>Goal chalked off — story pulled</h3>
          <p className="desk-body">{scorer}'s provisional goal was overturned at {formatClock(decisionT)}. The score and the story were corrected at the review decision, not before it.</p>
          <div className="desk-actions">
            <button type="button" className="ghost small" onClick={() => replay(Math.max(0, candidate.t - 6))}>replay the disallowed goal</button>
            <button type="button" className="ghost small" onClick={() => replay(Math.max(0, decisionT - 4))}>replay the review</button>
          </div>
        </div>
        <FactsBlock facts={Object.entries(candidate.facts)} />
        <EvidenceBlock evidence={evidence} match={match} />
      </section>
    );
  }

  const { moment } = view;
  const style = kindStyle(moment.candidate.kind);
  const text = textForViewer(match, moment, prefs);
  const evidence = moment.candidate.evidenceEventIds.map((id) => match.events.find((e) => e.id === id && e.t <= t))
    .filter((e): e is MatchEvent => Boolean(e));
  return (
    <section className="insight-panel">
      <header className="desk-head"><h2>Insight desk</h2><button type="button" className="ghost small" onClick={followLive}>follow live</button></header>
      <div className="desk-card">
        <div className="desk-meta">
          <span className="kind-badge" style={{ background: style.color }}>{style.label}</span>
          <span className="desk-minute">{moment.candidate.minuteLabel}</span>
          <span className={`verify-chip ${moment.verification.approved ? 'ok' : 'warn'}`}>{moment.verification.approved ? 'evidence checked' : 'unverified'}</span>
        </div>
        <h3>{text.headline}</h3><p className="desk-body">{text.body}</p>
        <div className="desk-tags">
          <span>{PERSONA_LABELS[prefs.persona] ?? prefs.persona} · {LANG_LABELS[prefs.lang] ?? prefs.lang}</span>
          <span>priority {moment.air.priority}</span><span>ttl {moment.air.ttlSeconds}s</span>
          <span className={text.source === 'llm' ? 'llm-chip' : ''}>{text.source === 'llm' ? 'recorded model voice' : 'evidence template'}</span>
        </div>
        <div className="desk-actions">
          <button type="button" className="ghost small" onClick={() => replay(Math.max(0, moment.candidate.t - 6))}>replay from 6s before</button>
          {moment.candidate.window && moment.candidate.window.t1 <= t && (
            <button type="button" className="ghost small" onClick={() => replay(Math.max(0, moment.candidate.window!.t0 - 4))}>
              evidence window {formatClock(moment.candidate.window.t0)}–{formatClock(moment.candidate.window.t1)}
            </button>
          )}
        </div>
      </div>
      <FactsBlock facts={Object.entries(moment.candidate.facts)} />
      <EvidenceBlock evidence={evidence} match={match} />
      {moment.verification.issues.length > 0 && (
        <div className="desk-block warn"><h4>Verifier notes</h4><ul>{moment.verification.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>
      )}
    </section>
  );
}

function FactsBlock({ facts }: { facts: Array<[string, string | number | boolean]> }) {
  if (!facts.length) return null;
  return <div className="desk-block"><h4>What the numbers say</h4><ul className="facts-grid">{facts.map(([key, value]) => (
    <li key={key}><span>{labelize(key)}</span><strong>{String(value)}</strong></li>
  ))}</ul></div>;
}

function EvidenceBlock({ evidence, match }: { evidence: MatchEvent[]; match: PreparedMatch }) {
  if (!evidence.length) return null;
  return <div className="desk-block"><h4>Evidence trail</h4><ul className="evidence-list">{evidence.map((event) => (
    <li key={event.id}><span className="evidence-t">{formatClock(event.t)}</span><span className="evidence-type">{event.type.replace(/_/g, ' ')}</span><span className="evidence-desc">{describeEvent(event, match)}</span></li>
  ))}</ul></div>;
}

function nameOf(match: PreparedMatch, id: string | null | undefined): string {
  return [...match.lineups.home, ...match.lineups.away, ...match.bench.home, ...match.bench.away].find((p) => p.id === id)?.name ?? '—';
}

function describeEvent(event: MatchEvent, match: PreparedMatch): string {
  switch (event.type) {
    case 'pass': return `${nameOf(match, event.playerId)} → ${nameOf(match, event.recipientId)}, ${Math.round(event.lengthM)}m${event.outcome === 'complete' ? '' : ` (${event.outcome})`}`;
    case 'carry': return `${nameOf(match, event.playerId)} carries ${Math.round(event.lengthM)}m`;
    case 'shot': return `${nameOf(match, event.playerId)} shoots — ${event.outcome.replace(/_/g, ' ')}, ${event.xg.toFixed(2)} xG`;
    case 'tackle': return `${nameOf(match, event.playerId)} tackles — ${event.tackleOutcome} vs ${nameOf(match, event.opponentId)}`;
    case 'foul': return `${nameOf(match, event.playerId)} fouls ${nameOf(match, event.fouledPlayerId)}`;
    case 'yellow_card': case 'red_card': return `${nameOf(match, event.playerId)} — ${event.reason}`;
    case 'corner': case 'goal_kick': case 'throw_in': case 'offside': case 'penalty': case 'var_check': return event.detail;
    case 'substitution': return `${nameOf(match, event.playerOffId)} off, ${nameOf(match, event.playerOnId)} on`;
    case 'possession_change': return `possession to ${event.toTeam} (${event.cause})`;
    default: return event.type.replace(/_/g, ' ');
  }
}

function labelize(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}
