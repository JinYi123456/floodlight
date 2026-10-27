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
  signal: AbortSignal;
  note: (message: string) => void;
}
export interface TaskDefinition<Input, Output> {
  agentId: string;
  kind: string;
  input: Input;
  run: (input: Input, ctx: TaskContext) => Promise<Output>;
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
  setProviderHint(hint: () => string | null): void { this.providerHint = hint; }

  async dispatch<Input, Output>(definition: TaskDefinition<Input, Output>): Promise<TaskOutcome<Output>> {
    const taskId = `task-${String(++taskSeq).padStart(4, '0')}`;
    const startedAt = Date.now();
    let attempts = 0;
    let note: string | undefined;
    const finish = (status: TaskStatus, output: Output | null): TaskOutcome<Output> => {
      const trace: TaskTrace = { taskId, agentId: definition.agentId, kind: definition.kind, startedAt,
        endedAt: Date.now(), attempts, status, provider: status === 'completed' ? this.providerHint?.() ?? null : null, ...(note ? { note } : {}) };
      this.traces.push(trace);
      return { status, output, trace };
    };
    for (let attempt = 1; attempt <= (definition.maxAttempts ?? 2); attempt++) {
      attempts = attempt;
      const controller = new AbortController();
      let active = true;
      const ctx: TaskContext = { taskId, agentId: definition.agentId, attempt, useFallback: false,
        signal: controller.signal, note: (message) => { if (active) note = message; } };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = await Promise.race([
          definition.run(definition.input, ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error(`${definition.agentId}:${definition.kind} timed out`);
              controller.abort(error);
              reject(error);
            }, definition.timeoutMs ?? 20_000);
          }),
        ]);
        if (output === null || output === undefined) throw new Error('task returned no output');
        return finish('completed', output);
      } catch (error) {
        note = error instanceof Error ? error.message : String(error);
        // Do not overlap a retry with a timed-out provider that ignores cancellation.
        if (controller.signal.aborted) break;
      } finally {
        active = false;
        if (timer) clearTimeout(timer);
      }
    }
    if (definition.fallback) {
      try {
        const output = await definition.fallback(definition.input, {
          taskId, agentId: definition.agentId, attempt: attempts, useFallback: true,
          signal: new AbortController().signal, note: (message) => { note = message; },
        });
        if (output === null || output === undefined) throw new Error('fallback returned no output');
        return finish('fallback', output);
      } catch (error) { note = error instanceof Error ? error.message : String(error); }
    }
    return finish('failed', null);
  }
  allTraces(): TaskTrace[] { return [...this.traces]; }
  stats(): { completed: number; fallback: number; failed: number; agentBreakdown: Record<string, { completed: number; fallback: number; failed: number }> } {
    const totals = { completed: 0, fallback: 0, failed: 0 };
    const agentBreakdown: Record<string, typeof totals> = {};
    for (const trace of this.traces) {
      totals[trace.status]++;
      const entry = agentBreakdown[trace.agentId] ?? { completed: 0, fallback: 0, failed: 0 };
      entry[trace.status]++;
      agentBreakdown[trace.agentId] = entry;
    }
    return { ...totals, agentBreakdown };
  }
}
