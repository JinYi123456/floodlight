import { create } from 'zustand';
import type { Lang, Persona } from '@floodlight/agents';
import type { VisionReport } from '@floodlight/vision';
import { PipelineClient, TrackingCache } from '../pipeline/client';
import type { PreparedMatch } from '../pipeline/protocol';

export const pipeline = new PipelineClient();
export const trackingCache = new TrackingCache(pipeline);

export type Phase = 'launch' | 'preparing' | 'ready' | 'error';
export type View = 'room' | 'vision' | 'pack';

export interface ViewerPrefs {
  persona: Persona;
  lang: Lang;
  clubId: string | null;
  playerId: string | null;
  metric: string | null;
}

export interface VisionState {
  phase: 'idle' | 'locked' | 'preparing' | 'analyzing' | 'ready' | 'error';
  progressLabel: string;
  progressFraction: number;
  window: { t0: number; t1: number } | null;
  report: VisionReport | null;
  error: string | null;
}

interface AppState {
  phase: Phase;
  progressLabel: string;
  progressFraction: number;
  error: string | null;
  match: PreparedMatch | null;
  recordingId: string | null;
  view: View;
  vision: VisionState;
  t: number;
  maxT: number;
  playing: boolean;
  rate: number;
  playbackEpoch: number;
  spoilerFree: boolean;
  selectedMomentId: string | null;
  prefs: ViewerPrefs;
  ensurePrepared: (scenarioId: string | null, seed: number, recording?: string | null) => Promise<void>;
  setT: (t: number) => void;
  scrub: (t: number) => void;
  replay: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setRate: (rate: number) => void;
  selectMoment: (id: string | null) => void;
  setPrefs: (partial: Partial<ViewerPrefs>) => void;
  setSpoilerFree: (on: boolean) => void;
  setView: (view: View) => void;
  enterVision: () => Promise<void>;
  backToLaunch: () => void;
}

let preparationId = 0;

export const useAppStore = create<AppState>((set, get) => ({
  phase: 'launch', progressLabel: '', progressFraction: 0, error: null,
  match: null, recordingId: null, view: 'room',
  vision: { phase: 'idle', progressLabel: '', progressFraction: 0, window: null, report: null, error: null },
  t: 0, maxT: 0, playing: false, rate: 1, playbackEpoch: 0,
  spoilerFree: false, selectedMomentId: null,
  prefs: { persona: 'analyst', lang: 'en', clubId: null, playerId: null, metric: null },

  ensurePrepared: async (scenarioId, seed, recording) => {
    if (get().phase === 'preparing') return;
    const requestId = ++preparationId;
    set((state) => ({
      phase: 'preparing', progressLabel: 'Warming up', progressFraction: 0, error: null,
      match: null, playing: false, view: 'room', playbackEpoch: state.playbackEpoch + 1,
      vision: { phase: 'idle', progressLabel: '', progressFraction: 0, window: null, report: null, error: null },
    }));
    pipeline.onProgress = (label, fraction, channel) => {
      if (requestId !== preparationId) return;
      if (channel === 'vision') set((state) => ({ vision: { ...state.vision, progressLabel: label, progressFraction: fraction } }));
      else set({ progressLabel: label, progressFraction: fraction });
    };
    try {
      const match = await pipeline.prepare(scenarioId, seed, recording, new URL('recordings/', document.baseURI).href);
      if (requestId !== preparationId) return;
      trackingCache.reset();
      set((state) => ({
        phase: 'ready', match, recordingId: recording ?? null, t: 0, maxT: 0,
        playing: true, rate: 1, selectedMomentId: null,
        prefs: { ...state.prefs, clubId: null, playerId: null },
      }));
    } catch (error) {
      if (requestId === preparationId) set({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (requestId === preparationId) pipeline.onProgress = null;
    }
  },

  setT: (t) => {
    const max = get().match?.timing.fullTimeT ?? 0;
    const clamped = Math.max(0, Math.min(max, t));
    set((state) => ({ t: clamped, maxT: Math.max(state.maxT, clamped) }));
  },
  scrub: (t) => {
    const max = get().match?.timing.fullTimeT ?? 0;
    const clamped = Math.max(0, Math.min(max, t));
    set((state) => ({
      t: clamped, maxT: Math.max(state.maxT, clamped), selectedMomentId: null,
      playbackEpoch: state.playbackEpoch + 1,
    }));
    void trackingCache.ensure(Math.max(0, clamped - 3), Math.min(max, clamped + 40));
  },
  replay: (t) => {
    get().scrub(t);
    set({ playing: true, view: 'room' });
  },
  play: () => {
    if (get().t >= (get().match?.timing.fullTimeT ?? 0)) get().scrub(0);
    set({ playing: true });
  },
  pause: () => set({ playing: false }),
  toggle: () => get().playing ? get().pause() : get().play(),
  setRate: (rate) => set({ rate }),
  selectMoment: (id) => set({ selectedMomentId: id }),
  setPrefs: (partial) => set((state) => ({ prefs: { ...state.prefs, ...partial }, selectedMomentId: null, playbackEpoch: state.playbackEpoch + 1 })),
  setSpoilerFree: (on) => set({ spoilerFree: on, selectedMomentId: null }),
  setView: (view) => set({ view }),

  enterVision: async () => {
    const state = get();
    if (!state.match || state.vision.phase === 'analyzing' || state.vision.phase === 'preparing') return;
    const match = state.match;
    set({
      view: 'vision', playing: false,
      vision: { phase: 'preparing', window: null, report: null, progressLabel: 'Opening the tape', progressFraction: 0.02, error: null },
    });
    pipeline.onProgress = (label, fraction, channel) => {
      if (channel === 'vision' && get().match === match) set((s) => ({ vision: { ...s.vision, progressLabel: label, progressFraction: fraction } }));
    };
    try {
      const window = await pipeline.visionPrepare();
      if (get().match !== match) return;
      if (get().spoilerFree && window.t1 > get().t) {
        set((s) => ({ vision: { ...s.vision, phase: 'locked', progressLabel: '', window: null, report: null } }));
        return;
      }
      set((s) => ({ vision: { ...s.vision, window, phase: 'analyzing', progressLabel: 'Watching the tape', progressFraction: 0.05 } }));
      const report = await pipeline.visionAnalyze();
      if (get().match !== match) return;
      if (get().spoilerFree && window.t1 > get().t) {
        set((s) => ({ vision: { ...s.vision, phase: 'locked', window: null, report: null } }));
        return;
      }
      set((s) => ({ vision: { ...s.vision, phase: 'ready', report, progressLabel: 'Ready', progressFraction: 1 } }));
    } catch (error) {
      if (get().match === match) set((s) => ({ vision: { ...s.vision, phase: 'error', error: error instanceof Error ? error.message : String(error) } }));
    } finally {
      if (get().match === match) pipeline.onProgress = null;
    }
  },

  backToLaunch: () => {
    preparationId++;
    trackingCache.reset();
    set((state) => ({ phase: 'launch', match: null, playing: false, t: 0, maxT: 0, selectedMomentId: null, view: 'room', playbackEpoch: state.playbackEpoch + 1 }));
  },
}));

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __floodlight?: unknown }).__floodlight = useAppStore;
}
