import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import {
  COLLABORATION_PROTOCOL,
  CollaborationFault,
  MAX_STATE_BYTES,
  decodeBytes,
  encodeBytes,
  type CollaborationCapabilities,
  type CollaborationParticipant,
} from "../../shared/collaboration";
import { actorAccount, digest, resourceFor } from "./access";
import type { CollaborationActor, CollaborationAdapters, CollaborationResource } from "./types";

interface Connection {
  actor?: CollaborationActor;
  participant?: CollaborationParticipant;
  capabilities?: CollaborationCapabilities;
  origin: string;
  deadline: number;
  lease_until: number;
  client_id?: number;
  awareness_clock?: number;
  presence?: Record<string, unknown> | null;
  window: number;
  count: number;
}
type StateRow = {
  epoch: number;
  seq: number;
  snapshot_seq: number;
  state: ArrayBuffer;
  projected_seq: number;
};
const colors = ["#4477aa", "#aa4477", "#228866", "#aa6622", "#7755aa", "#227788"];

/** Transport and durable CRDT state only. Business policies are injected by the worker entrypoint. */
export class CollaborationRoom extends DurableObject<Env> {
  private resource?: CollaborationResource;
  private doc?: Y.Doc;
  private state?: StateRow;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly adapters: CollaborationAdapters,
  ) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_state(id INTEGER PRIMARY KEY CHECK(id=1),resource_id TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,snapshot_seq INTEGER NOT NULL,state BLOB NOT NULL,projected_seq INTEGER NOT NULL DEFAULT -1)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_updates(seq INTEGER PRIMARY KEY,update_blob BLOB NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_receipts(epoch INTEGER NOT NULL,user_id TEXT NOT NULL,mutation_id TEXT NOT NULL,hash TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(epoch,user_id,mutation_id))`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_snapshots(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,state BLOB NOT NULL,created_at INTEGER NOT NULL,actor_user_id TEXT,kind TEXT NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_commands(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL)`,
    );
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => {});
    return next;
  }
  private async schedule(delay: number) {
    const due = Date.now() + delay,
      current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }
  private async load(resourceId?: string) {
    if (this.doc) {
      if (resourceId && this.resource?.id !== resourceId)
        throw new CollaborationFault("resource_mismatch");
      return;
    }
    const stored = this.ctx.storage.sql
      .exec<StateRow & { resource_id: string }>("SELECT * FROM room_state WHERE id=1")
      .toArray()[0];
    const resource = await resourceFor(
      this.env,
      stored?.resource_id ?? resourceId ?? "",
      this.adapters,
    );
    if (!resource || (resourceId && resource.id !== resourceId))
      throw new CollaborationFault("resource_missing");
    this.resource = resource;
    this.doc = stored ? new Y.Doc() : this.adapters[resource.service]!.initialize(resource);
    if (stored) {
      Y.applyUpdate(this.doc, new Uint8Array(stored.state));
      for (const update of this.ctx.storage.sql
        .exec<{ update_blob: ArrayBuffer }>("SELECT update_blob FROM room_updates ORDER BY seq")
        .toArray())
        Y.applyUpdate(this.doc, new Uint8Array(update.update_blob));
      this.state = stored;
    } else {
      const state = Y.encodeStateAsUpdate(this.doc);
      this.ctx.storage.sql.exec(
        "INSERT INTO room_state(id,resource_id,epoch,seq,snapshot_seq,state) VALUES(1,?,1,0,0,?)",
        resource.id,
        state,
      );
      this.state = {
        epoch: 1,
        seq: 0,
        snapshot_seq: 0,
        state: state.buffer as ArrayBuffer,
        projected_seq: -1,
      };
      this.snapshot(null, "initial");
    }
  }
  private connection(ws: WebSocket) {
    return ws.deserializeAttachment() as Connection;
  }
  private async allowed(ws: WebSocket, force = false) {
    const c = this.connection(ws);
    if (!c.actor) return false;
    if (!force && c.lease_until > Date.now()) return !!c.capabilities?.read;
    const checked = Date.now();
    try {
      const account = await actorAccount(this.env, c.actor);
      const capabilities = account
        ? await this.adapters[this.resource!.service]!.authorize(this.env, c.actor, this.resource!)
        : null;
      if (!capabilities?.read || checked + 4500 <= Date.now()) {
        ws.close(4003, "access_revoked");
        return false;
      }
      const changed = JSON.stringify(c.capabilities) !== JSON.stringify(capabilities);
      c.capabilities = capabilities;
      c.lease_until = checked + 4500;
      ws.serializeAttachment(c);
      if (changed) ws.send(JSON.stringify({ type: "capabilities", capabilities }));
      return true;
    } catch {
      ws.close(1011, "authorization_unavailable");
      return false;
    }
  }
  private async broadcast(value: unknown, exclude?: WebSocket) {
    const message = JSON.stringify(value);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude || !(await this.allowed(socket))) continue;
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "reconnect");
      }
    }
  }
  private snapshot(actor: string | null, kind: string) {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO room_snapshots(id,epoch,seq,state,created_at,actor_user_id,kind) VALUES(?,?,?,?,?,?,?)",
      id,
      this.state!.epoch,
      this.state!.seq,
      Y.encodeStateAsUpdate(this.doc!),
      Date.now(),
      actor,
      kind,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM room_snapshots WHERE id NOT IN(SELECT id FROM room_snapshots ORDER BY created_at DESC,id DESC LIMIT 50)",
    );
    return id;
  }
  async fetch(request: Request) {
    return this.enqueue(async () => {
      const url = new URL(request.url);
      await this.load(url.searchParams.get("resource") ?? undefined);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response(null, { status: 426 });
      if (this.ctx.getWebSockets().length >= 40) return new Response(null, { status: 429 });
      await this.schedule(5000);
      const pair = new WebSocketPair();
      pair[1].serializeAttachment({
        origin: request.headers.get("Origin") ?? "",
        deadline: Date.now() + 10000,
        lease_until: 0,
        window: Date.now(),
        count: 0,
      } satisfies Connection);
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": COLLABORATION_PROTOCOL },
      });
    });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.enqueue(async () => {
      try {
        await this.load();
        if (typeof raw !== "string" || raw.length > 2100000)
          throw new CollaborationFault("message_too_large");
        const message = JSON.parse(raw) as Record<string, unknown>;
        let c = this.connection(ws);
        if (Date.now() - c.window > 1000) {
          c.window = Date.now();
          c.count = 0;
        }
        if (++c.count > 40) throw new CollaborationFault("rate_limited");
        ws.serializeAttachment(c);
        if (!c.actor) {
          if (
            message.type !== "auth" ||
            c.deadline < Date.now() ||
            typeof message.ticket !== "string" ||
            message.ticket.length > 200
          )
            throw new CollaborationFault("authentication_required");
          const ticket = await this.env.DB.withSession("first-primary")
            .prepare(
              `UPDATE collaboration_tickets SET consumed_at=unixepoch() WHERE token_hash=? AND resource_id=? AND origin=? AND consumed_at IS NULL AND expires_at>unixepoch() RETURNING user_id,session_id,auth_version`,
            )
            .bind(await digest(message.ticket), this.resource!.id, c.origin)
            .first<CollaborationActor>();
          if (!ticket) throw new CollaborationFault("authentication_required");
          const account = await actorAccount(this.env, ticket);
          if (!account) throw new CollaborationFault("access_revoked");
          c.actor = ticket;
          c.participant = {
            connection_id: crypto.randomUUID(),
            user_id: account.id,
            name: account.display_name ?? account.email_address,
            color:
              colors[
                Array.from(account.id).reduce((a, v) => a + v.charCodeAt(0), 0) % colors.length
              ]!,
          };
          ws.serializeAttachment(c);
          if (!(await this.allowed(ws, true))) return;
          c = this.connection(ws);
          ws.send(
            JSON.stringify({
              type: "ready",
              epoch: this.state!.epoch,
              seq: this.state!.seq,
              schema_key: this.resource!.schema_key,
              capabilities: c.capabilities,
              user: c.participant,
              state: encodeBytes(Y.encodeStateAsUpdate(this.doc!)),
            }),
          );
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws || !(await this.allowed(other))) continue;
            const member = this.connection(other);
            if (member.client_id !== undefined)
              ws.send(
                JSON.stringify({
                  type: "awareness",
                  client_id: member.client_id,
                  clock: member.awareness_clock ?? 0,
                  state: member.presence ?? null,
                }),
              );
          }
          await this.participants();
          return;
        }
        if (!(await this.allowed(ws))) return;
        c = this.connection(ws);
        if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (message.type === "awareness") {
          if (
            !Number.isSafeInteger(message.client_id) ||
            Number(message.client_id) < 0 ||
            Number(message.client_id) > 0xffffffff ||
            !Number.isSafeInteger(message.clock) ||
            Number(message.clock) < 0
          )
            throw new CollaborationFault("invalid_presence");
          if (c.client_id !== undefined && c.client_id !== message.client_id)
            throw new CollaborationFault("invalid_presence");
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const previous = this.connection(other);
            if (previous.client_id !== message.client_id) continue;
            if (previous.actor?.user_id !== c.actor?.user_id)
              throw new CollaborationFault("duplicate_client");
            // A reconnect can arrive before the old TCP/WebSocket close completes.
            delete previous.client_id;
            previous.presence = null;
            previous.lease_until = 0;
            delete previous.actor;
            other.serializeAttachment(previous);
            other.close(4000, "superseded");
          }
          if (JSON.stringify(message.state).length > 4096)
            throw new CollaborationFault("invalid_presence");
          if (c.awareness_clock !== undefined && Number(message.clock) <= c.awareness_clock) return;
          const incoming =
            message.state && typeof message.state === "object"
              ? (message.state as Record<string, unknown>)
              : null;
          c.client_id = Number(message.client_id);
          c.awareness_clock = Number(message.clock);
          c.presence = incoming
            ? {
                cursor: incoming.cursor ?? null,
                user: { name: c.participant!.name, color: c.participant!.color },
              }
            : null;
          ws.serializeAttachment(c);
          await this.broadcast(
            {
              type: "awareness",
              client_id: c.client_id,
              clock: c.awareness_clock,
              state: c.presence,
            },
            ws,
          );
          return;
        }
        if (message.type !== "update") throw new CollaborationFault("unsupported_message");
        if (!c.capabilities?.write) throw new CollaborationFault("read_only");
        if (message.epoch !== this.state!.epoch) {
          ws.send(JSON.stringify({ type: "reset", epoch: this.state!.epoch }));
          ws.close(4009, "reset_required");
          return;
        }
        if (typeof message.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(message.id))
          throw new CollaborationFault("invalid_update");
        const update = decodeBytes(message.update),
          hash = await digest(update);
        const receipt = this.ctx.storage.sql
          .exec<{ hash: string; seq: number }>(
            "SELECT hash,seq FROM room_receipts WHERE epoch=? AND user_id=? AND mutation_id=?",
            this.state!.epoch,
            c.actor!.user_id,
            message.id,
          )
          .toArray()[0];
        if (receipt) {
          if (receipt.hash !== hash) throw new CollaborationFault("mutation_conflict");
          ws.send(
            JSON.stringify({
              type: "ack",
              id: message.id,
              epoch: this.state!.epoch,
              seq: receipt.seq,
            }),
          );
          return;
        }
        const candidate = new Y.Doc();
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.doc!));
          Y.applyUpdate(candidate, update);
          // Unresolved dependencies are bounded by the encoded-state limit as well as the wire limit.
          if (candidate.store.pendingStructs || candidate.store.pendingDs)
            throw new CollaborationFault("resync_required");
          this.adapters[this.resource!.service]!.validate(candidate, this.resource!);
          const full = Y.encodeStateAsUpdate(candidate);
          if (full.length > MAX_STATE_BYTES) throw new CollaborationFault("state_too_large");
          await this.schedule(2000);
          if (!(await this.allowed(ws))) return;
          if (!this.connection(ws).capabilities?.write) throw new CollaborationFault("read_only");
          const seq = this.state!.seq + 1;
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              "INSERT INTO room_updates(seq,update_blob) VALUES(?,?)",
              seq,
              update,
            );
            this.ctx.storage.sql.exec(
              "INSERT INTO room_receipts(epoch,user_id,mutation_id,hash,seq) VALUES(?,?,?,?,?)",
              this.state!.epoch,
              c.actor!.user_id,
              message.id,
              hash,
              seq,
            );
            this.ctx.storage.sql.exec("UPDATE room_state SET seq=? WHERE id=1", seq);
            if (seq - this.state!.snapshot_seq >= 50) {
              this.ctx.storage.sql.exec(
                "UPDATE room_state SET state=?,snapshot_seq=? WHERE id=1",
                full,
                seq,
              );
              this.ctx.storage.sql.exec("DELETE FROM room_updates WHERE seq<=?", seq);
              this.ctx.storage.sql.exec(
                "DELETE FROM room_receipts WHERE epoch<>? OR seq<?",
                this.state!.epoch,
                seq - 1000,
              );
            }
          });
          await this.ctx.storage.sync();
          if (seq - this.state!.snapshot_seq >= 50) this.state!.snapshot_seq = seq;
          this.state!.seq = seq;
          Y.applyUpdate(this.doc!, update);
          ws.send(JSON.stringify({ type: "ack", id: message.id, epoch: this.state!.epoch, seq }));
          await this.broadcast(
            { type: "update", epoch: this.state!.epoch, seq, update: encodeBytes(update) },
            ws,
          );
        } finally {
          candidate.destroy();
        }
      } catch (error) {
        // Rebuild from durable state after a failed write or partially delivered ACK.
        this.doc?.destroy();
        this.doc = undefined;
        this.state = undefined;
        const code = error instanceof Error ? error.message : "invalid_message";
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              code: [
                "read_only",
                "state_too_large",
                "reset_required",
                "resync_required",
                "mutation_conflict",
                "rate_limited",
              ].includes(code)
                ? code
                : "invalid_message",
            }),
          );
        } catch {}
        ws.close(4008, "reconnect_required");
      }
    });
  }
  private async participants() {
    const members: CollaborationParticipant[] = [];
    for (const ws of this.ctx.getWebSockets())
      if (await this.allowed(ws)) members.push(this.connection(ws).participant!);
    await this.broadcast({ type: "participants", participants: members });
  }
  async webSocketClose(ws: WebSocket) {
    await this.enqueue(async () => {
      if (
        !this.doc &&
        !this.ctx.storage.sql.exec("SELECT 1 FROM room_state WHERE id=1").toArray().length
      )
        return;
      await this.load();
      const c = this.connection(ws);
      if (c.client_id !== undefined)
        await this.broadcast(
          {
            type: "awareness",
            client_id: c.client_id,
            clock: (c.awareness_clock ?? 0) + 1,
            state: null,
          },
          ws,
        );
      await this.participants();
    });
  }
  async webSocketError(ws: WebSocket) {
    ws.close(1011, "reconnect");
  }
  async alarm() {
    await this.enqueue(async () => {
      if (
        !this.doc &&
        !this.ctx.storage.sql.exec("SELECT 1 FROM room_state WHERE id=1").toArray().length
      )
        return;
      await this.load();
      // Pre-arm recovery before external I/O; a failed projection stays dirty in SQLite.
      await this.schedule(5000);
      for (const ws of this.ctx.getWebSockets()) {
        const c = this.connection(ws);
        if (!c.actor) {
          if (c.deadline < Date.now()) ws.close(4001, "authentication_required");
        } else await this.allowed(ws, true);
      }
      if (this.state!.projected_seq !== this.state!.seq) {
        await this.adapters[this.resource!.service]!.project(this.env, this.resource!, {
          epoch: this.state!.epoch,
          seq: this.state!.seq,
          state: this.doc!,
        });
        this.ctx.storage.sql.exec(
          "UPDATE room_state SET projected_seq=? WHERE id=1",
          this.state!.seq,
        );
        this.state!.projected_seq = this.state!.seq;
      }
      const latest = this.ctx.storage.sql
        .exec<{ created_at: number; epoch: number; seq: number }>(
          "SELECT created_at,epoch,seq FROM room_snapshots ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .toArray()[0];
      if (
        (!latest || latest.epoch !== this.state!.epoch || latest.seq !== this.state!.seq) &&
        (!latest || Date.now() - latest.created_at > 300000 || !this.ctx.getWebSockets().length)
      )
        this.snapshot(null, "automatic");
      if (!this.ctx.getWebSockets().length) await this.ctx.storage.deleteAlarm();
    });
  }
  /** Internal RPC, reachable only through the bound namespace. Retirement is a durable tombstone. */
  async purge(resourceId: string) {
    return this.enqueue(async () => {
      const retired = await this.env.DB.withSession("first-primary")
        .prepare("SELECT 1 FROM collaboration_resources WHERE id=? AND retired_at IS NOT NULL")
        .bind(resourceId)
        .first();
      if (!retired) return false;
      const stored = this.ctx.storage.sql
        .exec<{ resource_id: string }>("SELECT resource_id FROM room_state WHERE id=1")
        .toArray()[0];
      if (
        (stored && stored.resource_id !== resourceId) ||
        (this.resource && this.resource.id !== resourceId)
      )
        return false;
      for (const socket of this.ctx.getWebSockets()) socket.close(4003, "access_revoked");
      this.ctx.storage.transactionSync(() => {
        for (const table of [
          "room_state",
          "room_updates",
          "room_receipts",
          "room_snapshots",
          "room_commands",
        ])
          this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      });
      await this.ctx.storage.sync();
      await this.ctx.storage.deleteAlarm();
      this.doc?.destroy();
      this.doc = undefined;
      this.state = undefined;
      await this.env.DB.prepare(
        "UPDATE collaboration_resources SET purged_at=unixepoch() WHERE id=? AND retired_at IS NOT NULL",
      )
        .bind(resourceId)
        .run();
      return true;
    });
  }
  async inspect(
    resourceId: string,
    actor: CollaborationActor,
    action: "content" | "history" | "checkpoint" | "restore",
    input?: { snapshot_id?: string; epoch?: number; operation_id?: string },
  ) {
    return this.enqueue(async () => {
      await this.load(resourceId);
      const account = await actorAccount(this.env, actor);
      const cap = account
        ? await this.adapters[this.resource!.service]!.authorize(this.env, actor, this.resource!)
        : null;
      if (!cap?.read) return { status: 404 as const };
      if (
        action !== "content" &&
        (!cap.history ||
          (action === "restore" && !cap.restore) ||
          (action === "checkpoint" && !cap.write))
      )
        return { status: 403 as const };
      if (action === "content")
        return {
          status: 200 as const,
          epoch: this.state!.epoch,
          seq: this.state!.seq,
          state: encodeBytes(Y.encodeStateAsUpdate(this.doc!)),
        };
      if (action === "history")
        return {
          status: 200 as const,
          revisions: this.ctx.storage.sql
            .exec(
              "SELECT id,epoch,seq,created_at,actor_user_id,kind FROM room_snapshots ORDER BY created_at DESC,id DESC",
            )
            .toArray(),
        };
      if (action === "checkpoint") {
        const id = this.snapshot(actor.user_id, "manual");
        await this.ctx.storage.sync();
        return { status: 200 as const, id };
      }
      const existing = input?.operation_id
        ? this.ctx.storage.sql
            .exec<{ epoch: number }>(
              "SELECT epoch FROM room_commands WHERE id=?",
              input.operation_id,
            )
            .toArray()[0]
        : undefined;
      if (existing) return { status: 200 as const, epoch: existing.epoch };
      if (input?.epoch !== this.state!.epoch) return { status: 412 as const };
      const snapshot = this.ctx.storage.sql
        .exec<{ state: ArrayBuffer }>(
          "SELECT state FROM room_snapshots WHERE id=?",
          input.snapshot_id ?? "",
        )
        .toArray()[0];
      if (!snapshot) return { status: 404 as const };
      const restored = new Y.Doc();
      Y.applyUpdate(restored, new Uint8Array(snapshot.state));
      this.adapters[this.resource!.service]!.validate(restored, this.resource!);
      await this.schedule(1000);
      const epoch = this.state!.epoch + 1;
      this.ctx.storage.transactionSync(() => {
        this.snapshot(actor.user_id, "before_restore");
        this.ctx.storage.sql.exec(
          "UPDATE room_state SET epoch=?,seq=0,snapshot_seq=0,state=?,projected_seq=-1 WHERE id=1",
          epoch,
          Y.encodeStateAsUpdate(restored),
        );
        this.ctx.storage.sql.exec("DELETE FROM room_updates");
        this.ctx.storage.sql.exec("DELETE FROM room_receipts");
        this.ctx.storage.sql.exec("DELETE FROM room_commands WHERE epoch<?", epoch - 1000);
        if (input?.operation_id)
          this.ctx.storage.sql.exec(
            "INSERT INTO room_commands(id,epoch) VALUES(?,?)",
            input.operation_id,
            epoch,
          );
      });
      await this.ctx.storage.sync();
      this.doc!.destroy();
      this.doc = restored;
      this.state!.epoch = epoch;
      this.state!.seq = 0;
      this.state!.snapshot_seq = 0;
      this.state!.projected_seq = -1;
      await this.broadcast({ type: "reset", epoch });
      for (const ws of this.ctx.getWebSockets()) ws.close(4009, "reset_required");
      return { status: 200 as const, epoch };
    });
  }
}
