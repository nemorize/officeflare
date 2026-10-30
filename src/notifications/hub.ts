import { t } from "../../shared/i18n/index.ts";
import { DurableObject } from "cloudflare:workers";
import type { AuthEnv } from "../auth/types";
import { connectionValid, type NotificationConnection } from "./session";

// This hub sends invalidations only. Notification content always comes from authenticated REST.
export class NotificationHubDO extends DurableObject<AuthEnv> {
  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const connection: NotificationConnection = {
      user_id: request.headers.get("x-notification-user") ?? "",
      session_id: request.headers.get("x-notification-session") ?? "",
      auth_version: Number(request.headers.get("x-notification-version")),
      expires_at: Math.floor(Date.now() / 1000) + 900,
    };
    if (!(await connectionValid(this.env.DB, connection)))
      return new Response(null, { status: 401 });
    if (this.ctx.getWebSockets().length >= 10) return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment(connection);
    this.ctx.acceptWebSocket(pair[1]);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": "officeflare.notifications" },
    });
  }

  async invalidate() {
    for (const socket of this.ctx.getWebSockets()) {
      if (!(await this.valid(socket))) continue;
      try {
        socket.send(JSON.stringify({ kind: "notifications.changed" }));
      } catch {
        socket.close(1011, t("notificationsHub.reconnect"));
      }
    }
  }
  private async valid(socket: WebSocket) {
    const connection = socket.deserializeAttachment() as NotificationConnection | null;
    if (connection && (await connectionValid(this.env.DB, connection))) return true;
    socket.close(4001, t("notificationsHub.sessionEnded"));
    return false;
  }
  async alarm() {
    for (const socket of this.ctx.getWebSockets()) await this.valid(socket);
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (!(await this.valid(socket))) return;
    if (message === "ping") socket.send("pong");
    else socket.close(1008, t("notificationsHub.unsupportedMessage"));
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, t("notificationsHub.reconnect"));
  }
}
