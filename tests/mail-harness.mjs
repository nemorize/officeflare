import handlers from "../dist/index.js";
import { WorkerEntrypoint } from "cloudflare:workers";
export class FakeEmail extends WorkerEntrypoint {
  async send(message) {
    const messageId = "<" + crypto.randomUUID() + "@cloudflare.test>";
    await this.env.MAIL_BUCKET.put("test-sent/" + messageId + ".json", JSON.stringify(message));
    let mode = await (await this.env.MAIL_BUCKET.get("test-mode.json"))?.text();
    for (let attempt = 0; mode === "hold" && attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      mode = await (await this.env.MAIL_BUCKET.get("test-mode.json"))?.text();
    }
    if (mode === "hold") throw new Error("Test send timed out");
    if (mode === "unknown") throw new Error("Connection lost after acceptance");
    return { messageId };
  }
}
export default {
  async fetch(request, env, ctx) {
    let rejected = null,
      forwarded = null;
    const headers = new Headers(request.headers);
    await handlers.email(
      {
        from: headers.get("x-sender") ?? "sender@example.test",
        to: headers.get("x-recipient") ?? "owner@mail.test",
        raw: request.body,
        rawSize: Number(headers.get("content-length") ?? 0),
        headers,
        setReject(reason) {
          rejected = reason;
        },
        async forward(destination) {
          forwarded = destination;
        },
      },
      env,
      ctx,
    );
    return Response.json(forwarded ? { rejected, forwarded } : { rejected });
  },
};
