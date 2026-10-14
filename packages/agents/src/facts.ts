/**
 * The fact surface the crew consults.
 *
 * `briefFor` reads the live match through this interface — the snapshot, the
 * score at a time, the flow features over a window. The default reads the
 * engine directly; the running pipeline swaps in an MCP client so every
 * number the crew cites arrives over a real tool call, and a plain object
 * over the same engine otherwise. One interface, so the crew neither knows
 * nor cares which side of the wire the numbers come from.
 */

import type { MatchState, WindowFeatures } from '@floodlight/engine';

export interface MatchFacts {
  snapshot(): Promise<MatchState>;
  scoreAt(t: number): Promise<{ home: number; away: number }>;
  windowFeatures(t0: number, t1: number): Promise<WindowFeatures>;
}

/** Anything shaped like the engine's fact methods — the engine itself qualifies. */
export interface FactsSource {
  snapshot(): MatchState;
  scoreAt(t: number): { home: number; away: number };
  windowFeatures(t0: number, t1: number): WindowFeatures;
}

/** Facts over a live engine — the in-process default. */
export function liveFacts(engine: FactsSource): MatchFacts {
  return {
    async snapshot() {
      return engine.snapshot();
    },
    async scoreAt(t: number) {
      return engine.scoreAt(t);
    },
    async windowFeatures(t0: number, t1: number) {
      return engine.windowFeatures(t0, t1);
    },
  };
}
