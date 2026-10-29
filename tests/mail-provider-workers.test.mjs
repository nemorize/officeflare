import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Resend sends in the Workers runtime and never follows credential-bearing redirects", async (t) => {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { provider } from './src/mail/providers.ts';
        import { seal } from './src/mail/secrets.ts';
        export default { async fetch(request, env) {
          const encrypted = await seal(env, JSON.stringify({apiKey: 'test-resend-key'}));
          const connection = {secret_ciphertext: encrypted.ciphertext, secret_nonce: encrypted.nonce};
          const snapshot = {from: 'sender@example.test', to: ['recipient@example.test'], cc: [], bcc: [],
            subject: 'Workers test', text: 'Hello', html: '<p>Hello</p>', headers: {}, attachments: []};
          try {
            return Response.json(await provider('resend').send(env, snapshot, connection, 'workers-submission'));
          } catch (error) { return Response.json({error: error.code ?? error.message}, {status: 502}); }
        }};
      `,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:sockets"],
  });
  const requests = [];
  let redirect = false;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "provider-test",
          modules: true,
          script: bundled.outputFiles[0].text,
          compatibilityDate: "2026-09-29",
          bindings: { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") },
          outboundService: async (request) => {
            requests.push({
              url: request.url,
              headers: new Headers(request.headers),
              body: await request.json(),
            });
            return redirect
              ? new Response(null, {
                  status: 307,
                  headers: { Location: "https://untrusted.example.test/emails" },
                })
              : Response.json({ id: "resend-workers-message" });
          },
        },
      ],
    }),
  );
  t.after(() => mf.dispose());

  const accepted = await mf.dispatchFetch("https://test.local");
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { provider_message_id: "resend-workers-message" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(requests[0].headers.get("authorization"), "Bearer test-resend-key");
  assert.equal(requests[0].headers.get("idempotency-key"), "workers-submission");
  assert.deepEqual(requests[0].body.to, ["recipient@example.test"]);

  redirect = true;
  const rejected = await mf.dispatchFetch("https://test.local");
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: "E_PROVIDER_REJECTED" });
  assert.equal(requests.length, 2, "redirect destination must never receive a request");
  assert.ok(requests.every((request) => request.url === "https://api.resend.com/emails"));
});
