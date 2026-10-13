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

import { formatMinute, type MatchEvent } from '@floodlight/core';
import { useAppStore } from '../state/store';
import type { PreparedMatch } from '../pipeline/protocol';

type Side = 'home' | 'away';

interface TeamAggregate {
  possession: number;
  passes: number;
  completed: number;
  shots: number;
  onTarget: number;
  xg: number;
  thirdEntries: number;
}

interface PackModel {
  aggregates: Record<Side, TeamAggregate>;
  shots: Array<{ t: number; team: Side; x: number; y: number; xg: number; outcome: string }>;
  subs: Array<{ t: number; team: Side; off: string; on: string }>;
  usedOn: Set<string>;
  score: { home: number; away: number };
  winCurve: Array<{ t: number; home: number }>;
}

const EMPTY_AGGREGATE: TeamAggregate = {
  possession: 0,
  passes: 0,
  completed: 0,
  shots: 0,
  onTarget: 0,
  xg: 0,
  thirdEntries: 0,
};

function buildModel(match: PreparedMatch, t: number): PackModel {
  const aggregates: Record<Side, TeamAggregate> = { home: { ...EMPTY_AGGREGATE }, away: { ...EMPTY_AGGREGATE } };

  // Possession by time between possession change-points.
  let holder: Side | null = null;
  let since = 0;
  const possessionSeconds: Record<Side, number> = { home: 0, away: 0 };
  for (const event of match.events) {
    if (event.t > t) break;
    if (event.type === 'kickoff' || event.type === 'possession_change') {
      if (holder && event.team !== 'none') possessionSeconds[holder] += event.t - since;
      holder = event.team === 'none' ? holder : (event.team as Side);
      since = event.t;
    }
  }
  if (holder) possessionSeconds[holder] += Math.max(0, t - since);
  const total = possessionSeconds.home + possessionSeconds.away;

  const shots: PackModel['shots'] = [];
  const subs: PackModel['subs'] = [];
  const usedOn = new Set<string>();
  const score = { home: 0, away: 0 };
  const xgSoFar: Record<Side, number> = { home: 0, away: 0 };
  const xgTimeline: Array<{ t: number; xgHome: number; xgAway: number }> = [];

  for (const event of match.events) {
    if (event.t > t) break;
    const side = event.team === 'home' || event.team === 'away' ? (event.team as Side) : null;
    if (!side) continue;
    const xg = (event as { xg?: number }).xg ?? 0;
    switch (event.type) {
      case 'pass': {
        aggregates[side].passes++;
        if ((event as { outcome?: string }).outcome === 'complete') aggregates[side].completed++;
        if ((side === 'home' && event.at.x >= 35) || (side === 'away' && event.at.x <= -35)) {
          aggregates[side].thirdEntries++;
        }
        break;
      }
      case 'carry': {
        if ((side === 'home' && event.at.x >= 35) || (side === 'away' && event.at.x <= -35)) {
          aggregates[side].thirdEntries++;
        }
        break;
      }
      case 'shot': {
        const outcome = String((event as { outcome?: string }).outcome ?? '');
        aggregates[side].shots++;
        if (outcome === 'goal' || outcome === 'saved') aggregates[side].onTarget++;
        aggregates[side].xg += xg;
        xgSoFar[side] += xg;
        if (outcome === 'goal') score[side]++;
        shots.push({ t: event.t, team: side, x: event.at.x, y: event.at.y, xg, outcome });
        xgTimeline.push({ t: event.t, xgHome: xgSoFar.home, xgAway: xgSoFar.away });
        break;
      }
      case 'substitution': {
        const sub = event as MatchEvent & { playerOffId: string; playerOnId: string };
        subs.push({ t: event.t, team: side, off: sub.playerOffId, on: sub.playerOnId });
        usedOn.add(sub.playerOnId);
        break;
      }
      default:
        break;
    }
  }

  aggregates.home.possession = total > 0 ? possessionSeconds.home / total : 0.5;
  aggregates.away.possession = total > 0 ? possessionSeconds.away / total : 0.5;

  // Win probability across the match so far, then at now.
  const winCurve: PackModel['winCurve'] = [];
  const full = match.timing.fullTimeT;
  let sample = -1;
  for (let at = 0; at <= t + 1e-6; at += 60) {
    while (sample + 1 < xgTimeline.length && xgTimeline[sample + 1]!.t <= at) sample++;
    const xgH = sample >= 0 ? xgTimeline[sample]!.xgHome : 0;
    const xgA = sample >= 0 ? xgTimeline[sample]!.xgAway : 0;
    let h = 0;
    let a = 0;
    for (const goal of match.scoreTimeline) {
      if (goal.t > at) break;
      h = goal.home;
      a = goal.away;
    }
    winCurve.push({ t: at, home: poissonWin(h - a, xgH, xgA, at, full) });
  }
  winCurve.push({ t, home: poissonWin(score.home - score.away, xgSoFar.home, xgSoFar.away, t, full) });
  return { aggregates, shots, subs, usedOn, score, winCurve };
}

function poissonPmf(k: number, lambda: number): number {
  let acc = Math.exp(-lambda);
  for (let i = 2; i <= k; i++) acc = (acc * lambda) / i;
  return acc;
}

/** P(home wins) under a Poisson model: each side scores using its xG edge
 *  over the remaining time. Deliberately simple and stated as a model. */
function poissonWin(diff: number, xgHome: number, xgAway: number, t: number, full: number): number {
  const remaining = Math.max(0, 1 - t / full);
  const edge = Math.max(-0.6, Math.min(0.6, (xgHome - xgAway) * 0.25));
  const lambdaHome = Math.max(0.02, (1.35 + edge) * remaining);
  const lambdaAway = Math.max(0.02, (1.35 - edge) * remaining);
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = poissonPmf(i, lambdaHome) * poissonPmf(j, lambdaAway);
      if (i - j > -diff) home += p;
      else if (i - j === -diff) draw += p;
      else away += p;
    }
  }
  return home / Math.max(1e-9, home + draw + away);
}

function nameOf(match: PreparedMatch, id: string): string {
  const all = [...match.lineups.home, ...match.lineups.away, ...match.bench.home, ...match.bench.away];
  return all.find((p) => p.id === id)?.name ?? id;
}

export function MatchPack() {
  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.t);
  if (!match) return null;

  const model = buildModel(match, t);
  const now = model.winCurve[model.winCurve.length - 1]?.home ?? 0.5;

  return (
    <div className="match-pack">
      <div className="pack-grid pack-xi">
        {(['home', 'away'] as const).map((side) => (
          <FormationCard key={side} match={match} side={side} usedOn={model.usedOn} />
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

function FormationCard({ match, side, usedOn }: { match: PreparedMatch; side: Side; usedOn: Set<string> }) {
  const club = side === 'home' ? match.meta.home : match.meta.away;
  const xi = match.lineups[side];
  const bench = match.bench[side];
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
          const x = (player.slotX ?? 0.1) * 105;
          const y = 34 + (player.slotY ?? 0) * 30;
          const isKeeper = player.role === 'GK';
          return (
            <g key={player.id}>
              <circle cx={x} cy={y} r={3.4} fill={isKeeper ? club.secondary : club.primary} />
              <text x={x} y={y + 1.2} textAnchor="middle" className="xi-number">
                {player.shirt}
              </text>
            </g>
          );
        })}
      </svg>
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

function WinProb({ match, model, now }: { match: PreparedMatch; model: PackModel; now: number }) {
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
          <strong>{Math.round(now * 100)}%</strong> {match.meta.home.abbr} win
        </span>
        <span className="win-score">{scoreline}</span>
        <span>
          <strong>{Math.round((1 - now) * 100)}%</strong> {match.meta.away.abbr}
        </span>
      </div>
      <p className="pack-foot">
        P(draw included in the gap). A Poisson model on the scoreline, the xG each side has generated and the time
        left — not a betting line, an honest sketch.
      </p>
    </div>
  );
}
