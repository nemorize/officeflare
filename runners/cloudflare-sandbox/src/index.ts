import { DurableObject } from "cloudflare:workers";
import { execute, MAX_TIMEOUT_MS, validInput, type ExecutionInput } from "./execution.ts";
import { handleRequest } from "./mcp.ts";

export class SandboxExecution extends DurableObject<Env> {
  private used = false;

  async run(input: ExecutionInput) {
    if (this.used || !validInput(input)) throw new Error("Invalid execution");
    this.used = true;
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding missing");
    // Recovery if the HTTP client disconnects or the object is interrupted during execution.
    await this.ctx.storage.setAlarm(Date.now() + MAX_TIMEOUT_MS + 10_000);
    const result = await execute(container, input);
    await this.ctx.storage.deleteAlarm();
    return result;
  }

  async alarm() {
    await this.ctx.container?.destroy();
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env.EXECUTOR_TOKEN, (input) => {
      const execution = env.EXECUTIONS.get(env.EXECUTIONS.newUniqueId());
      return execution.run(input);
    });
  },
} satisfies ExportedHandler<Env>;
