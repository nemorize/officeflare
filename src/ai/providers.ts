import { t } from "../../shared/i18n/index.ts";
import { digest } from "../auth/crypto";
import { boundedBody, publicDns, remoteUrl } from "../mail/remote";
import { fail } from "./errors";
import { object, parse } from "./store";
import type {
  Account,
  AIMessage,
  AIRequest,
  AIResult,
  AIRuntime,
  AIUsage,
  AILimits,
  Deployment,
  Fetcher,
  Provider,
} from "./types";

export class ProviderFailure extends Error {
  constructor(
    readonly status: number,
    readonly accepted: boolean,
    readonly code: string,
    readonly retryAfter = 0,
  ) {
    super(code);
  }
}
export function safeUrl(value: string) {
  if (!value.startsWith("https://")) fail(400, "AI_INVALID_INPUT");
  try {
    return remoteUrl(value);
  } catch {
    fail(400, "AI_INVALID_INPUT");
  }
}
export async function safeFetch(
  url: string,
  init: RequestInit,
  fetcher: Fetcher = (input, options) => globalThis.fetch(input, options),
) {
  const target = safeUrl(url),
    signal = init.signal ?? AbortSignal.timeout(15000);
  await publicDns(target.hostname, fetcher, signal);
  const response = await fetcher(target.href, { ...init, redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ProviderFailure(502, false, "REDIRECT_BLOCKED");
  }
  return response;
}
export const price = (pricing: Record<string, unknown>, usage: AIUsage): number | null => {
  if (pricing.currency !== "USD" || pricing.unit !== "micro_usd_per_million_tokens") return null;
  const input = pricing.input,
    output = pricing.output;
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 0 ||
    !Number.isSafeInteger(output) ||
    (output as number) < 0
  )
    return null;
  const read = pricing.cache_read ?? input,
    write = pricing.cache_write ?? input;
  if (
    !Number.isSafeInteger(read) ||
    (read as number) < 0 ||
    !Number.isSafeInteger(write) ||
    (write as number) < 0
  )
    return null;
  // Cache fields are subsets of canonical input tokens, never added to total tokens twice.
  const uncached = Math.max(
    0,
    usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens,
  );
  const numerator =
    BigInt(uncached) * BigInt(input as number) +
    BigInt(usage.cached_input_tokens) * BigInt(read as number) +
    BigInt(usage.cache_write_tokens) * BigInt(write as number) +
    BigInt(usage.output_tokens) * BigInt(output as number);
  const result = Number((numerator + 999999n) / 1000000n);
  if (!Number.isSafeInteger(result)) fail(422, "AI_LIMIT_REACHED");
  return result;
};
export function usageBound(request: AIRequest, deployment: Deployment, limits: AILimits) {
  const caps = parse(deployment.capabilities_json);
  const input =
    new TextEncoder().encode(
      JSON.stringify({
        messages: request.messages,
        tools: request.tools ?? [],
        schema: request.outputSchema ?? null,
      }),
    ).length + Number(caps.input_overhead_tokens ?? 1024);
  if (!Number.isSafeInteger(input) || input > limits.max_input_tokens)
    fail(422, "AI_LIMIT_REACHED");
  if (request.tools?.length && caps.tool_calls !== true) fail(422, "AI_CAPABILITY_UNSUPPORTED");
  if (request.outputSchema && caps.json_schema !== true) fail(422, "AI_CAPABILITY_UNSUPPORTED");
  if (deployment.protocol === "cloudflare_run" && (request.tools?.length || request.outputSchema))
    fail(422, "AI_CAPABILITY_UNSUPPORTED");
  const plan = deployment.auth_mode === "chatgpt_plan";
  if (
    caps.input_token_bound !== "utf8_bytes" ||
    caps.bounded_usage !== true ||
    (!plan && caps.enforces_output_limit !== true)
  )
    fail(422, "AI_USAGE_BOUND_UNAVAILABLE");
  const outputMaximum = Number(caps.max_output_tokens ?? 0),
    outputBound = plan ? outputMaximum : limits.max_output_tokens;
  // ChatGPT plan requests cannot set max_output_tokens. Reserve a verified model
  // maximum instead, and refuse a caller limit that this route cannot enforce.
  if (
    !Number.isSafeInteger(outputMaximum) ||
    outputMaximum < 1 ||
    (plan && limits.max_output_tokens < outputMaximum)
  )
    fail(422, "AI_USAGE_BOUND_UNAVAILABLE");
  if (outputBound > outputMaximum || input + outputBound > Number(caps.context_tokens ?? 0))
    fail(422, "AI_LIMIT_REACHED");
  const usage: AIUsage = {
    input_tokens: input,
    output_tokens: outputBound,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    source: "estimated",
  };
  const pricing = parse(deployment.pricing_json);
  const maximumInputPrice = Math.max(
    Number(pricing.input ?? 0),
    Number(pricing.cache_read ?? 0),
    Number(pricing.cache_write ?? 0),
  );
  const cost = price({ ...pricing, input: maximumInputPrice }, usage);
  if (limits.max_cost_micro_usd !== null && (cost === null || cost > limits.max_cost_micro_usd))
    fail(422, cost === null ? "AI_USAGE_BOUND_UNAVAILABLE" : "AI_LIMIT_REACHED");
  return { usage, cost };
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function normalizeUsage(raw: any, protocol: string): AIUsage {
  if (!raw)
    return {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      source: "unknown",
    };
  if (protocol === "google_generate_content")
    return {
      input_tokens: count(raw.promptTokenCount),
      output_tokens: count(raw.candidatesTokenCount) + count(raw.thoughtsTokenCount),
      cached_input_tokens: count(raw.cachedContentTokenCount),
      cache_write_tokens: 0,
      reasoning_tokens: count(raw.thoughtsTokenCount),
      source: "provider",
    };
  if (protocol === "anthropic_messages")
    return {
      input_tokens:
        count(raw.input_tokens) +
        count(raw.cache_read_input_tokens) +
        count(raw.cache_creation_input_tokens),
      output_tokens: count(raw.output_tokens),
      cached_input_tokens: count(raw.cache_read_input_tokens),
      cache_write_tokens: count(raw.cache_creation_input_tokens),
      reasoning_tokens: 0,
      source: "provider",
    };
  return {
    input_tokens: count(raw.input_tokens ?? raw.prompt_tokens),
    output_tokens: count(raw.output_tokens ?? raw.completion_tokens),
    cached_input_tokens: count(
      raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens,
    ),
    cache_write_tokens: 0,
    reasoning_tokens: count(
      raw.output_tokens_details?.reasoning_tokens ??
        raw.completion_tokens_details?.reasoning_tokens,
    ),
    source: "provider",
  };
}
async function readEvents(response: Response, protocol: string, runtime: AIRuntime) {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return {
      events: [JSON.parse(new TextDecoder().decode(await boundedBody(response, 8 * 1024 * 1024)))],
      streamed: false,
    };
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderFailure(502, true, "EMPTY_STREAM");
  const events: any[] = [],
    decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  const event = async (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const value = JSON.parse(data);
    events.push(value);
    if (events.length > 10000) throw new ProviderFailure(502, true, "STREAM_TOO_LARGE");
    if (value.error || value.type === "response.failed" || value.type === "error")
      throw new ProviderFailure(502, true, "STREAM_FAILED");
    let delta =
      protocol === "openai_responses"
        ? value.type === "response.output_text.delta"
          ? value.delta
          : ""
        : protocol === "anthropic_messages"
          ? value.type === "content_block_delta"
            ? value.delta?.text
            : ""
          : protocol === "google_generate_content"
            ? (value.candidates?.[0]?.content?.parts ?? [])
                .filter((part: any) => !part.thought)
                .map((part: any) => part.text ?? "")
                .join("")
            : (value.choices?.[0]?.delta?.content ?? value.response ?? "");
    if (typeof delta === "string" && delta) await runtime.onDelta?.(delta);
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 8 * 1024 * 1024) throw new ProviderFailure(502, true, "STREAM_TOO_LARGE");
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        await event(block);
      }
      if (buffer.length > 1024 * 1024) throw new ProviderFailure(502, true, "EVENT_TOO_LARGE");
    }
    buffer += decoder.decode();
    if (buffer.trim()) await event(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return { events, streamed: true };
}
function responsesInput(
  messages: AIMessage[],
  names: Map<string, string>,
  providerId: string,
  accountId: string,
) {
  return messages
    .filter((message) => message.role !== "system")
    .flatMap((message): any[] => {
      if (message.role === "tool")
        return [
          { type: "function_call_output", call_id: message.tool_call_id, output: message.content },
        ];
      const state = message.provider_state as
        { provider_id?: string; account_id?: string; items?: unknown[] } | undefined;
      if (
        state?.provider_id === providerId &&
        state.account_id === accountId &&
        Array.isArray(state.items)
      )
        return state.items;
      return [
        ...(message.content ? [{ role: message.role, content: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: names.get(call.name),
          arguments: JSON.stringify(call.arguments),
        })),
      ];
    });
}
export async function callProvider(
  request: AIRequest,
  provider: Provider,
  deployment: Deployment,
  account: Account,
  credentials: Record<string, unknown>,
  limits: AILimits,
  generation: Record<string, unknown>,
  gateway: { baseUrl: string; token: string } | null,
  runtime: AIRuntime = {},
): Promise<Omit<AIResult, "invocation_id"> & { request_id: string | null }> {
  const names = new Map<string, string>();
  for (const tool of request.tools ?? [])
    names.set(tool.name, "t_" + (await digest(tool.name)).slice(0, 28));
  const original = new Map([...names].map(([name, encoded]) => [encoded, name]));
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const protocol = deployment.protocol,
    model = deployment.provider_model_id;
  const protocolState = (message: AIMessage, field: "parts" | "content") => {
    const state = message.provider_state as
      | {
          protocol?: string;
          provider_id?: string;
          account_id?: string;
          deployment_id?: string;
          parts?: unknown[];
          content?: unknown[];
        }
      | undefined;
    return state?.protocol === protocol &&
      state.provider_id === provider.id &&
      state.account_id === account.id &&
      state.deployment_id === deployment.id &&
      Array.isArray(state[field])
      ? state[field]
      : undefined;
  };
  const stateFor = (content: unknown[], field: "parts" | "content") => ({
    protocol,
    provider_id: provider.id,
    account_id: account.id,
    deployment_id: deployment.id,
    [field]: content,
  });
  const base = (gateway?.baseUrl ?? provider.base_url).replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const token = String(credentials.access_token ?? credentials.api_key ?? "");
  if (gateway) headers["cf-aig-authorization"] = "Bearer " + gateway.token;
  let url = "",
    body: Record<string, unknown>;
  const tools = request.tools ?? [];
  if (protocol === "openai_responses") {
    headers.Authorization = "Bearer " + token;
    url = base + "/responses";
    body = {
      ...generation,
      model,
      input: responsesInput(request.messages, names, provider.id, account.id),
      ...(system ? { instructions: system } : {}),
      store: false,
      stream: true,
      max_output_tokens: limits.max_output_tokens,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              name: names.get(tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            })),
          }
        : {}),
      ...(request.outputSchema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "result",
                schema: request.outputSchema,
                strict: true,
              },
            },
          }
        : {}),
    };
    if (generation.reasoning_effort !== undefined) {
      body.reasoning = { effort: generation.reasoning_effort };
      delete body.reasoning_effort;
    }
    if (deployment.auth_mode === "chatgpt_plan") {
      delete body.max_output_tokens;
      delete body.temperature;
      delete body.top_p;
      if (tools.length)
        body.tools = [
          {
            type: "namespace",
            name: "officeflare",
            description: t("mcp.namespace"),
            tools: body.tools as unknown[],
          },
        ];
    }
  } else if (protocol === "anthropic_messages") {
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
    url = base + "/messages";
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content:
          protocolState(message, "content") ??
          (message.role === "tool"
            ? [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }]
            : [
                ...(message.content ? [{ type: "text", text: message.content }] : []),
                ...(message.tool_calls ?? []).map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: names.get(call.name),
                  input: call.arguments,
                })),
              ]),
      }));
    body = {
      ...generation,
      model,
      messages,
      ...(system ? { system } : {}),
      stream: true,
      max_tokens: limits.max_output_tokens,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: names.get(tool.name),
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
      ...(request.outputSchema
        ? { output_config: { format: { type: "json_schema", schema: request.outputSchema } } }
        : {}),
    };
    if (generation.reasoning_effort !== undefined) {
      delete body.reasoning_effort;
      body.output_config = {
        ...object(body.output_config ?? {}),
        effort: generation.reasoning_effort,
      };
    }
  } else if (protocol === "google_generate_content") {
    headers["x-goog-api-key"] = token;
    url = base + "/models/" + encodeURIComponent(model) + ":streamGenerateContent?alt=sse";
    const contents = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts:
          protocolState(message, "parts") ??
          (message.role === "tool"
            ? [
                {
                  functionResponse: {
                    id: message.tool_call_id,
                    name: names.get(message.tool_name ?? "") ?? message.tool_call_id,
                    response: { result: message.content },
                  },
                },
              ]
            : [
                ...(message.content ? [{ text: message.content }] : []),
                ...(message.tool_calls ?? []).map((call) => ({
                  functionCall: { id: call.id, name: names.get(call.name), args: call.arguments },
                })),
              ]),
      }));
    body = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(generation.temperature !== undefined ? { temperature: generation.temperature } : {}),
        ...(generation.top_p !== undefined ? { topP: generation.top_p } : {}),
        ...(generation.reasoning_effort !== undefined
          ? { thinkingConfig: { thinkingLevel: String(generation.reasoning_effort).toUpperCase() } }
          : {}),
        maxOutputTokens: limits.max_output_tokens,
        ...(request.outputSchema
          ? { responseMimeType: "application/json", responseJsonSchema: request.outputSchema }
          : {}),
      },
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: names.get(tool.name),
                  description: tool.description,
                  parametersJsonSchema: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
    };
  } else {
    headers.Authorization = "Bearer " + token;
    const messages = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls?.length
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: names.get(call.name), arguments: JSON.stringify(call.arguments) },
            })),
          }
        : {}),
    }));
    body = {
      ...generation,
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: limits.max_output_tokens,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: names.get(tool.name),
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.outputSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "result", strict: true, schema: request.outputSchema },
            },
          }
        : {}),
    };
    url = base + "/chat/completions";
    if (protocol === "cloudflare_run") {
      const modelPath = model.split("/").map(encodeURIComponent).join("/");
      url = base + (gateway ? "/" : "/run/") + modelPath;
      body = { ...generation, messages, stream: true, max_tokens: limits.max_output_tokens };
    }
  }
  if (provider.adapter_key === "openrouter") {
    const config = parse(deployment.config_json);
    body.provider = {
      ...object(config.routing ?? {}),
      require_parameters: true,
      allow_fallbacks: false,
      data_collection: "deny",
    };
  }
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, AbortSignal.timeout(limits.timeout_seconds * 1000)])
    : AbortSignal.timeout(limits.timeout_seconds * 1000);
  let response: Response;
  try {
    response = await safeFetch(
      url,
      { method: "POST", headers, body: JSON.stringify(body), signal },
      runtime.fetcher,
    );
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(502, true, "CONNECTION_UNKNOWN");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderFailure(
      response.status,
      response.status >= 500 || response.status === 408,
      "HTTP_" + response.status,
      Math.min(3600, Math.max(0, Number(response.headers.get("retry-after")) || 0)),
    );
  }
  let data: { events: any[]; streamed: boolean };
  try {
    data = await readEvents(response, protocol, runtime);
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(502, true, "STREAM_UNKNOWN");
  }
  const result = {
    text: "",
    tool_calls: [] as AIResult["tool_calls"],
    finish_reason: "stop",
    usage: normalizeUsage(null, protocol),
    request_id: response.headers.get("x-request-id") ?? response.headers.get("cf-aig-log-id"),
    provider_state: undefined as unknown,
  };
  const addCall = (id: string, name: string, args: unknown) => {
    const decoded = original.get(name);
    if (!decoded) throw new ProviderFailure(502, true, "UNKNOWN_TOOL");
    result.tool_calls.push({
      id,
      name: decoded,
      arguments: object(typeof args === "string" ? JSON.parse(args) : args),
    });
  };
  if (protocol === "openai_responses") {
    const terminal =
      [...data.events].reverse().find((event) => event.type === "response.completed")?.response ??
      (!data.streamed ? data.events[0] : null);
    if (!terminal || terminal.status !== "completed")
      throw new ProviderFailure(502, true, "INCOMPLETE_RESPONSE");
    result.usage = normalizeUsage(terminal.usage, protocol);
    for (const item of terminal.output ?? []) {
      if (item.type === "message")
        result.text += (item.content ?? [])
          .filter((part: any) => part.type === "output_text")
          .map((part: any) => part.text)
          .join("");
      if (item.type === "function_call") addCall(item.call_id, item.name, item.arguments);
    }
    // Only encrypted reasoning state is retained; never expose internal reasoning text.
    result.provider_state = {
      provider_id: provider.id,
      account_id: account.id,
      items: (terminal.output ?? [])
        .filter((item: any) => item.type !== "reasoning" || item.encrypted_content)
        .map((item: any) =>
          item.type === "reasoning"
            ? { type: item.type, summary: [], encrypted_content: item.encrypted_content }
            : item,
        ),
    };
  } else if (protocol === "anthropic_messages") {
    const blocks = new Map<number, any>();
    let usage: any = null,
      finished = !data.streamed;
    for (const event of data.events) {
      if (!data.streamed) {
        for (const [index, block] of (event.content ?? []).entries()) blocks.set(index, block);
        usage = event.usage;
        result.finish_reason = event.stop_reason ?? "stop";
      }
      if (event.type === "message_start") usage = event.message.usage;
      if (event.type === "content_block_start")
        blocks.set(event.index, { ...event.content_block, partial: "" });
      if (event.type === "content_block_delta") {
        const block = blocks.get(event.index);
        if (block) {
          if (event.delta.text) block.text = (block.text ?? "") + event.delta.text;
          if (event.delta.partial_json) block.partial += event.delta.partial_json;
          if (event.delta.thinking) block.thinking = (block.thinking ?? "") + event.delta.thinking;
          if (event.delta.signature)
            block.signature = (block.signature ?? "") + event.delta.signature;
        }
      }
      if (event.type === "message_delta") {
        usage = { ...usage, ...event.usage };
        result.finish_reason = event.delta?.stop_reason ?? "stop";
      }
      if (event.type === "message_stop") finished = true;
    }
    if (!finished) throw new ProviderFailure(502, true, "INCOMPLETE_RESPONSE");
    for (const block of blocks.values()) {
      if (block.type === "text") result.text += block.text ?? "";
      if (block.type === "tool_use") addCall(block.id, block.name, block.partial || block.input);
    }
    result.usage = normalizeUsage(usage, protocol);
    result.provider_state = stateFor(
      [...blocks.values()].map(({ partial, ...block }) =>
        block.type === "tool_use" && partial ? { ...block, input: JSON.parse(partial) } : block,
      ),
      "content",
    );
  } else if (protocol === "google_generate_content") {
    let finished = false;
    const parts: any[] = [];
    for (const event of data.events) {
      const candidate = event.candidates?.[0];
      if (candidate?.finishReason) {
        finished = true;
        result.finish_reason = candidate.finishReason;
      }
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (!part.thought && part.text) result.text += part.text;
        if (part.functionCall)
          addCall(
            part.functionCall.id ?? crypto.randomUUID(),
            part.functionCall.name,
            part.functionCall.args,
          );
      }
      if (event.usageMetadata) result.usage = normalizeUsage(event.usageMetadata, protocol);
    }
    if (!finished) throw new ProviderFailure(502, true, "INCOMPLETE_RESPONSE");
    result.provider_state = stateFor(parts, "parts");
  } else {
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finished = false;
    for (const raw of data.events) {
      const event = raw.result ?? raw;
      if (protocol === "cloudflare_run" && typeof event.response === "string") {
        result.text += event.response;
        finished = true;
      }
      const choice = event.choices?.[0],
        delta = choice?.delta ?? choice?.message;
      if (delta?.content) result.text += delta.content;
      if (choice?.finish_reason) {
        finished = true;
        result.finish_reason = choice.finish_reason;
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? calls.size,
          current = calls.get(index) ?? { id: "", name: "", args: "" };
        current.id ||= call.id ?? "";
        current.name += call.function?.name ?? "";
        current.args += call.function?.arguments ?? "";
        calls.set(index, current);
      }
      if (event.usage) result.usage = normalizeUsage(event.usage, protocol);
    }
    if (!finished) throw new ProviderFailure(502, true, "INCOMPLETE_RESPONSE");
    for (const call of calls.values())
      addCall(call.id || crypto.randomUUID(), call.name, call.args || "{}");
  }
  if (!data.streamed && result.text) await runtime.onDelta?.(result.text);
  return result;
}
