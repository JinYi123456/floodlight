/**
 * The vision lab — auto-eventing, live.
 *
 * The worker renders the match to raw pixels and re-derives the football
 * from them: passes, shots, possession, ball and player speeds. This screen
 * plays that feed with the detections drawn on top, next to the accuracy
 * report scored against the simulator's ground truth.
 */

import { useEffect, useRef, useState } from 'react';
import { formatClock, formatMinute } from '@floodlight/core';
import type { VisionReport } from '@floodlight/vision';
import { projection, px, py } from '@floodlight/vision';
import { useAppStore, pipeline } from '../state/store';
import type { VisionFrameMessage } from '../pipeline/client';

const W = 320;
const H = 208;

interface LiveEvent {
  t: number;
  type: string;
  team: 'home' | 'away';
  speedKph: number;
}

export function VisionLab() {
  const match = useAppStore((state) => state.match);
  const vision = useAppStore((state) => state.vision);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [lastFrame, setLastFrame] = useState<VisionFrameMessage | null>(null);
  const playingRef = useRef(playing);
  const cursorRef = useRef(0);
  const windowRef = useRef(vision.window);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    windowRef.current = vision.window;
  }, [vision.window]);

  // Frame pump: one camera frame per ~30 ms of wall time. The cursor moves by
  // the real elapsed step (clamped), so the feed plays at true speed whatever
  // the render load, and the tracker is told the same dt — derived speeds stay
  // honest at any cadence.
  useEffect(() => {
    if (vision.phase !== 'ready') return;
    let raf = 0;
    let lastRequest = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const win = windowRef.current;
      if (!win || !playingRef.current) return;
      if (now - lastRequest < 30) return;
      const dt = Math.min(0.12, Math.max(0.02, (now - lastRequest) / 1000));
      lastRequest = now;
      const t = win.t0 + cursorRef.current;
      pipeline.visionFrame(t, W, H, dt);
      cursorRef.current += dt;
      if (cursorRef.current > win.t1 - win.t0) cursorRef.current = 0;
      setCursor(cursorRef.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [vision.phase]);

  // Draw incoming frames.
  useEffect(() => {
    pipeline.onVisionFrame = (message) => {
      setLastFrame(message);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.putImageData(new ImageData(new Uint8ClampedArray(message.rgba), message.width, message.height), 0, 0);
          const proj = projection(message.width, message.height);
          for (const entity of message.entities) {
            const bx = px(proj, entity.x);
            const by = py(proj, entity.y);
            ctx.beginPath();
            if (entity.cls === 'ball') {
              ctx.arc(bx, by, 7, 0, Math.PI * 2);
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 1.6;
            } else {
              ctx.arc(bx, by, 8.5, 0, Math.PI * 2);
              ctx.strokeStyle = entity.cls === 'home' ? '#ff5c7a' : '#5cc8ff';
              ctx.lineWidth = 1.2;
            }
            ctx.stroke();
          }
        }
      }
      if (message.detected.length > 0) {
        setLiveEvents((events) =>
          [...events, ...message.detected.map((e) => ({ t: e.t, type: e.type, team: e.team, speedKph: e.speedKph }))].slice(-40),
        );
      }
    };
    return () => {
      pipeline.onVisionFrame = null;
    };
  }, []);

  if (!match) return null;

  if (vision.phase === 'idle' || vision.phase === 'preparing' || vision.phase === 'analyzing') {
    const pct = Math.round(vision.progressFraction * 100);
    return (
      <div className="vision-lab loading">
        <div className="vision-loading-card">
          <h2>Vision lab</h2>
          <p className="vision-stage">{vision.progressLabel || 'Opening the tape'}</p>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="vision-note">
            The pipeline is watching the rendered feed and re-deriving the match from raw pixels — passes, a shot,
            speeds — then scoring itself against what the simulation actually produced.
          </p>
          {(vision.phase === 'analyzing' || vision.phase === 'preparing') && (
            <p className="vision-note dim">
              {vision.window ? `Clip: ${formatMinute(vision.window.t0)} – ${formatMinute(vision.window.t1)}` : ''}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (vision.phase === 'error') {
    return (
      <div className="vision-lab loading">
        <div className="vision-loading-card">
          <h2>Vision lab</h2>
          <p className="vision-stage error">{vision.error}</p>
        </div>
      </div>
    );
  }

  const report = vision.report;
  const windowLabel = vision.window ? `${formatMinute(vision.window.t0)} – ${formatMinute(vision.window.t1)}` : '';

  return (
    <div className="vision-lab">
      <div className="vision-main">
        <div className="vision-head">
          <h2>Auto-eventing feed</h2>
          <span className="vision-sub">
            clip {windowLabel} · {W}×{H} sensor · all events below are derived from pixels only
          </span>
        </div>
        <div className="vision-screen">
          <canvas ref={canvasRef} width={W} height={H} />
          <div className="vision-hud">
            <span className="hud-dot" />
            {vision.window ? formatClock(vision.window.t0 + cursor) : '--:--'}
          </div>
          {lastFrame && lastFrame.detected.length > 0 && (
            <div className="vision-detection-flash" key={`${lastFrame.t}-${lastFrame.detected.length}`}>
              {lastFrame.detected.map((detected) => (
                <span key={detected.type + detected.t}>
                  {detected.type.toUpperCase()} {detected.speedKph} km/h
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="vision-controls">
          <button type="button" className="play-button" onClick={() => setPlaying((p) => !p)}>
            {playing ? '❚❚' : '▶'}
          </button>
          <div className="vision-legend">
            <span>
              <i className="legend-ring home" /> home
            </span>
            <span>
              <i className="legend-ring away" /> away
            </span>
            <span>
              <i className="legend-ring ball" /> ball
            </span>
          </div>
          <span className="vision-tip">The white ring is the detected ball; rings are detections, not ground truth.</span>
        </div>
        <div className="vision-events">
          <h3>Derived events</h3>
          <ul>
            {[...liveEvents].reverse().map((event, index) => (
              <li key={`${event.t}-${index}`}>
                <span className="event-t">{formatClock(event.t)}</span>
                <span className={`event-type ${event.type}`}>{event.type.replace('_', ' ')}</span>
                <span className="event-team">{event.team}</span>
                <span className="event-speed">{event.speedKph} km/h</span>
              </li>
            ))}
            {liveEvents.length === 0 && <li className="empty">Watching… events will appear as the feed plays.</li>}
          </ul>
        </div>
      </div>

      <aside className="vision-report">
        <h2>Accuracy report</h2>
        {report && <ReportCard report={report} />}
      </aside>
    </div>
  );
}

function ReportCard({ report }: { report: VisionReport }) {
  const passBars = [
    { label: 'Precision', value: report.passPrecision },
    { label: 'Recall', value: report.passRecall },
    { label: 'F1', value: report.passF1 },
  ];
  return (
    <>
      <div className="report-hero">
        <span className="hero-number">{(report.passF1 * 100).toFixed(0)}</span>
        <span className="hero-label">
          pass-detection F1
          <br />
          <em>
            precision {Math.round(report.passPrecision * 100)}% · recall {Math.round(report.passRecall * 100)}%
          </em>
        </span>
      </div>

      <div className="report-bars">
        {passBars.map((bar) => (
          <div className="report-bar" key={bar.label}>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.round(bar.value * 100)}%` }} />
            </div>
            <span className="bar-label">
              {bar.label} <strong>{Math.round(bar.value * 100)}%</strong>
            </span>
          </div>
        ))}
      </div>

      <div className="report-counts">
        <div>
          <span>Passes detected</span>
          <strong>
            {report.detected.passes} of {report.groundTruth.passes}
          </strong>
        </div>
        <div>
          <span>Shots detected</span>
          <strong>
            {report.detected.shots} of {report.groundTruth.shots}
          </strong>
        </div>
      </div>

      <TeamSplit report={report} />

      <div className="report-metrics">
        <div>
          <span>Ball speed error</span>
          <strong>{report.ballSpeedMaeKph.toFixed(1)} km/h</strong>
        </div>
        <div>
          <span>Player speed error</span>
          <strong>{report.playerSpeedMaeKph.toFixed(1)} km/h</strong>
        </div>
        <div>
          <span>Possession agreement</span>
          <strong>{Math.round(report.possessionAgreement * 100)}%</strong>
        </div>
        <div>
          <span>Frames processed</span>
          <strong>{report.framesProcessed}</strong>
        </div>
      </div>

      <Sparkline report={report} />
      <p className="report-foot">
        Ground truth is the event stream the simulation recorded. The vision pipeline never sees it — it only gets
        pixels, reports what it finds, and is scored afterwards.
      </p>
    </>
  );
}

function TeamSplit({ report }: { report: VisionReport }) {
  const match = useAppStore((state) => state.match);
  return (
    <div className="report-teams">
      <p className="report-teams-head">Same window, split by side — detected / truth</p>
      {(['home', 'away'] as const).map((side) => {
        const club = match ? (side === 'home' ? match.meta.home : match.meta.away) : null;
        const row = report.byTeam[side];
        return (
          <div className="report-team" key={side}>
            <span
              className="report-team-chip"
              style={club ? { background: club.primary, color: club.onPrimary } : undefined}
            >
              {club ? club.abbr : side}
            </span>
            <span title="Share of live possession in the window">
              <strong>{Math.round(row.possessionShare * 100)}%</strong> poss
            </span>
            <span title="Passes detected against truth">
              <strong>
                {row.passes}/{row.truthPasses}
              </strong>{' '}
              pass
            </span>
            <span title="Shots detected against truth">
              <strong>
                {row.shots}/{row.truthShots}
              </strong>{' '}
              shot
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Sparkline({ report }: { report: VisionReport }) {
  const samples = report.samples;
  if (samples.length < 2) return null;
  const width = 320;
  const height = 90;
  const maxCount = Math.max(1, ...samples.map((s) => Math.max(s.truth.passes + s.truth.shots, s.detected.passes + s.detected.shots)));
  const x = (i: number) => (i / (samples.length - 1)) * (width - 8) + 4;
  const y = (value: number) => height - 8 - (value / maxCount) * (height - 20);
  const truthPath = samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.truth.passes + s.truth.shots).toFixed(1)}`).join(' ');
  const detectedPath = samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.detected.passes + s.detected.shots).toFixed(1)}`).join(' ');
  return (
    <div className="report-chart">
      <h3>Cumulative events over the clip</h3>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="cumulative detected vs truth events">
        <path d={truthPath} className="chart-truth" />
        <path d={detectedPath} className="chart-detected" />
      </svg>
      <div className="chart-legend">
        <span>
          <i className="chart-dot truth" /> ground truth
        </span>
        <span>
          <i className="chart-dot detected" /> derived from pixels
        </span>
      </div>
    </div>
  );
}
