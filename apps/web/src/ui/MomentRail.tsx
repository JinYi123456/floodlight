/**
 * The gallery — the running order. Every moment the director decided to air,
 * newest at the bottom, with what is coming up next.
 */

import { useEffect, useRef } from 'react';
import type { MomentKind } from '@floodlight/engine';
import { useAppStore } from '../state/store';
import { buildFeed } from '../state/derive';
import { kindStyle } from './kinds';

export function MomentRail() {
  const match = useAppStore((state) => state.match);
  const t = useAppStore((state) => state.t);
  const spoilerFree = useAppStore((state) => state.spoilerFree);
  const prefs = useAppStore((state) => state.prefs);
  const selectedMomentId = useAppStore((state) => state.selectedMomentId);
  const selectMoment = useAppStore((state) => state.selectMoment);
  const replay = useAppStore((state) => state.replay);
  const liveRef = useRef<HTMLLIElement | null>(null);

  const visible = match ? buildFeed(match, t, spoilerFree ? 0 : 150, prefs) : [];
  const liveId = visible.filter((item) => item.state === 'live').at(-1)?.candidateId ?? null;

  useEffect(() => {
    liveRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [liveId]);

  if (!match) return null;

  return (
    <aside className="moment-rail">
      <header className="rail-head">
        <h2>Rundown</h2>
        <span className="rail-count">{visible.filter((i) => i.state !== 'upcoming').length} aired</span>
      </header>
      <ol className="moment-list">
        {visible.map((item) => {
          const style = item.badge ?? kindStyle(item.kind as MomentKind);
          const isLive = item.candidateId === liveId;
          const isSelected = item.candidateId === selectedMomentId;
          const retracted = item.state === 'retracted';
          return (
            <li
              key={item.key}
              ref={isLive ? liveRef : undefined}
              className={`moment-item ${item.state}${isSelected ? ' selected' : ''}${isLive ? ' is-live' : ''}${item.synthetic ? ' structural' : ''}`}
              onClick={() => {
                if (retracted) selectMoment(item.candidateId);
                else replay(Math.max(0, item.t - 6));
              }}
              title={
                retracted
                  ? 'Chalked off by VAR — click to inspect the retraction'
                  : item.synthetic
                    ? 'Structural cue — click to jump to it in the match'
                    : 'Click to inspect and replay from here'
              }
            >
              <span className="moment-minute">{item.minuteLabel}</span>
              <span className="kind-badge" style={{ background: style.color }}>
                {retracted ? 'RETRACTED' : style.label}
              </span>
              <p className="moment-headline">{item.headline}</p>
            </li>
          );
        })}
      </ol>
      {spoilerFree && <p className="rail-hidden">Spoiler-free — only events at or before your playhead are shown.</p>}
      {(prefs.clubId || prefs.playerId || prefs.metric) && (
        <p className="rail-hidden">Focused rundown · score-changing events and decisions always remain visible.</p>
      )}
    </aside>
  );
}
