import type { RichSigilAgent, SigilContext } from "../../../context.js";

export type CoderSession = {
  agent: RichSigilAgent;
  newSession: boolean;
};

export class CoderSessionLifecycle implements AsyncDisposable {
  private agent?: RichSigilAgent;
  private tasks = 0;
  private generation = 0;

  constructor(
    private readonly ctx: SigilContext,
    private readonly binding: string,
    private readonly taskLimit: number,
  ) {}

  async acquire(): Promise<CoderSession> {
    const taskLimitReached = this.agent !== undefined && this.tasks >= this.taskLimit;
    if (taskLimitReached) await this.close("task-limit");

    const newSession = this.agent === undefined;
    if (newSession) await this.open();

    this.tasks++;
    return { agent: this.agent!, newSession };
  }

  async invalidate(reason: string): Promise<void> {
    await this.close(reason);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close("implementation-completed");
  }

  private async open(): Promise<void> {
    this.agent = this.ctx.agent(this.binding);
    this.tasks = 0;
    this.generation++;
    await this.ctx.observe("coder-session-started", {
      generation: String(this.generation),
    });
  }

  private async close(reason: string): Promise<void> {
    if (!this.agent) return;

    const agent = this.agent;
    this.agent = undefined;
    await agent.close();
    await this.ctx.observe("coder-session-completed", {
      generation: String(this.generation),
      reason,
      tasks: String(this.tasks),
    });
  }
}
