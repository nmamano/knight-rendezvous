// WebSocket connection handling: parse/validate/dispatch ClientMsg, manage each
// socket's binding to a room slot. All game state + broadcasting lives in Room.
//
// Adapted from round-trip-chess/server/socket.ts. Message set: create / join /
// reconnect / leave / move (NOT turn-based — a move is always for the sender's
// own knight, inferred from the bound slot). Boundary validation here is the
// first line of defense: it rejects structurally malformed payloads (e.g. a
// non-string room code or a non-{r,c} move cell) before they reach the store;
// game-rule legality is decided in Game.move, not here.

import { createBunWebSocket } from "hono/bun";
import type { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { type Connection, type Room, RoomStore } from "./rooms";
import type { ClientMsg, PlayerId } from "../shared/protocol";
import type { Cell } from "../shared/engine";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

// Thin ENVELOPE validation for a `move` payload's `cell`: it must be an object
// with integer r and c. This is structural only — out-of-range / blocked /
// illegal is a GAME rule that Game.move handles (it bounds-checks BEFORE indexing
// `available`, so bad indices never throw, they return illegal_move).
function parseCell(m: unknown): Cell | null {
  if (typeof m !== "object" || m === null) return null;
  const cell = (m as Record<string, unknown>).cell;
  if (typeof cell !== "object" || cell === null) return null;
  const r = (cell as Record<string, unknown>).r;
  const c = (cell as Record<string, unknown>).c;
  if (!isInt(r) || !isInt(c)) return null;
  return { r, c };
}

function makeConn(ws: WSContext): Connection {
  return {
    send(msg) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // socket already gone; nothing to do
      }
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

export function registerSocket(app: Hono, store: RoomStore) {
  app.get(
    "/ws",
    upgradeWebSocket(() => {
      let conn: Connection | null = null;
      let bound: { room: Room; pid: PlayerId } | null = null;

      // If our room was reaped, drop the stale binding so create/join works again.
      const active = (): { room: Room; pid: PlayerId } | null => {
        if (bound && !store.has(bound.room.code)) bound = null;
        return bound;
      };

      const dispatch = (msg: ClientMsg) => {
        if (!conn) return;
        switch (msg.t) {
          case "create": {
            if (active()) return;
            const room = store.createRoom();
            const { pid, token } = room.addCreator(msg.name, conn);
            bound = { room, pid };
            conn.send({
              t: "joined",
              code: room.code,
              you: pid,
              token,
              state: room.snapshot(),
            });
            return;
          }
          case "join": {
            if (active()) return;
            // Envelope validation: `code` feeds RoomStore.get (.toUpperCase), so a
            // non-string would throw. Reject malformed payloads, never crash.
            if (typeof msg.code !== "string") {
              conn.send({ t: "error", code: "bad_message", message: "Malformed room code." });
              return;
            }
            const room = store.get(msg.code);
            if (!room) {
              conn.send({
                t: "error",
                code: "room_not_found",
                message: "No room with that code.",
              });
              return;
            }
            const res = room.reserveJoiner(msg.name, conn);
            if ("error" in res) {
              conn.send({ t: "error", code: res.error, message: res.message });
              return;
            }
            bound = { room, pid: res.pid };
            conn.send({
              t: "joined",
              code: room.code,
              you: res.pid,
              token: res.token,
              state: room.snapshot(),
            });
            room.broadcast(); // push the now-active state to both players
            return;
          }
          case "reconnect": {
            if (active()) return;
            // Both feed lookups (code -> RoomStore.get, token -> slot match), so a
            // non-string code would throw and a non-string token is meaningless.
            if (typeof msg.code !== "string" || typeof msg.token !== "string") {
              conn.send({
                t: "error",
                code: "bad_message",
                message: "Malformed reconnect payload.",
              });
              return;
            }
            const room = store.get(msg.code);
            if (!room) {
              conn.send({
                t: "error",
                code: "room_not_found",
                message: "Room no longer exists.",
              });
              return;
            }
            const res = room.reconnect(msg.token, conn);
            if ("error" in res) {
              conn.send({ t: "error", code: res.error, message: res.message });
              return;
            }
            bound = { room, pid: res.pid };
            conn.send({
              t: "joined",
              code: room.code,
              you: res.pid,
              token: msg.token,
              state: room.snapshot(),
            });
            room.broadcast(); // opponent sees presence restored
            return;
          }
          case "move": {
            const b = active();
            if (!b) return; // not bound to a live room
            const cell = parseCell(msg);
            if (!cell) {
              conn.send({ t: "error", code: "bad_message", message: "Malformed move." });
              return;
            }
            b.room.move(b.pid, cell, conn);
            return;
          }
          case "retry": {
            // No payload validation: retry carries no fields beyond `t`. The
            // player is inferred from the bound slot (same as move).
            const b = active();
            if (!b) return;
            b.room.retry(b.pid, conn);
            return;
          }
          case "undo": {
            // No payload validation: undo carries no fields beyond `t`.
            const b = active();
            if (!b) return;
            b.room.undo(b.pid, conn);
            return;
          }
          case "leave": {
            const b = active();
            if (b) b.room.leave(b.pid, conn);
            bound = null;
            return;
          }
          default: {
            conn.send({ t: "error", code: "bad_message", message: "Unknown message." });
          }
        }
      };

      return {
        onOpen(_event: Event, ws: WSContext) {
          conn = makeConn(ws);
        },
        onMessage(event: MessageEvent, ws: WSContext) {
          if (!conn) conn = makeConn(ws);
          const raw = typeof event.data === "string" ? event.data : null;
          if (!raw) {
            conn.send({ t: "error", code: "bad_message", message: "Expected a text frame." });
            return;
          }
          let msg: ClientMsg;
          try {
            msg = JSON.parse(raw) as ClientMsg;
          } catch {
            conn.send({ t: "error", code: "bad_message", message: "Malformed JSON." });
            return;
          }
          if (!msg || typeof msg.t !== "string") {
            conn.send({ t: "error", code: "bad_message", message: "Missing message type." });
            return;
          }
          dispatch(msg);
        },
        onClose() {
          if (bound) bound.room.handleDisconnect(bound.pid, conn!);
          bound = null;
        },
      };
    }),
  );

  return websocket;
}
