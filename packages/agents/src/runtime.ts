/**
 * Crew runtime — the shared machinery every agent runs on.
 *
 * Agents are handlers on named workstreams. The runtime provides bounded
 * retries, timeouts, explicit fallback chains, handoff bookkeeping and a
 * span-per-task trace. When a task finally fails, the failure is recorded
 * and the pipeline continues — a live production never stalls because one
 * story could not be written.
 */

export type TaskStatus = 'completed' | 'fallback' | 'failed';

export interface TaskTrace {
  taskId: string;
  agentId: string;
  kind: string;
  startedAt: number;
  endedAt: number;
  attempts: number;
  status: TaskStatus;
  provider: string | null;
  note?: string;
}

export interface TaskContext {
  taskId: string;
  agentId: string;
  attempt: number;
  useFallback: boolean;
  note: (message: string) => void;
}

export interface TaskDefinition<Input, Output> {
  agentId: string;
  kind: string;
  input: Input;
  /** Primary attempt; may throw to trigger a retry. */
  run: (input: Input, ctx: TaskContext) => Promise<Output>;
  /** Deterministic last resort; must not throw for the pipeline to survive. */
  fallback?: (input: Input, ctx: TaskContext) => Output | Promise<Output>;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface TaskOutcome<Output> {
  status: TaskStatus;
  output: Output | null;
  trace: TaskTrace;
}

let taskSeq = 0;

export class CrewRuntime {
  private readonly traces: TaskTrace[] = [];
  private providerHint: (() => string | null) | null = null;

  /** The runtime asks the crew for the provider of the most recent call. */
  setProviderHint(hint: () => string | null): void {
    this.providerHint = hint;
  }

  async dispatch<Input, Output>(definition: TaskDefinition<Input, Output>): Promise<TaskOutcome<Output>> {
    taskSeq++;
    const taskId = `task-${String(taskSeq).padStart(4, '0')}`;
    const startedAt = Date.now();
    const maxAttempts = definition.maxAttempts ?? 2;
    const timeoutMs = definition.timeoutMs ?? 20_000;
    let attempts = 0;
    let note: string | undefined;

    const ctx: TaskContext = {
      taskId,
      agentId: definition.agentId,
      attempt: 0,
      useFallback: false,
      note: (message) => {
        note = message;
      },
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      ctx.attempt = attempt;
      try {
        const output = await withTimeout(definition.run(definition.input, ctx), timeoutMs, `${definition.agentId}:${definition.kind} timed out`);
        const trace: TaskTrace = {
          taskId,
          agentId: definition.agentId,
          kind: definition.kind,
          startedAt,
          endedAt: Date.now(),
          attempts,
          status: 'completed',
          provider: this.providerHint?.() ?? null,
        };
        this.traces.push(trace);
        return { status: 'completed', output, trace };
      } catch (error) {
        ctx.note(error instanceof Error ? error.message : String(error));
      }
    }

    if (definition.fallback) {
      ctx.useFallback = true;
      try {
        const output = await definition.fallback(definition.input, ctx);
        const trace: TaskTrace = {
          taskId,
          agentId: definition.agentId,
          kind: definition.kind,
          startedAt,
          endedAt: Date.now(),
          attempts,
          status: 'fallback',
          provider: null,
          note,
        };
        this.traces.push(trace);
        return { status: 'fallback', output, trace };
      } catch (error) {
        note = error instanceof Error ? error.message : String(error);
      }
    }

    const trace: TaskTrace = {
      taskId,
      agentId: definition.agentId,
      kind: definition.kind,
      startedAt,
      endedAt: Date.now(),
      attempts,
      status: 'failed',
      provider: null,
      note,
    };
    this.traces.push(trace);
    return { status: 'failed', output: null, trace };
  }

  allTraces(): TaskTrace[] {
    return [...this.traces];
  }

  /** Aggregate health for the ops panel. */
  stats(): { completed: number; fallback: number; failed: number; agentBreakdown: Record<string, { completed: number; fallback: number; failed: number }> } {
    const breakdown: Record<string, { completed: number; fallback: number; failed: number }> = {};
    let completed = 0;
    let fallback = 0;
    let failed = 0;
    for (const trace of this.traces) {
      if (trace.status === 'completed') completed++;
      else if (trace.status === 'fallback') fallback++;
      else failed++;
      const entry = breakdown[trace.agentId] ?? { completed: 0, fallback: 0, failed: 0 };
      entry[trace.status]++;
      breakdown[trace.agentId] = entry;
    }
    return { completed, fallback, failed, agentBreakdown: breakdown };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
