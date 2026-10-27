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
/** A 90-second live window ending two seconds after a second-half goal.
 *  The anchor leaves a full build-up inside the second half, so the clip is
 *  live play rather than half-time, a review or a restart. */
export function visionWindowFor(result: SimulationResult): { t0: number; t1: number } {
  const goals = result.events.filter(
    (e) => e.type === 'shot' && (e as { outcome: string }).outcome === 'goal',
  );
  const half = result.timing.halfTimeT;
  const clean = goals.find((e) => e.t >= half + 95);
  const anchor = clean?.t ?? goals.find((e) => e.t > 40 * 60)?.t ?? 20 * 60;
  const t1 = Math.min(result.timing.fullTimeT, Math.ceil(anchor) + 2);
  return { t0: Math.max(0, t1 - 90), t1 };
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
