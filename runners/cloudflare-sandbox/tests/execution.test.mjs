import assert from "node:assert/strict";
import { test } from "node:test";
import { execute, MAX_OUTPUT_BYTES } from "../src/execution.ts";

const input = { language: "python", code: "print(2)", timeout_ms: 1000 };
function stream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}
function fixture(options = {}) {
  const events = [];
  let close;
  const runtime = {
    images: { runtime: "registry.example/runtime@sha256:test" },
    start(value) {
      events.push(["start", value]);
      if (options.startError) throw new Error("boot failed");
    },
    async setInactivityTimeout(value) {
      events.push(["inactivity", value]);
    },
    async exec(command, value) {
      events.push(["exec", command, value]);
      if (options.execError) throw new Error("exec failed");
      return {
        stdout: options.hang
          ? new ReadableStream({
              start(controller) {
                close = () => controller.close();
              },
            })
          : stream(options.stdout ?? ["2\n"]),
        stderr: stream(options.stderr ?? []),
        exitCode: options.hang ? new Promise(() => {}) : Promise.resolve(options.exitCode ?? 0),
      };
    },
    async destroy() {
      events.push(["destroy"]);
      close?.();
      if (options.destroyError) throw new Error("destroy failed");
    },
  };
  return { runtime, events };
}

test("executes argv directly with no secrets or Internet and destroys the whole container", async () => {
  const { runtime, events } = fixture({ stderr: ["warning\n"] });
  const result = await execute(runtime, input);
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "2\n");
  assert.equal(result.stderr, "warning\n");
  assert.equal(result.exit_code, 0);
  assert.deepEqual(events[0], [
    "start",
    {
      image: runtime.images.runtime,
      instance: "lite",
      enableInternet: false,
      entrypoint: ["sleep", "infinity"],
    },
  ]);
  assert.deepEqual(events[2], [
    "exec",
    ["python3", "-I", "-u", "-c", input.code],
    { cwd: "/workspace", env: {}, stdout: "pipe", stderr: "pipe" },
  ]);
  assert.deepEqual(events.at(-1), ["destroy"]);
});

test("JavaScript code stays an argv argument without shell interpolation", async () => {
  const { runtime, events } = fixture();
  const code = "console.log('`$HOME; $(whoami)`')";
  await execute(runtime, { ...input, language: "javascript", code });
  assert.deepEqual(events[2][1], ["node", "--input-type=module", "--eval", code]);
});

test("a stalled process times out and triggers full container destruction", async () => {
  const { runtime, events } = fixture({ hang: true });
  const result = await execute(runtime, { ...input, timeout_ms: 100 });
  assert.equal(result.status, "timeout");
  assert.equal(result.exit_code, null);
  assert.deepEqual(events.at(-1), ["destroy"]);
});

test("container startup is included in the execution deadline", async () => {
  const { runtime, events } = fixture();
  runtime.setInactivityTimeout = () => new Promise(() => {});
  const result = await execute(runtime, { ...input, timeout_ms: 100 });
  assert.equal(result.status, "timeout");
  assert.equal(
    events.some(([event]) => event === "exec"),
    false,
  );
  assert.deepEqual(events.at(-1), ["destroy"]);
});

test("stdout and stderr share a bounded byte budget and overflow kills execution", async () => {
  const { runtime, events } = fixture({
    stdout: ["a".repeat(MAX_OUTPUT_BYTES - 5)],
    stderr: ["b".repeat(10)],
  });
  const result = await execute(runtime, input);
  assert.equal(result.status, "output_limit");
  assert.equal(
    new TextEncoder().encode(result.stdout + result.stderr).byteLength,
    MAX_OUTPUT_BYTES,
  );
  assert.deepEqual(events.at(-1), ["destroy"]);
});

test("UTF-8 characters split across output chunks decode correctly", async () => {
  const { runtime } = fixture();
  runtime.exec = async () => {
    const bytes = new TextEncoder().encode("한글");
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, 2));
          c.enqueue(bytes.slice(2));
          c.close();
        },
      }),
      stderr: null,
      exitCode: Promise.resolve(0),
    };
  };
  assert.equal((await execute(runtime, input)).stdout, "한글");
});

test("nonzero exit codes and boot or process failures still clean up", async () => {
  for (const options of [{ exitCode: 7 }, { startError: true }, { execError: true }]) {
    const { runtime, events } = fixture(options);
    const result = await execute(runtime, input);
    assert.equal(result.exit_code, options.exitCode ?? null);
    assert.equal(result.status, options.exitCode ? "completed" : "error");
    assert.deepEqual(events.at(-1), ["destroy"]);
  }
});

test("cleanup failures are propagated so the Durable Object retains its recovery alarm", async () => {
  const { runtime } = fixture({ destroyError: true });
  await assert.rejects(execute(runtime, input), /destroy failed/);
});

test("invalid execution input is rejected before allocating a runtime", async () => {
  const { runtime, events } = fixture();
  await assert.rejects(execute(runtime, { ...input, timeout_ms: 0 }), /Invalid execution input/);
  assert.deepEqual(events, []);
});
