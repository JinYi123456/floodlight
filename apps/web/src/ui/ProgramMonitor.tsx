/**
 * The program monitor — a top-down view of the match drawn from 10 Hz
 * tracking frames, with the cue sheet rendered on top.
 *
 * Stage 1 draws in 2D; the same cue payloads also drive the 3D broadcast
 * camera that lands next, so the contract is: everything on screen here is
 * something the cue sheet asked for.
 */

import { useEffect, useRef } from 'react';
import { formatClock } from '@floodlight/core';
import type { Cue } from '@floodlight/cuesheet';
import { cuesAt, cueForSlot } from '../state/derive';
import { useAppStore, trackingCache } from '../state/store';

const W = 960;
const H = 622;
const MARGIN = 34;
const PITCH_W = 105;
const PITCH_H = 68;

function sx(x: number): number {
  return MARGIN + ((x + PITCH_W / 2) / PITCH_W) * (W - MARGIN * 2);
}
function sy(y: number): number {
  return MARGIN + ((y + PITCH_H / 2) / PITCH_H) * (H - MARGIN * 2);
}

function drawPitch(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, W, H);

  // Grass with mow stripes.
  const stripeW = (W - MARGIN * 2) / 10;
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#123a26' : '#113524';
    ctx.fillRect(MARGIN + i * stripeW, MARGIN, stripeW + 0.5, H - MARGIN * 2);
  }

  ctx.strokeStyle = 'rgba(220, 255, 230, 0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2);

  // Halfway line + centre circle.
  ctx.beginPath();
  ctx.moveTo(W / 2, MARGIN);
  ctx.lineTo(W / 2, H - MARGIN);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, ((9.15 / PITCH_W) * (W - MARGIN * 2)), 0, Math.PI * 2);
  ctx.stroke();

  const boxDepth = (16.5 / PITCH_W) * (W - MARGIN * 2);
  const boxHalf = (20.15 / 68) * (H - MARGIN * 2);
  const sixDepth = (5.5 / PITCH_W) * (W - MARGIN * 2);
  const sixHalf = (9.16 / 68) * (H - MARGIN * 2);

  for (const side of [0, 1]) {
    const left = side === 0 ? MARGIN : W - MARGIN - boxDepth;
    ctx.strokeRect(left, H / 2 - boxHalf / 2, boxDepth, boxHalf);
    const sixLeft = side === 0 ? MARGIN : W - MARGIN - sixDepth;
    ctx.strokeRect(sixLeft, H / 2 - sixHalf / 2, sixDepth, sixHalf);
    const spotX = side === 0 ? MARGIN + (11 / 105) * (W - MARGIN * 2) : W - MARGIN - (11 / 105) * (W - MARGIN * 2);
    ctx.beginPath();
    ctx.arc(spotX, H / 2, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220, 255, 230, 0.55)';
    ctx.fill();
  }
}

export function ProgramMonitor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const match = useAppStore((state) => state.match);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !match) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const colors = {
      home: match.meta.home.primary,
      away: match.meta.away.primary,
    };

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const { t } = useAppStore.getState();
      const frame = trackingCache.at(t);

      drawPitch(ctx);
      if (!frame) {
        ctx.fillStyle = 'rgba(220,255,230,0.35)';
        ctx.font = '500 22px ui-monospace, monospace';
        ctx.fillText('acquiring tracking data…', MARGIN + 16, H / 2);
        return;
      }

      // Ball trail.
      ctx.beginPath();
      for (let back = 0; back <= 12; back++) {
        const past = trackingCache.at(t - back * 0.2);
        if (!past) continue;
        const px = sx(past.ball.pos.x);
        const py = sy(past.ball.pos.y);
        if (back === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Players.
      for (const player of frame.players) {
        const isHome = match.lineups.home.some((p) => p.id === player.playerId);
        const px = sx(player.pos.x);
        const py = sy(player.pos.y);
        const sprinting = player.speedKph >= 25.2;
        const r = sprinting ? 9 : 8;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = isHome ? colors.home : colors.away;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = sprinting ? '#ffffff' : 'rgba(0,0,0,0.45)';
        ctx.stroke();
        if (sprinting) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '700 10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${Math.round(player.speedKph)}`, px, py - 13);
          ctx.textAlign = 'left';
        }
      }

      // Ball.
      const bx = sx(frame.ball.pos.x);
      const by = sy(frame.ball.pos.y);
      ctx.beginPath();
      ctx.arc(bx, by, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0b1220';
      ctx.stroke();

      // Cue sheet on top: telestration + player tag are pitch-space graphics.
      const active = cuesAt(match, t);
      const telestration = cueForSlot(active, 'telestration');
      if (telestration?.payload.from && telestration.payload.to) {
        const from = telestration.payload.from as { x: number; y: number };
        const to = telestration.payload.to as { x: number; y: number };
        const progress = Math.min(1, (t - telestration.t0) / 1.2);
        const x2 = from.x + (to.x - from.x) * progress;
        const y2 = from.y + (to.y - from.y) * progress;
        ctx.beginPath();
        ctx.moveTo(sx(from.x), sy(from.y));
        ctx.lineTo(sx(x2), sy(y2));
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(sx(from.x), sy(from.y), 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [match]);

  if (!match) return null;

  const t = useAppStore((state) => state.t);
  const active = cuesAt(match, t);
  const lowerThird = cueForSlot(active, 'lower_third');
  const statBumper = cueForSlot(active, 'stat_bumper');
  const ribbon = cueForSlot(active, 'momentum_ribbon');
  const flash = cueForSlot(active, 'goal_flash');
  const playerTag = cueForSlot(active, 'player_tag');

  return (
    <div className="program-monitor">
      <canvas ref={canvasRef} width={W} height={H} />
      <div className="overlay-layer">
        {flash && (
          <div className="cue-goal-flash" key={flash.id}>
            <span>{(flash.payload.headline as string) ?? 'GOAL'}</span>
          </div>
        )}
        {ribbon && (
          <div
            className="cue-ribbon"
            key={ribbon.id}
            style={{ borderColor: teamColor(match, String(ribbon.payload.direction ?? '')) }}
          >
            <span className="ribbon-label">MOMENTUM</span>
            <span className="ribbon-text">{ribbon.payload.headline as string}</span>
          </div>
        )}
        {lowerThird && (
          <div className="cue-lower-third" key={lowerThird.id}>
            <div className="lower-third-bar" style={{ background: teamColor(match, String(lowerThird.payload.team ?? '')) }} />
            <div className="lower-third-text">
              <span className="lower-third-minute">{lowerThird.payload.minuteLabel as string}</span>
              <strong>{lowerThird.payload.headline as string}</strong>
              <p>{lowerThird.payload.body as string}</p>
            </div>
          </div>
        )}
        {statBumper && (
          <div className="cue-stat-bumper" key={statBumper.id}>
            <span className="bumper-minute">{statBumper.payload.minuteLabel as string}</span>
            {(statBumper.payload.stats as Array<{ label: string; value: string | number }>)?.map((stat) => (
              <div className="bumper-row" key={stat.label}>
                <span className="bumper-label">{labelize(stat.label)}</span>
                <span className="bumper-value">{String(stat.value)}</span>
              </div>
            ))}
          </div>
        )}
        {playerTag && (
          <div className="cue-player-tag" key={playerTag.id}>
            <strong>{playerName(match, String(playerTag.payload.playerId ?? ''))}</strong>
            {playerTag.payload.speedKph != null && <span>{String(playerTag.payload.speedKph)} km/h</span>}
          </div>
        )}
      </div>
      <div className="monitor-tally">
        <span className="tally-dot" /> {formatClock(t)}
      </div>
    </div>
  );
}

function teamColor(match: NonNullable<ReturnType<typeof useAppStore.getState>['match']>, team: string): string {
  if (team === 'home') return match.meta.home.primary;
  if (team === 'away') return match.meta.away.primary;
  return '#ffd166';
}

function playerName(match: NonNullable<ReturnType<typeof useAppStore.getState>['match']>, id: string): string {
  const all = [...match.lineups.home, ...match.lineups.away];
  return all.find((p) => p.id === id)?.name ?? 'Player';
}

function labelize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
