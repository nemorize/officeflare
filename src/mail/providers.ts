import { fail, type SubmissionSnapshot } from "./types";
export interface MailProvider {
  id: string;
  capabilities: {
    receive: boolean;
    send: boolean;
    max_send_bytes: number;
    max_recipients: number;
  };
  send(
    env: Env,
    snapshot: SubmissionSnapshot,
  ): Promise<{ provider_message_id: string }>;
}
const cloudflare: MailProvider = {
  id: "cloudflare",
  capabilities: {
    receive: true,
    send: true,
    max_send_bytes: 5 * 1024 * 1024,
    max_recipients: 50,
  },
  async send(env, snapshot) {
    const attachments: EmailAttachment[] = [];
    for (const file of snapshot.attachments) {
      const object = await env.MAIL_BUCKET.get(file.r2_key);
      if (!object)
        throw Object.assign(new Error("Attachment is unavailable"), {
          code: "LOCAL_ATTACHMENT_MISSING",
        });
      const content = new Uint8Array(await object.arrayBuffer());
      // Base64 also works with the local Cloudflare email simulator.
      let binary = "";
      for (let start = 0; start < content.length; start += 8192)
        binary += String.fromCharCode(...content.subarray(start, start + 8192));
      const common = {
        filename: file.filename,
        type: file.content_type,
        content: btoa(binary),
      };
      attachments.push(
        file.disposition === "inline" && file.content_id
          ? { ...common, disposition: "inline", contentId: file.content_id }
          : { ...common, disposition: "attachment" },
      );
    }
    const result = await env.EMAIL.send({
      from: snapshot.from,
      to: snapshot.to,
      cc: snapshot.cc,
      bcc: snapshot.bcc,
      subject: snapshot.subject,
      text: snapshot.text,
      html: snapshot.html,
      replyTo: snapshot.reply_to,
      headers: snapshot.headers,
      attachments,
    });
    if (!result?.messageId)
      throw Object.assign(new Error("Provider acceptance has no receipt"), {
        code: "missing_provider_receipt",
      });
    return { provider_message_id: result.messageId };
  },
};
export const providers = [cloudflare];
export function provider(name: string) {
  return (
    providers.find((p) => p.id === name) ??
    fail(422, "Unsupported provider: " + name)
  );
}
