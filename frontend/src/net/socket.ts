// Typed WebSocket client wrapper. Auto-reconnects and, on each (re)connect,
// replays a reconnect message (room code + token) so a refresh rejoins the room.
// Copied wholesale from round-trip-chess/frontend/src/net/socket.ts.

import type { ClientMsg, ServerMsg } from "@shared/protocol";

export type Status = "connecting" | "open" | "closed";

interface NetOpts {
  onMessage: (m: ServerMsg) => void;
  onStatus: (s: Status) => void;
  getReconnect: () => ClientMsg | null;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export class Net {
  private ws: WebSocket | null = null;
  private queue: ClientMsg[] = [];
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: NetOpts) {}

  connect(): void {
    this.opts.onStatus("connecting");
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // event from a superseded socket
      this.opts.onStatus("open");
      const rc = this.opts.getReconnect();
      if (rc) this.raw(rc);
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) this.raw(m);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return; // event from a superseded socket
      if (typeof e.data !== "string") return;
      try {
        this.opts.onMessage(JSON.parse(e.data) as ServerMsg);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded socket closing, ignore
      this.ws = null;
      // Intentional teardown (e.g. StrictMode cleanup): do NOT flip the UI to
      // "disconnected", and do not reconnect.
      if (this.closedByUs) return;
      this.opts.onStatus("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.raw(m);
    else this.queue.push(m);
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private raw(m: ClientMsg): void {
    this.ws?.send(JSON.stringify(m));
  }
}
