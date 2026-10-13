/**
 * Vision — auto-eventing over a rendered match feed.
 *
 * The promise: point the pipeline at pixels and it re-derives passes, shots
 * and speeds on its own, then scores itself against the events the
 * simulation actually produced.
 */

import type { SimulationResult } from '@floodlight/simulator';
import { analyzeWindow, buildReport, type AnalyzeOptions, type AnalyzeResult, type DerivedEvent, type VisionReport } from './events';

export { renderFeedFrame, renderPixels, homeIdSet, projection, px, py, toPitch } from './raster';
export type { RenderedFrame, Projection, RasterOptions } from './raster';
export { detectEntities, learnPalettes } from './detect';
export type { DetectedEntity, KitPalettes } from './detect';
export { TrackingLayer } from './track';
export type { Track } from './track';
export { EventDeriver, truthOwnerTeam, analyzeWindow, buildReport } from './events';
export type { DerivedEvent, AnalyzeOptions, AnalyzeResult, FrameSample, VisionReport } from './events';

/**
 * Choose the analysis window for a match: a busy stretch around the first
 * goal after minute 40 (or the 20th minute when the match stays goalless).
 */
export function visionWindowFor(result: SimulationResult): { t0: number; t1: number } {
  const goals = result.events.filter(
    (e) => e.type === 'shot' && (e as { outcome: string }).outcome === 'goal' && e.t > 40 * 60,
  );
  const anchor = goals.length > 0 ? goals[0]!.t : 20 * 60;
  const t0 = Math.max(0, Math.round(anchor - 55));
  return { t0, t1: Math.min(result.timing.fullTimeT, t0 + 90) };
}

export interface VisionPassResult {
  report: VisionReport;
  analysis: AnalyzeResult;
  events: DerivedEvent[];
}

/** One-shot: analyse the live window and produce the accuracy report. */
export function runVisionPass(
  result: SimulationResult,
  window?: { t0: number; t1: number },
  options: Partial<AnalyzeOptions> = {},
): VisionPassResult {
  const w = window ?? visionWindowFor(result);
  const analysis = analyzeWindow(result, { t0: w.t0, t1: w.t1, ...options });
  const report = buildReport(result, analysis, w);
  return { report, analysis, events: analysis.events };
}
