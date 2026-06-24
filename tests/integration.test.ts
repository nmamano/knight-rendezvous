// End-to-end integration over a real WebSocket against the actual server, booted
// in-process on an ephemeral port. The C1 contract: two clients create+join a
// room and BOTH receive an active snapshot carrying the SAME board (identical
// seed AND available/start/end), with p1's knight on start, p2's on end, in
// distinct colors — and the witness `path` must NEVER appear on the wire.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import app from "../server/index.ts";
import type { Board, ClientMsg, ServerMsg } from "../shared/protocol";

type OfType<K extends ServerMsg["t"]> = Extract<ServerMsg, { t: K }>;

let server: ReturnType<typeof Bun.serve>;
let WS_URL = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket });
  WS_URL = `ws://localhost:${server.port}/ws`;
});
afterAll(() => server.stop(true));

interface Client {
  send(m: ClientMsg): void;
  opened(): Promise<void>;
  waitFor<K extends ServerMsg["t"]>(
    t: K,
    extra?: (m: OfType<K>) => boolean,
    ms?: number,
  ): Promise<OfType<K>>;
  last<K extends ServerMsg["t"]>(t: K): OfType<K> | null;
  states(): OfType<"state">[];
  close(): void;
}

function client(): Client {
  const ws = new WebSocket(WS_URL);
  const inbox: ServerMsg[] = [];
  const waiters: Array<(m: ServerMsg) => boolean> = [];

  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data) as ServerMsg;
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1);
  };

  return {
    send: (m) => ws.send(JSON.stringify(m)),
    opened: () =>
      new Promise<void>((r) =>
        ws.readyState === WebSocket.OPEN ? r() : ws.addEventListener("open", () => r()),
      ),
    waitFor: (t, extra, ms = 2500) => {
      const match = (m: ServerMsg): m is OfType<typeof t> =>
        m.t === t && (!extra || extra(m as OfType<typeof t>));
      const existing = inbox.find(match);
      if (existing) return Promise.resolve(existing as OfType<typeof t>);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms);
        waiters.push((m) => {
          if (match(m)) {
            clearTimeout(timer);
            resolve(m as OfType<typeof t>);
            return true;
          }
          return false;
        });
      });
    },
    last: (t) => {
      for (let i = inbox.length - 1; i >= 0; i--)
        if (inbox[i].t === t) return inbox[i] as OfType<typeof t>;
      return null;
    },
    states: () => inbox.filter((m): m is OfType<"state"> => m.t === "state"),
    close: () => ws.close(),
  };
}

async function startGame() {
  const p1 = client();
  await p1.opened();
  p1.send({ t: "create", name: "Alice" });
  const j1 = await p1.waitFor("joined");
  const p2 = client();
  await p2.opened();
  p2.send({ t: "join", code: j1.code, name: "Bob" });
  const j2 = await p2.waitFor("joined");
  await p1.waitFor("state", (m) => m.state.lobby === "active");
  return { p1, p2, j1, j2 };
}

function sameBoard(a: Board, b: Board): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe("integration (real WS)", () => {
  test("create yields a waiting room with no board; join makes it active for both", async () => {
    const { p1, p2, j1, j2 } = await startGame();
    expect(j1.you).toBe("p1");
    expect(j1.state.lobby).toBe("waiting");
    expect(j1.state.board).toBeNull();
    expect(j1.state.knights).toBeNull();
    expect(j2.you).toBe("p2");
    expect(j2.state.lobby).toBe("active");
    expect(j1.token.length).toBeGreaterThanOrEqual(12);

    const s = p1.last("state")!;
    expect(s.state.lobby).toBe("active");
    expect(s.state.players.find((p) => p.id === "p2")?.name).toBe("Bob");
    p1.close();
    p2.close();
  });

  test("both clients receive the IDENTICAL board (same seed + available/start/end)", async () => {
    const { p1, p2 } = await startGame();
    const s1 = (await p1.waitFor("state", (m) => m.state.lobby === "active")).state;
    const s2 = (await p2.waitFor("state", (m) => m.state.lobby === "active")).state;
    expect(s1.board).not.toBeNull();
    expect(s2.board).not.toBeNull();
    expect(typeof s1.board!.seed).toBe("number");
    // Byte-identical boards: the same (n, steps, seed) triple AND the derived
    // available/start/end — both must match.
    expect(s1.board!.seed).toBe(s2.board!.seed);
    expect(sameBoard(s1.board!, s2.board!)).toBe(true);
    p1.close();
    p2.close();
  });

  test("knights sit on the endpoints: p1 = start, p2 = end", async () => {
    const { p1, p2 } = await startGame();
    const s1 = (await p1.waitFor("state", (m) => m.state.lobby === "active")).state;
    const s2 = (await p2.waitFor("state", (m) => m.state.lobby === "active")).state;
    const board = s1.board!;
    expect(s1.knights!.p1).toEqual(board.start);
    expect(s1.knights!.p2).toEqual(board.end);
    // Both clients agree on knight positions too.
    expect(s2.knights).toEqual(s1.knights);
    p1.close();
    p2.close();
  });

  test("players hold distinct colors: p1 amber, p2 violet", async () => {
    const { p1, p2 } = await startGame();
    const s = (await p1.waitFor("state", (m) => m.state.lobby === "active")).state;
    const c1 = s.players.find((p) => p.id === "p1")?.color;
    const c2 = s.players.find((p) => p.id === "p2")?.color;
    expect(c1).toBe("amber");
    expect(c2).toBe("violet");
    expect(c1).not.toBe(c2);
    p1.close();
    p2.close();
  });

  test('the witness path NEVER leaks: no serialized snapshot contains "path"', async () => {
    const { p1, p2, j1, j2 } = await startGame();
    // Guard the joined snapshots and every broadcast state, on both clients.
    expect(JSON.stringify(j1.state)).not.toContain('"path"');
    expect(JSON.stringify(j2.state)).not.toContain('"path"');
    expect(p1.states().every((m) => !JSON.stringify(m.state).includes('"path"'))).toBe(true);
    expect(p2.states().every((m) => !JSON.stringify(m.state).includes('"path"'))).toBe(true);
    p1.close();
    p2.close();
  });

  test("reconnect by token reclaims the slot; bad token is rejected", async () => {
    const { p1, p2, j1 } = await startGame();
    p1.close();
    await p2.waitFor(
      "state",
      (m) => m.state.players.find((p) => p.id === "p1")?.connected === false,
    );

    const p1b = client();
    await p1b.opened();
    p1b.send({ t: "reconnect", code: j1.code, token: j1.token });
    const rejoined = await p1b.waitFor("joined");
    expect(rejoined.you).toBe("p1");
    expect(rejoined.state.lobby).toBe("active");

    const intruder = client();
    await intruder.opened();
    intruder.send({ t: "reconnect", code: j1.code, token: "not-a-real-token" });
    expect((await intruder.waitFor("error")).code).toBe("bad_token");

    p1b.close();
    p2.close();
    intruder.close();
  });

  test("explicit leave notifies the opponent", async () => {
    const { p1, p2 } = await startGame();
    p1.send({ t: "leave" });
    await p2.waitFor("opponentLeft");
    p2.close();
  });

  test("join errors: unknown code and full room", async () => {
    const x = client();
    await x.opened();
    x.send({ t: "join", code: "ZZZZ", name: "Nobody" });
    expect((await x.waitFor("error")).code).toBe("room_not_found");
    x.close();

    const { p1, p2, j1 } = await startGame();
    const c = client();
    await c.opened();
    c.send({ t: "join", code: j1.code, name: "Cat" });
    expect((await c.waitFor("error")).code).toBe("room_full");
    p1.close();
    p2.close();
    c.close();
  });

  test("malformed (non-string) code/token are rejected as bad_message, not a crash", async () => {
    const a = client();
    await a.opened();
    a.send({ t: "join", code: 123, name: "x" } as unknown as ClientMsg);
    expect((await a.waitFor("error")).code).toBe("bad_message");
    a.close();

    const b = client();
    await b.opened();
    b.send({ t: "reconnect", code: "ABCD", token: 456 } as unknown as ClientMsg);
    expect((await b.waitFor("error")).code).toBe("bad_message");
    b.close();
  });
});
