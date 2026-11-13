import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import {
  COLLABORATION_PROTOCOL,
  decodeBytes,
  encodeBytes,
  MAX_STATE_BYTES,
  type CollaborationCapabilities,
  type CollaborationParticipant,
  type CollaborationStatus,
} from "../../../shared/collaboration";

export interface CollaborationTransport {
  session(resourceId: string): Promise<{ ticket: string }>;
  socketUrl(resourceId: string): string;
}
/** No wiki, Drive, React, or editor dependencies. A service supplies only its transport. */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  status: CollaborationStatus = "connecting";
  capabilities: CollaborationCapabilities = {
    read: false,
    write: false,
    history: false,
    restore: false,
  };
  participants: CollaborationParticipant[] = [];
  user: CollaborationParticipant | null = null;
  synced = false;
  epoch = 0;
  seq = 0;
  private socket?: WebSocket;
  private closed = false;
  private connected = false;
  private pending: Uint8Array[] = [];
  private flight = new Map<string, Uint8Array>();
  private listeners = new Set<() => void>();
  private retry?: ReturnType<typeof setTimeout>;
  private debounce?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private backoff = 500;
  private lastMessage = 0;
  constructor(
    readonly resourceId: string,
    private readonly transport: CollaborationTransport,
  ) {
    this.doc.on("update", this.changed);
    this.awareness.on("update", this.presence);
  }
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private setStatus(status: CollaborationStatus) {
    this.status = status;
    this.emit();
  }
  get unsaved() {
    return this.pending.length > 0 || this.flight.size > 0;
  }
  private changed = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.closed) return;
    this.pending.push(update);
    this.setStatus(this.connected ? "saving" : "offline");
    if (!this.debounce)
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        this.flush();
      }, 150);
  };
  private presence = (_changes: unknown, origin: unknown) => {
    if (origin === this || !this.connected || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      if (this.connected && this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(
          JSON.stringify({
            type: "awareness",
            client_id: this.doc.clientID,
            clock: this.awareness.meta.get(this.doc.clientID)?.clock ?? 0,
            state: this.awareness.getLocalState(),
          }),
        );
    }, 100);
  };
  private flush() {
    if (
      !this.connected ||
      !this.capabilities.write ||
      !this.pending.length ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    const update = Y.mergeUpdates(this.pending),
      id = crypto.randomUUID();
    this.pending = [];
    this.flight.set(id, update);
    this.socket.send(
      JSON.stringify({ type: "update", epoch: this.epoch, id, update: encodeBytes(update) }),
    );
    this.setStatus("saving");
  }
  async connect() {
    if (this.closed) return;
    this.setStatus(this.synced ? "offline" : "connecting");
    try {
      const { ticket } = await this.transport.session(this.resourceId);
      if (this.closed) return;
      const ws = new WebSocket(this.transport.socketUrl(this.resourceId), COLLABORATION_PROTOCOL);
      this.socket = ws;
      clearTimeout(this.handshake);
      this.handshake = setTimeout(() => {
        this.disconnected(ws, 1006);
        ws.close();
      }, 10000);
      ws.onopen = () => {
        if (this.closed || ws !== this.socket) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "auth", ticket }));
      };
      ws.onmessage = (event) => {
        if (this.closed || ws !== this.socket) return;
        this.lastMessage = Date.now();
        try {
          this.message(JSON.parse(String(event.data)));
        } catch {
          this.setStatus("error");
          ws.close(4008, "invalid_message");
        }
      };
      ws.onerror = () => {
        this.disconnected(ws, 1006);
        ws.close();
      };
      ws.onclose = (event) => this.disconnected(ws, event.code);
    } catch (error) {
      if (this.closed) return;
      const status = (error as { status?: number })?.status;
      if (status === 403 || status === 404 || status === 401) {
        this.capabilities.write = false;
        this.setStatus("revoked");
      } else {
        this.setStatus("offline");
        this.schedule();
      }
    }
  }
  private disconnected(ws: WebSocket, code: number) {
    if (ws !== this.socket || this.closed) return;
    this.socket = undefined;
    this.connected = false;
    clearTimeout(this.handshake);
    if (this.heartbeat) clearInterval(this.heartbeat);
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter((v) => v !== this.doc.clientID),
      this,
    );
    if (code === 4003 || code === 4001) {
      this.capabilities = { ...this.capabilities, write: false, read: false };
      this.setStatus("revoked");
      return;
    }
    if (code === 4009 || this.status === "reset") {
      this.capabilities.write = false;
      this.setStatus("reset");
      return;
    }
    if (code === 4008 || this.status === "error") {
      this.capabilities.write = false;
      this.setStatus("error");
      return;
    }
    this.setStatus("offline");
    this.schedule();
  }
  private schedule() {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(10000, this.backoff * 2);
  }
  private message(message: Record<string, any>) {
    if (message.type === "ready") {
      clearTimeout(this.handshake);
      if (this.epoch && message.epoch !== this.epoch) {
        this.setStatus("reset");
        this.socket?.close(4009, "reset_required");
        return;
      }
      const server = decodeBytes(message.state, MAX_STATE_BYTES),
        dirty = this.unsaved;
      this.epoch = message.epoch;
      this.seq = message.seq;
      this.capabilities = message.capabilities;
      this.user = message.user;
      Y.applyUpdate(this.doc, server, this);
      this.pending = [];
      this.flight.clear();
      this.connected = true;
      this.synced = true;
      this.backoff = 500;
      if (dirty)
        this.pending.push(Y.encodeStateAsUpdate(this.doc, Y.encodeStateVectorFromUpdate(server)));
      this.awareness.setLocalStateField("user", { name: this.user?.name, color: this.user?.color });
      this.presence(null, null);
      this.setStatus(this.capabilities.write ? (this.unsaved ? "saving" : "saved") : "readonly");
      this.flush();
      this.lastMessage = Date.now();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        const socket = this.socket;
        if (
          socket &&
          (socket.readyState !== WebSocket.OPEN || Date.now() - this.lastMessage > 15000)
        ) {
          this.disconnected(socket, 1006);
          socket.close();
          return;
        }
        if (this.socket?.readyState === WebSocket.OPEN)
          this.socket.send(JSON.stringify({ type: "ping" }));
      }, 5000);
    } else if (message.type === "update") {
      if (message.epoch !== this.epoch) {
        this.setStatus("reset");
        return;
      }
      Y.applyUpdate(this.doc, decodeBytes(message.update, MAX_STATE_BYTES), this);
      this.seq = message.seq;
      this.emit();
    } else if (message.type === "ack") {
      if (message.epoch !== this.epoch) return;
      this.flight.delete(message.id);
      this.seq = Math.max(this.seq, message.seq);
      this.setStatus(this.capabilities.write ? (this.unsaved ? "saving" : "saved") : "readonly");
    } else if (message.type === "awareness") {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint(enc, message.client_id);
      encoding.writeVarUint(enc, message.clock);
      encoding.writeVarString(enc, JSON.stringify(message.state));
      applyAwarenessUpdate(this.awareness, encoding.toUint8Array(enc), this);
    } else if (message.type === "participants") {
      this.participants = message.participants;
      this.emit();
    } else if (message.type === "capabilities") {
      this.capabilities = message.capabilities;
      this.setStatus(this.capabilities.write ? (this.unsaved ? "saving" : "saved") : "readonly");
    } else if (message.type === "reset") {
      this.capabilities.write = false;
      this.setStatus("reset");
    } else if (message.type === "error") {
      this.capabilities.write = false;
      this.setStatus("error");
    }
  }
  destroy() {
    this.closed = true;
    clearTimeout(this.handshake);
    clearTimeout(this.retry);
    clearTimeout(this.debounce);
    clearTimeout(this.presenceTimer);
    clearInterval(this.heartbeat);
    this.socket?.close(1000, "closed");
    this.awareness.destroy();
    this.doc.off("update", this.changed);
    this.doc.destroy();
    this.listeners.clear();
  }
}
