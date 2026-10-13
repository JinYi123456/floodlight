/**
 * Control-room state. One zustand store: pipeline phase, the prepared match,
 * the theater clock, and the viewer profile that drives personalization.
 */

import { create } from 'zustand';
import type { Lang, Persona } from '@floodlight/agents';
import { PipelineClient, TrackingCache } from '../pipeline/client';
import type { PreparedMatch } from '../pipeline/protocol';

export const pipeline = new PipelineClient();
export const trackingCache = new TrackingCache(pipeline);

export type Phase = 'launch' | 'preparing' | 'ready' | 'error';

export interface ViewerPrefs {
  persona: Persona;
  lang: Lang;
  clubId: string | null;
  playerId: string | null;
  metric: string | null;
}

interface AppState {
  phase: Phase;
  progressLabel: string;
  progressFraction: number;
  error: string | null;
  match: PreparedMatch | null;
  recordingId: string | null;

  /** Theater clock, in match seconds. */
  t: number;
  playing: boolean;
  rate: number;

  /** The moment the insight panel is drilled into. */
  selectedMomentId: string | null;

  prefs: ViewerPrefs;

  ensurePrepared: (scenarioId: string | null, seed: number, recording?: string | null) => Promise<void>;
  setT: (t: number) => void;
  scrub: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setRate: (rate: number) => void;
  selectMoment: (id: string | null) => void;
  setPrefs: (partial: Partial<ViewerPrefs>) => void;
  backToLaunch: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  phase: 'launch',
  progressLabel: '',
  progressFraction: 0,
  error: null,
  match: null,
  recordingId: null,

  t: 0,
  playing: false,
  rate: 1,

  selectedMomentId: null,

  prefs: { persona: 'analyst', lang: 'en', clubId: null, playerId: null, metric: null },

  ensurePrepared: async (scenarioId, seed, recording) => {
    if (get().phase === 'preparing') return;
    set({ phase: 'preparing', progressLabel: 'Warming up', progressFraction: 0, error: null });
    pipeline.onProgress = (label, fraction) => set({ progressLabel: label, progressFraction: fraction });
    try {
      const match = await pipeline.prepare(scenarioId, seed, recording);
      trackingCache.reset();
      set({
        phase: 'ready',
        match,
        recordingId: recording ?? null,
        t: 0,
        playing: true,
        rate: 1,
        selectedMomentId: null,
      });
    } catch (error) {
      set({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      pipeline.onProgress = null;
    }
  },

  setT: (t) => {
    const match = get().match;
    const max = match ? match.timing.fullTimeT : t;
    set({ t: Math.max(0, Math.min(max, t)) });
  },
  scrub: (t) => {
    set({ t });
    void trackingCache.ensure(t - 3, t + 40);
  },
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set((state) => ({ playing: !state.playing })),
  setRate: (rate) => set({ rate }),
  selectMoment: (id) => set({ selectedMomentId: id }),
  setPrefs: (partial) => set((state) => ({ prefs: { ...state.prefs, ...partial } })),
  backToLaunch: () => set({ phase: 'launch', match: null, playing: false, t: 0, selectedMomentId: null }),
}));

// Dev-only inspection hook (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __floodlight?: unknown }).__floodlight = useAppStore;
}
