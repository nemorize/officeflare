export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 30_000;

export interface ExecutionInput {
  language: "python" | "javascript";
  code: string;
  timeout_ms: number;
}

export interface ExecutionResult {
  status: "completed" | "timeout" | "output_limit" | "error";
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export function validInput(value: unknown): value is ExecutionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).every((key) => ["language", "code", "timeout_ms"].includes(key)) &&
    (input.language === "python" || input.language === "javascript") &&
    typeof input.code === "string" &&
    input.code.trim().length > 0 &&
    new TextEncoder().encode(input.code).byteLength <= MAX_CODE_BYTES &&
    typeof input.timeout_ms === "number" &&
    Number.isInteger(input.timeout_ms) &&
    input.timeout_ms >= 100 &&
    input.timeout_ms <= MAX_TIMEOUT_MS
  );
}

type Runtime = Pick<Container, "start" | "exec" | "destroy" | "images" | "setInactivityTimeout">;

class ExecutionStopped extends Error {
  readonly status: "timeout" | "output_limit";

  constructor(status: "timeout" | "output_limit") {
    super(status);
    this.status = status;
  }
}

/** Owns the whole container lifecycle, including processes forked by user code. */
export async function execute(container: Runtime, input: ExecutionInput): Promise<ExecutionResult> {
  if (!validInput(input)) throw new Error("Invalid execution input");
  const started = Date.now();
  let stopped = false;
  let remaining = MAX_OUTPUT_BYTES;
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function collect(stream: ReadableStream<Uint8Array> | null, chunks: Uint8Array[]) {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const size = Math.min(remaining, chunk.value.byteLength);
        if (size) chunks.push(chunk.value.slice(0, size));
        remaining -= size;
        if (size < chunk.value.byteLength) throw new ExecutionStopped("output_limit");
      }
    } finally {
      reader.releaseLock();
    }
  }

  const result: ExecutionResult = {
    status: "error",
    exit_code: null,
    stdout: "",
    stderr: "",
    duration_ms: 0,
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      reject(new ExecutionStopped("timeout"));
    }, input.timeout_ms);
  });

  try {
    const run = async () => {
      const image = container.images.runtime;
      if (!image) throw new Error("Missing runtime image");
      container.start({
        image,
        instance: "lite",
        enableInternet: false,
        entrypoint: ["sleep", "infinity"],
      });
      await container.setInactivityTimeout(input.timeout_ms + 5_000);
      if (stopped) throw new ExecutionStopped("timeout");
      const command =
        input.language === "python"
          ? ["python3", "-I", "-u", "-c", input.code]
          : ["node", "--input-type=module", "--eval", input.code];
      const process = await container.exec(command, {
        cwd: "/workspace",
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code] = await Promise.all([
        process.exitCode,
        collect(process.stdout, stdout),
        collect(process.stderr, stderr),
      ]);
      return code;
    };
    result.exit_code = await Promise.race([run(), deadline]);
    result.status = "completed";
  } catch (error) {
    result.status = error instanceof ExecutionStopped ? error.status : "error";
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    // A process signal cannot stop all descendants; always destroy the entire container.
    // Let cleanup failures reach the caller, which retains its recovery alarm.
    await container.destroy();
  }

  function decode(chunks: Uint8Array[]) {
    const decoder = new TextDecoder();
    return (
      chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode()
    );
  }
  result.stdout = decode(stdout);
  result.stderr = decode(stderr);
  result.duration_ms = Date.now() - started;
  return result;
}
