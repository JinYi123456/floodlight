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
  const selectedMomentId = useAppStore((state) => state.selectedMomentId);
  const selectMoment = useAppStore((state) => state.selectMoment);
  const scrub = useAppStore((state) => state.scrub);
  const liveRef = useRef<HTMLLIElement | null>(null);

  const feed = match ? buildFeed(match, t) : [];
  const liveId = feed.filter((item) => item.state === 'live').at(-1)?.candidateId ?? null;

  useEffect(() => {
    liveRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [liveId]);

  if (!match) return null;

  return (
    <aside className="moment-rail">
      <header className="rail-head">
        <h2>Rundown</h2>
        <span className="rail-count">{feed.filter((i) => i.state !== 'upcoming').length} aired</span>
      </header>
      <ol className="moment-list">
        {feed.map((item) => {
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
                if (!item.synthetic) selectMoment(item.candidateId);
                if (!retracted) scrub(Math.max(0, item.t - 6));
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
    </aside>
  );
}
