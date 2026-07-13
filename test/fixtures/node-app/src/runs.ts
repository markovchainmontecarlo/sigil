import type { RunWorkflowResult, ServerEvent } from "sigil/server";

export type Job = { runId: string; workflowId: string; cancelRequested: boolean };
export type RunRecord = {
  runId: string;
  transitions: string[];
  events: ServerEvent[];
  terminals: RunWorkflowResult<unknown>[];
  cancelRequested: boolean;
};

export class RunStore {
  readonly records = new Map<string, RunRecord>();
  readonly queue: Job[] = [];

  accept(runId: string, cancelRequested: boolean): void {
    this.records.set(runId, { runId, transitions: ["accepted"], events: [], terminals: [], cancelRequested });
  }

  enqueue(job: Job): void {
    this.queue.push(job);
    this.record(job.runId).transitions.push("queued");
  }

  acquire(): Job {
    const job = this.queue.shift();
    if (!job) throw new Error("queue empty");
    this.record(job.runId).transitions.push("acquired");
    return job;
  }

  running(runId: string): void {
    this.record(runId).transitions.push("running");
  }

  event(runId: string, event: ServerEvent): void {
    this.record(runId).events.push(event);
  }

  terminal(runId: string, result: RunWorkflowResult<unknown>): void {
    const record = this.record(runId);
    if (record.terminals.length !== 0) throw new Error("terminal result already persisted");
    record.terminals.push(result);
    record.transitions.push("terminal");
  }

  record(runId: string): RunRecord {
    const record = this.records.get(runId);
    if (!record) throw new Error(`unknown run: ${runId}`);
    return record;
  }
}
