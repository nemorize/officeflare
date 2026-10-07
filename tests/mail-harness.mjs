import handlers from "../dist/index.js";
import { WorkerEntrypoint } from "cloudflare:workers";
export class FakeEmail extends WorkerEntrypoint {
  async send(message) {
    const messageId = "<" + crypto.randomUUID() + "@cloudflare.test>";
    await this.env.MAIL_BUCKET.put(
      "test-sent/" + messageId + ".json",
      JSON.stringify(message),
    );
    const mode = await this.env.MAIL_BUCKET.get("test-mode.json");
    if (mode && (await mode.text()) === "unknown")
      throw new Error("Connection lost after acceptance");
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
