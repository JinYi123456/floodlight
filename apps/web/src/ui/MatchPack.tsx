/**
 * The Match Pack — the page a viewer opens at half-time.
 *
 * Everything here is computed live from the event stream up to the theatre
 * clock: the XI on a pitch in its formation, the bench with used
 * substitutions ticked, the substitution timeline, head-to-head stats
 * (possession, territory, final-third entries, shots, xG), the shot map
 * and a win-probability curve from a simple Poisson model on the scoreline
 * and the xG each side has generated.
 */

import { formatMinute } from '@floodlight/core';
import { useMemo } from 'react';
import { useAppStore } from '../state/store';
import type { OutcomeProbabilities } from '../state/winProbability';
import { buildModel, type PackModel, type Side, type TeamAggregate } from '../state/matchPack';
import type { PreparedMatch } from '../pipeline/protocol';

function nameOf(match: PreparedMatch, id: string): string {
  const all = [...match.lineups.home, ...match.lineups.away, ...match.bench.home, ...match.bench.away];
  return all.find((p) => p.id === id)?.name ?? id;
}

export function MatchPack() {
  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.match && state.t >= state.match.timing.fullTimeT ? state.match.timing.fullTimeT : Math.floor(state.t));
  const model = useMemo(() => match ? buildModel(match, t) : null, [match, t]);
  if (!match || !model) return null;

  const now = model.winCurve[model.winCurve.length - 1] ?? { home: 0, draw: 1, away: 0 };

  return (
    <div className="match-pack">
      <div className="pack-grid pack-xi">
        {(['home', 'away'] as const).map((side) => (
          <FormationCard key={side} match={match} side={side} usedOn={model.usedOn} avg={model.avgPos[side]} />
        ))}
        <div className="pack-card">
          <h3>Substitutions</h3>
          {model.subs.length === 0 ? (
            <p className="pack-empty">No substitutions yet — both benches intact.</p>
          ) : (
            <ul className="subs-list">
              {model.subs.map((sub) => (
                <li key={`${sub.t}-${sub.on}`}>
                  <span className="sub-minute">{formatMinute(sub.t)}</span>
                  <span
                    className="kit-chip small"
                    style={{
                      background: (sub.team === 'home' ? match.meta.home : match.meta.away).primary,
                      color: (sub.team === 'home' ? match.meta.home : match.meta.away).onPrimary,
                    }}
                  >
                    {(sub.team === 'home' ? match.meta.home : match.meta.away).abbr}
                  </span>
                  <span className="sub-off">{nameOf(match, sub.off)}</span>
                  <span className="sub-arrow">→</span>
                  <span className="sub-on">{nameOf(match, sub.on)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="pack-grid">
        <StatsCard match={match} aggregates={model.aggregates} />
        <ShotMap match={match} shots={model.shots} />
        <WinProb match={match} model={model} now={now} />
      </div>
    </div>
  );
}

function FormationCard({
  match,
  side,
  usedOn,
  avg,
}: {
  match: PreparedMatch;
  side: Side;
  usedOn: Set<string>;
  avg: Map<string, { x: number; y: number; count: number }>;
}) {
  const club = side === 'home' ? match.meta.home : match.meta.away;
  const xi = match.lineups[side];
  const bench = match.bench[side];
  // World → card: the card is drawn right-facing for both teams.
  const cardX = (worldX: number) => (side === 'home' ? worldX + 52.5 : 52.5 - worldX);
  const cardY = (worldY: number) => 34 + worldY * 0.88;
  return (
    <div className="pack-card">
      <h3>
        {club.name} <em>{match.formations[side]}</em>
      </h3>
      <svg viewBox="0 0 105 68" className="xi-pitch" role="img" aria-label={`${club.name} shape`}>
        <rect x="0.5" y="0.5" width="104" height="67" rx="1.5" className="xi-line" />
        <line x1="52.5" y1="0.5" x2="52.5" y2="67.5" className="xi-line" />
        <circle cx="52.5" cy="34" r="9.15" className="xi-line" />
        <rect x="0.5" y="13.85" width="16.5" height="40.3" className="xi-line" />
        <rect x="88" y="13.85" width="16.5" height="40.3" className="xi-line" />
        {xi.map((player) => {
          const ax = (player.slotX ?? 0.1) * 105;
          const ay = 34 + (player.slotY ?? 0) * 30;
          const entry = avg.get(player.id);
          const hasAvg = Boolean(entry && entry.count >= 3);
          const px = hasAvg && entry ? cardX(entry.x / entry.count) : ax;
          const py = hasAvg && entry ? cardY(entry.y / entry.count) : ay;
          const isKeeper = player.role === 'GK';
          return (
            <g key={player.id}>
              {hasAvg && <circle cx={ax} cy={ay} r={2.1} fill="none" stroke={club.primary} strokeOpacity={0.4} strokeWidth={0.45} />}
              <circle cx={px} cy={py} r={3.4} fill={isKeeper ? club.secondary : club.primary} />
              <text x={px} y={py + 1.2} textAnchor="middle" className="xi-number">
                {player.shirt}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="pack-foot">Solid dots: average position of each player's actions. Rings: the formation station.</p>
      <ul className="bench-list">
        {bench.map((player) => (
          <li key={player.id} className={usedOn.has(player.id) ? 'used' : ''}>
            <span className="bench-shirt">{player.shirt}</span>
            <span className="bench-name">{player.name}</span>
            {usedOn.has(player.id) && <span className="bench-flag">ON</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatsCard({ match, aggregates }: { match: PreparedMatch; aggregates: Record<Side, TeamAggregate> }) {
  const ftTotal = aggregates.home.thirdEntries + aggregates.away.thirdEntries;
  const tiltHome = ftTotal > 0 ? aggregates.home.thirdEntries / ftTotal : 0.5;
  const rows: Array<{ label: string; home: string; away: string; h: number; a: number }> = [
    { label: 'Possession', home: `${Math.round(aggregates.home.possession * 100)}%`, away: `${Math.round(aggregates.away.possession * 100)}%`, h: aggregates.home.possession, a: aggregates.away.possession },
    {
      label: 'Passes',
      home: `${aggregates.home.completed}/${aggregates.home.passes}`,
      away: `${aggregates.away.completed}/${aggregates.away.passes}`,
      h: aggregates.home.passes,
      a: aggregates.away.passes,
    },
    {
      label: 'Final-third entries',
      home: String(aggregates.home.thirdEntries),
      away: String(aggregates.away.thirdEntries),
      h: aggregates.home.thirdEntries,
      a: aggregates.away.thirdEntries,
    },
    {
      label: 'Field tilt',
      home: `${Math.round(tiltHome * 100)}%`,
      away: `${Math.round((1 - tiltHome) * 100)}%`,
      h: tiltHome,
      a: 1 - tiltHome,
    },
    {
      label: 'Shots (on target)',
      home: `${aggregates.home.shots} (${aggregates.home.onTarget})`,
      away: `${aggregates.away.shots} (${aggregates.away.onTarget})`,
      h: aggregates.home.shots,
      a: aggregates.away.shots,
    },
    {
      label: 'Expected goals',
      home: aggregates.home.xg.toFixed(2),
      away: aggregates.away.xg.toFixed(2),
      h: aggregates.home.xg,
      a: aggregates.away.xg,
    },
  ];
  return (
    <div className="pack-card">
      <h3>
        Match stats <em>live</em>
      </h3>
      <div className="stat-rows">
        {rows.map((row) => {
          const total = row.h + row.a;
          const share = total > 0 ? row.h / total : 0.5;
          return (
            <div className="stat-row" key={row.label}>
              <span className="stat-h">{row.home}</span>
              <div className="stat-mid">
                <div className="stat-bar">
                  <div className="stat-fill-home" style={{ width: `${share * 100}%`, background: match.meta.home.primary }} />
                  <div className="stat-fill-away" style={{ width: `${(1 - share) * 100}%`, background: match.meta.away.primary }} />
                </div>
                <span className="stat-label">{row.label}</span>
              </div>
              <span className="stat-a">{row.away}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShotMap({ match, shots }: { match: PreparedMatch; shots: PackModel['shots'] }) {
  return (
    <div className="pack-card">
      <h3>
        Shot map <em>xG-weighted</em>
      </h3>
      <svg viewBox="-56 -38 112 76" className="shot-pitch" role="img" aria-label="Shot map">
        <rect x="-52.5" y="-34" width="105" height="68" rx="1.5" className="xi-line" />
        <line x1="0" y1="-34" x2="0" y2="34" className="xi-line" />
        <circle cx="0" cy="0" r="9.15" className="xi-line" />
        <rect x="-52.5" y="-20.15" width="16.5" height="40.3" className="xi-line" />
        <rect x="36" y="-20.15" width="16.5" height="40.3" className="xi-line" />
        {shots.map((shot) => {
          const club = shot.team === 'home' ? match.meta.home : match.meta.away;
          return (
            <circle
              key={`${shot.t}-${shot.x}-${shot.y}`}
              cx={shot.x}
              cy={shot.y}
              r={2.6 + Math.sqrt(shot.xg) * 7}
              fill={club.primary}
              fillOpacity={shot.outcome === 'goal' ? 0.95 : 0.5}
              stroke={shot.outcome === 'goal' ? '#ffffff' : club.primary}
              strokeWidth={shot.outcome === 'goal' ? 1.1 : 0.5}
            >
              <title>{`${formatMinute(shot.t)} · ${club.abbr} · ${shot.xg.toFixed(2)} xG · ${shot.outcome}`}</title>
            </circle>
          );
        })}
      </svg>
      <p className="pack-foot">
        Home attack to the right. Dot area scales with expected goals; a white ring means it went in.
      </p>
    </div>
  );
}

function WinProb({ match, model, now }: { match: PreparedMatch; model: PackModel; now: OutcomeProbabilities }) {
  const width = 320;
  const height = 96;
  const curve = model.winCurve;
  const full = match.timing.fullTimeT;
  const points = curve
    .map((point) => `${((point.t / full) * width).toFixed(1)},${(height - point.home * height).toFixed(1)}`)
    .join(' ');
  const half = match.timing.halfTimeT;
  const scoreline = `${model.score.home}–${model.score.away}`;
  return (
    <div className="pack-card">
      <h3>
        Win probability <em>model</em>
      </h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="win-curve" role="img" aria-label="Win probability">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="xi-line" strokeDasharray="2 3" />
        <line x1={(half / full) * width} y1="0" x2={(half / full) * width} y2={height} className="xi-line" />
        <polyline points={points} fill="none" stroke={match.meta.home.primary} strokeWidth="1.8" />
      </svg>
      <div className="win-now">
        <span>
          <strong>{Math.round(now.home * 100)}%</strong> {match.meta.home.abbr}
        </span>
        <span className="win-score">{scoreline}</span>
        <span>
          <strong>{Math.round(now.away * 100)}%</strong> {match.meta.away.abbr}
        </span>
      </div>
      <p className="pack-foot">
        Draw {Math.round(now.draw * 100)}%. Three outcomes that sum to 100%, from a Poisson model on the current
        score, each side's xG and the time left — an honest sketch, not a betting line. At full time the result is
        certain.
      </p>
    </div>
  );
}
