/**
 * Pipeline client — the main thread's typed handle on the pipeline worker.
 *
 * Owns the worker instance, request/response plumbing, and a rolling
 * tracking-frame cache so the renderer can ask for "the match at time t"
 * without caring how frames get there.
 */

import type { TrackingFrame } from '@floodlight/core';
import type { VisionReport, WorkerRequest, WorkerResponse } from './protocol';
import type { PreparedMatch } from './protocol';

const TRACKING_SEGMENT_S = 20;
const TRACKING_HZ = 10;

export interface VisionFrameMessage {
  t: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  entities: Array<{ cls: 'ball' | 'home' | 'away'; x: number; y: number }>;
  detected: Array<{ t: number; type: 'pass' | 'shot' | 'possession_change'; team: 'home' | 'away'; from: { x: number; y: number }; to: { x: number; y: number }; speedKph: number }>;
}

export class PipelineClient {
  private readonly worker: Worker;
  private readonly waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  onProgress: ((label: string, fraction: number, channel: 'prepare' | 'vision') => void) | null = null;
  onVisionFrame: ((frame: VisionFrameMessage) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    this.worker.onerror = (event) => this.failAll(new Error(event.message || 'pipeline worker crashed'));
  }

  prepare(scenarioId: string | null, seed: number, recording?: string | null, recordingsBase?: string): Promise<PreparedMatch> {
    return this.request<PreparedMatch>('prepare', {
      type: 'prepare',
      scenarioId,
      seed,
      recording: recording ?? null,
      recordingsBase: recordingsBase ?? null,
    });
  }

  tracking(t0: number, t1: number): Promise<TrackingFrame[]> {
    return this.request<TrackingFrame[]>(`tracking:${t0}:${t1}`, {
      type: 'trackingWindow',
      t0,
      t1,
      hz: TRACKING_HZ,
    });
  }

  visionPrepare(): Promise<{ t0: number; t1: number }> {
    return this.request<{ t0: number; t1: number }>('visionPrepare', { type: 'visionPrepare' });
  }

  visionAnalyze(): Promise<VisionReport> {
    return this.request<VisionReport>('visionAnalyze', { type: 'visionAnalyze' });
  }

  visionFrame(t: number, width: number, height: number): void {
    const message: WorkerRequest = { type: 'visionFrame', t, width, height };
    this.worker.postMessage(message);
  }

  private request<T>(key: string, message: WorkerRequest): Promise<T> {
    const existing = this.waiters.get(key);
    if (existing) existing.reject(new Error(`duplicate request: ${key}`));
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(key, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(message);
    });
  }

  private handle(message: WorkerResponse): void {
    switch (message.type) {
      case 'progress':
        this.onProgress?.(message.label, message.fraction, message.channel ?? 'prepare');
        break;
      case 'ready':
        this.settle('prepare', message.payload);
        break;
      case 'tracking':
        this.settle(`tracking:${message.t0}:${message.t1}`, message.frames);
        break;
      case 'visionReady':
        this.settle('visionPrepare', message.window);
        break;
      case 'visionFrame':
        this.onVisionFrame?.(message);
        break;
      case 'visionReport':
        this.settle('visionAnalyze', message.report);
        break;
      case 'error':
        this.failAll(new Error(message.message));
        break;
      default:
        break;
    }
  }

  private settle(key: string, value: unknown): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    waiter.resolve(value);
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
  }
}

/**
 * Rolling cache of 10 Hz tracking frames. The theater asks for a time range;
 * the cache fetches missing 20-second segments once and serves frames by
 * decisecond key afterwards.
 */
export class TrackingCache {
  private readonly frames = new Map<number, TrackingFrame>();
  private readonly have = new Set<number>();
  private readonly inflight = new Set<number>();

  constructor(private readonly client: PipelineClient) {}

  async ensure(t0: number, t1: number): Promise<void> {
    const s0 = Math.max(0, Math.floor(t0 / TRACKING_SEGMENT_S));
    const s1 = Math.max(0, Math.floor(t1 / TRACKING_SEGMENT_S));
    const jobs: Array<Promise<void>> = [];
    for (let s = s0; s <= s1; s++) {
      if (this.have.has(s) || this.inflight.has(s)) continue;
      this.inflight.add(s);
      jobs.push(
        this.client
          .tracking(s * TRACKING_SEGMENT_S, (s + 1) * TRACKING_SEGMENT_S)
          .then((frames) => {
            for (const frame of frames) this.frames.set(Math.round(frame.t * TRACKING_HZ), frame);
            this.have.add(s);
          })
          .catch(() => undefined)
          .finally(() => this.inflight.delete(s)),
      );
    }
    await Promise.all(jobs);
  }

  /** Nearest cached frame at or before t (decisecond resolution). */
  at(t: number): TrackingFrame | null {
    const key = Math.round(t * TRACKING_HZ);
    for (let k = key; k >= key - 2 && k >= 0; k--) {
      const frame = this.frames.get(k);
      if (frame) return frame;
    }
    return null;
  }

  reset(): void {
    this.frames.clear();
    this.have.clear();
    this.inflight.clear();
  }
}
