import worker from "../dist/index.js";
export {
  NotificationHubDO,
  MailboxDO,
  MailPartitionDO,
  CollaborationRoomDO,
} from "../dist/index.js";
import { AIService } from "../src/ai/service";
import { registerAIConsumer } from "../src/ai/consumers";
import { advanceRun, recoverRuns } from "../src/ai/hub";
import { recoverInvocations } from "../src/ai/service";
import { executeOperation } from "../src/mcp/operations";
import type { AuthEnv } from "../src/auth/types";
import type { AIRequest, Fetcher } from "../src/ai/types";
import { seal, unseal } from "../src/ai/secrets";
import { reserve, settle } from "../src/ai/quota";
import { remoteTools, type MCPConnection } from "../src/mcp/client";
import { first } from "../src/ai/store";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { oauthCallback } from "../src/ai/oauth";
import { accountCredentials } from "../src/ai/credentials";
import type { Account, Provider } from "../src/ai/types";

registerAIConsumer("fixture.classify", { principals: ["service"], billing: "service" });
export default {
  async fetch(request: Request, env: AuthEnv, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    const fetcher: Fetcher = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/"))
        return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
      if (url.startsWith("https://issuer.example/")) {
        const oauth = JSON.parse(await (await env.MAIL_BUCKET.get("ai-fixture-oauth"))!.text());
        if (url.endsWith("/jwks")) return Response.json(oauth.jwks);
        const form = new URLSearchParams(String(init?.body));
        await env.MAIL_BUCKET.put(
          "ai-oauth-requests/" + crypto.randomUUID(),
          form.get("grant_type") ?? "",
        );
        if (form.get("grant_type") === "refresh_token") {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return Response.json({
            access_token: "fixture-refreshed",
            refresh_token: "fixture-refresh-rotated",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        return Response.json(oauth.tokens);
      }
      const mode = JSON.parse(
        (await (await env.MAIL_BUCKET.get("ai-fixture-mode"))?.text()) ?? "{}",
      );
      const headers = new Headers(init?.headers),
        body = JSON.parse(String(init?.body ?? "{}"));
      await env.MAIL_BUCKET.put(
        "ai-requests/" + crypto.randomUUID(),
        JSON.stringify({
          url,
          body,
          fixture_authorized: headers.get("authorization") === "Bearer fixture-provider-key",
          gateway_authorized: headers.get("cf-aig-authorization") === "Bearer fixture-gateway-key",
        }),
      );
      if (mode.kind === "unknown") throw new Error("Connection lost after provider acceptance");
      if (headers.get("authorization") === "Bearer fixture-rejected-key")
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      if (mode.kind === "delay") await new Promise((resolve) => setTimeout(resolve, 150));
      if (url.includes("remote-mcp")) {
        if (body.method === "initialize")
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
            },
            { headers: { "mcp-session-id": "fixture-session" } },
          );
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "lookup",
                description: "Lookup",
                inputSchema: {
                  type: "object",
                  properties: { q: { type: "string" } },
                  required: ["q"],
                  additionalProperties: false,
                },
              },
            ],
          },
        });
      }
      if (url.includes("/run/"))
        return Response.json({
          success: true,
          result: { response: "Hello", usage: { prompt_tokens: 7, completion_tokens: 3 } },
        });
      if (
        mode.kind === "signed-tools" &&
        url.includes(":streamGenerateContent") &&
        !body.contents?.some((message: any) =>
          message.parts?.some((part: any) => part.functionResponse),
        )
      )
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "native-call",
                      name: body.tools[0].functionDeclarations[0].name,
                      args: {},
                    },
                    thoughtSignature: "fixture-encrypted-signature",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
        });
      if (
        mode.kind === "signed-tools" &&
        url.endsWith("/messages") &&
        !body.messages?.some((message: any) =>
          message.content?.some((part: any) => part.type === "tool_result"),
        )
      )
        return Response.json({
          id: "fixture",
          content: [
            { type: "thinking", thinking: "", signature: "fixture-encrypted-signature" },
            { type: "tool_use", id: "native-call", name: body.tools[0].name, input: {} },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 7, output_tokens: 3 },
        });
      if (url.includes(":streamGenerateContent"))
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 0 },
        });
      if (url.endsWith("/messages"))
        return Response.json({
          id: "fixture",
          type: "message",
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 3 },
        });
      if (url.endsWith("/chat/completions"))
        return new Response(
          'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      const tools = body.tools?.[0]?.type === "namespace" ? body.tools[0].tools : body.tools;
      const toolCall =
        mode.kind === "tools" &&
        !body.input?.some((item: any) => item.type === "function_call_output") &&
        tools?.length;
      const output = toolCall
        ? [
            {
              type: "function_call",
              id: "fc_fixture",
              call_id: "fixture-call",
              name: tools[0].name,
              arguments: JSON.stringify({ data: { display_name: "Agent contact" } }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello" }],
            },
          ];
      return Response.json(
        {
          id: "fixture-response",
          status: "completed",
          output,
          usage: { input_tokens: 7, output_tokens: 3 },
        },
        { headers: { "x-request-id": "fixture-request" } },
      );
    };
    if (pathname === "/api/ai/oauth/callback") {
      const app = new Hono<{ Bindings: AuthEnv }>();
      app.get(pathname, oauthCallback(fetcher) as never);
      return app.fetch(request, env, ctx);
    }
    if (pathname.startsWith("/test-ai/")) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        if (pathname === "/test-ai/infer")
          return Response.json(
            await new AIService(env, { fetcher }).execute(body as unknown as AIRequest),
          );
        if (pathname === "/test-ai/credentials") {
          const account = (await first<Account>(
            env,
            "SELECT * FROM ai_provider_accounts WHERE id=?",
            String(body.id),
          ))!;
          const provider = (await first<Provider>(
            env,
            "SELECT * FROM ai_providers WHERE id=?",
            account.provider_id,
          ))!;
          const result = await accountCredentials(env, account, provider, fetcher);
          return Response.json({
            version: result.version,
            access_token: result.credentials.access_token,
          });
        }
        if (pathname === "/test-ai/advance") {
          await advanceRun(env, String(body.id), { fetcher });
          return Response.json({ done: true });
        }
        if (pathname === "/test-ai/operation") {
          await executeOperation(env, String(body.id));
          return Response.json({ done: true });
        }
        if (pathname === "/test-ai/recover") {
          await recoverInvocations(env);
          await recoverRuns(env);
          return Response.json({ done: true });
        }
        if (pathname === "/test-ai/reserve")
          return Response.json(await reserve(env, body as never));
        if (pathname === "/test-ai/settle") {
          await settle(env, String(body.id), body.amounts as never);
          return Response.json({ done: true });
        }
        if (pathname === "/test-ai/remote")
          return Response.json({
            tools: await remoteTools(
              env,
              (await first<MCPConnection>(
                env,
                "SELECT * FROM ai_mcp_connections WHERE id=?",
                String(body.id),
              ))!,
              fetcher,
            ),
          });
        if (pathname === "/test-ai/seal")
          return Response.json({ envelope: await seal(env, String(body.purpose), body.value) });
        if (pathname === "/test-ai/unseal")
          return Response.json({
            value: await unseal(env, String(body.purpose), String(body.envelope)),
          });
        return new Response(null, { status: 404 });
      } catch (error) {
        return error instanceof HTTPException
          ? error.getResponse()
          : Response.json({ error: String(error) }, { status: 500 });
      }
    }
    return worker.fetch(request, env, ctx);
  },
};
