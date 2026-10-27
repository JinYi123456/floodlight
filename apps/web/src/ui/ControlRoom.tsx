/**
 * The control room — program monitor in the middle, rundown on the left,
 * insight desk and viewer modes on the right, transport at the foot.
 *
 * The match clock is a theater clock: it advances in real time (or 2×/4×),
 * tracking frames stream in from the worker cache, and the cue sheet decides
 * what graphics are on air at any given second.
 */

import { useEffect } from 'react';
import { formatClock, formatMinute } from '@floodlight/core';
import { useAppStore, trackingCache } from '../state/store';
import { scoreAt, tickerAt } from '../state/derive';
import { ProgramMonitor } from './ProgramMonitor';
import { MomentRail } from './MomentRail';
import { InsightPanel } from './InsightPanel';
import { ModeConsole } from './ModeConsole';
import { VisionLab } from './VisionLab';
import { MatchPack } from './MatchPack';

function useTheaterClock(): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const store = useAppStore.getState();
      const match = store.match;
      if (!match) return;
      if (store.playing) {
        const next = store.t + dt * store.rate;
        if (next >= match.timing.fullTimeT) {
          store.setT(match.timing.fullTimeT);
          store.pause();
        } else {
          store.setT(next);
        }
        void trackingCache.ensure(store.t - 3, store.t + 30 * store.rate);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function useSpaceBar(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(target.tagName) || target.isContentEditable)) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        useAppStore.getState().toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function ControlRoom() {
  useTheaterClock();
  useSpaceBar();

  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.t);
  const prefs = useAppStore((state) => state.prefs);
  const spoilerFree = useAppStore((state) => state.spoilerFree);
  const playing = useAppStore((state) => state.playing);
  const rate = useAppStore((state) => state.rate);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const enterVision = useAppStore((state) => state.enterVision);
  const toggle = useAppStore((state) => state.toggle);
  const setRate = useAppStore((state) => state.setRate);
  const scrub = useAppStore((state) => state.scrub);
  const backToLaunch = useAppStore((state) => state.backToLaunch);

  if (!match) return null;

  const score = scoreAt(match, t);
  const ticker = tickerAt(match, t, 25, prefs);
  const period = t >= match.timing.fullTimeT ? 'Full time' : t >= match.timing.halfTimeT ? '2nd half' : '1st half';
  const progressPct = (t / match.timing.fullTimeT) * 100;

  return (
    <div className="control-room">
      <header className="room-head">
        <div className="room-brand">
          <span className="wordmark-lamp" aria-hidden />
          <span className="room-title">
            FLOOD<em>LIGHT</em>
          </span>
          <span className="room-sub">Match Intelligence Control Room</span>
        </div>

        <div className="view-tabs">
          <button type="button" className={view === 'room' ? 'active' : ''} onClick={() => setView('room')}>
            Control room
          </button>
          <button type="button" className={view === 'pack' ? 'active' : ''} onClick={() => setView('pack')}>
            Match pack
          </button>
          <button type="button" className={view === 'vision' ? 'active' : ''} onClick={() => void enterVision()}>
            Vision lab
          </button>
        </div>

        <div className="score-bug">
          <span className="kit-chip" style={{ background: match.meta.home.primary, color: match.meta.home.onPrimary }}>
            {match.meta.home.abbr}
          </span>
          <span className="score-num">{score.home}</span>
          <span className="score-dash">–</span>
          <span className="score-num">{score.away}</span>
          <span className="kit-chip" style={{ background: match.meta.away.primary, color: match.meta.away.onPrimary }}>
            {match.meta.away.abbr}
          </span>
          <span className="score-meta">
            {match.meta.competition} · {match.meta.venue.name}
          </span>
        </div>

        <div className="room-head-right">
          <span className="period-chip">{period}</span>
          <button type="button" className="ghost" onClick={backToLaunch}>
            new match
          </button>
        </div>
      </header>

      {view === 'vision' ? (
        <VisionLab />
      ) : view === 'pack' ? (
        <MatchPack />
      ) : (
        <>
          <div className="room-body">
            <MomentRail />
            <main className="stage">
              <ProgramMonitor />
              <div className="ticker-strip">
                <span className="ticker-label">LIVE</span>
                <span className="ticker-text">{ticker ?? 'The match is under way — the crew is watching.'}</span>
              </div>
            </main>
            <div className="right-rail">
              <ModeConsole />
              <InsightPanel />
            </div>
          </div>

          <footer className="transport">
            <button type="button" className="play-button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? '❚❚' : '▶'}
            </button>
            <div className="rate-group">
              {[1, 2, 4].map((value) => (
                <button
                  type="button"
                  key={value}
                  className={rate === value ? 'active' : ''}
                  onClick={() => setRate(value)}
                >
                  {value}×
                </button>
              ))}
            </div>
            <div className="scrubber">
              <div className="scrub-track">
                <div className="scrub-progress" style={{ width: `${progressPct}%` }} />
                {match.scoreTimeline
                  .slice(1)
                  .filter((goal) => !spoilerFree || goal.t <= t)
                  .map((goal, index) => (
                    <span
                      key={`${goal.t}-${index}`}
                      className="goal-marker"
                      style={{ left: `${(goal.t / match.timing.fullTimeT) * 100}%` }}
                      title={`Score update at ${formatMinute(goal.t)} — ${goal.home}–${goal.away}`}
                    />
                  ))}
              </div>
              <input
                type="range"
                min={0}
                max={match.timing.fullTimeT}
                step={0.5}
                value={t}
                onChange={(event) => scrub(Number(event.target.value))}
                aria-label="Match time"
              />
            </div>
            <div className="clock-display">
              <span className="clock-main">{formatClock(t)}</span>
              <span className="clock-sub">{formatMinute(t)} of 90</span>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
