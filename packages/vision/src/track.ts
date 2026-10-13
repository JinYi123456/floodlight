/**
 * The tracking layer — frame-to-frame association of detected blobs into
 * stable tracks with velocities. Pure nearest-neighbour with per-class gates
 * (a ball can move much further between frames than a player), plus a short
 * miss tolerance so a dipped detection doesn't kill a track.
 */

import type { DetectedEntity } from './detect';

export interface Track {
  id: number;
  cls: 'ball' | 'home' | 'away';
  x: number;
  y: number;
  /** Smoothed velocity, metres/second. */
  vx: number;
  vy: number;
  /** Smoothed speed, km/h. */
  speedKph: number;
  age: number;
  missed: number;
}

function gate(cls: Track['cls']): number {
  return cls === 'ball' ? 6.5 : 4.2;
}

export class TrackingLayer {
  private tracks = new Map<number, Track>();
  private nextId = 1;
  private readonly smoothing = 0.45;

  /** Update with a new frame's entities. dt in seconds. Returns live tracks. */
  update(entities: DetectedEntity[], dt: number): Track[] {
    const available = new Set(entities.map((_, index) => index));
    const assignments = new Map<number, number>(); // trackId -> entity index

    // Greedy nearest-first assignment against the predicted position, so
    // two crossing players keep their identities.
    const pairs: Array<{ trackId: number; entityIndex: number; d: number }> = [];
    for (const [trackId, track] of this.tracks) {
      const px = track.x + track.vx * dt;
      const py = track.y + track.vy * dt;
      entities.forEach((entity, entityIndex) => {
        if (entity.cls !== track.cls) return;
        const d = Math.hypot(entity.x - px, entity.y - py);
        if (d <= gate(track.cls)) pairs.push({ trackId, entityIndex, d });
      });
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const pair of pairs) {
      if (assignments.has(pair.trackId) || !available.has(pair.entityIndex)) continue;
      assignments.set(pair.trackId, pair.entityIndex);
      available.delete(pair.entityIndex);
    }

    const live: Track[] = [];
    for (const [trackId, track] of this.tracks) {
      const entityIndex = assignments.get(trackId);
      if (entityIndex === undefined) {
        track.missed++;
        if (track.missed > 4) this.tracks.delete(trackId);
        continue;
      }
      const entity = entities[entityIndex]!;
      const importFactor = track.age < 3 ? 0.8 : this.smoothing;
      const vx = entity.x - track.x;
      const vy = entity.y - track.y;
      track.x = entity.x;
      track.y = entity.y;
      const instantVx = vx / dt;
      const instantVy = vy / dt;
      track.vx = track.vx * (1 - importFactor) + instantVx * importFactor;
      track.vy = track.vy * (1 - importFactor) + instantVy * importFactor;
      track.speedKph = Math.hypot(track.vx, track.vy) * 3.6;
      track.age++;
      track.missed = 0;
      live.push(track);
    }

    // New tracks for unassigned entities.
    for (const entityIndex of available) {
      const entity = entities[entityIndex]!;
      const track: Track = {
        id: this.nextId++,
        cls: entity.cls,
        x: entity.x,
        y: entity.y,
        vx: 0,
        vy: 0,
        speedKph: 0,
        age: 1,
        missed: 0,
      };
      this.tracks.set(track.id, track);
      live.push(track);
    }

    return live;
  }
}
