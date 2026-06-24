// End-to-end integration over a real WebSocket against the actual server, booted
// in-process on an ephemeral port. The C1 contract: two clients create+join a
// room and BOTH receive an active snapshot carrying the SAME board (identical
// seed AND available/start/end), with p1's knight on start, p2's on end, in
// distinct colors — and the witness `path` must NEVER appear on the wire.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import app from "../server/index.ts";
import type { Board, ClientMsg, ServerMsg } from "../shared/protocol";
import { knightMoves, type Cell } from "../shared/engine";

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

const sameCell = (a: Cell, b: Cell): boolean => a.r === b.r && a.c === b.c;
const inCells = (cells: Cell[], c: Cell): boolean => cells.some((x) => sameCell(x, c));

// The active-snapshot fields, asserted non-null (C2: board/knights/visited all
// present once active). C3 also carries the win projection (status/result).
function activeState(s: ServerMsg & { t: "state" }) {
  const st = s.state;
  return {
    board: st.board!,
    knights: st.knights!,
    visited: st.visited!,
    status: st.status,
    result: st.result,
  };
}

// Compute one legal target for `from` against the received board, using the
// shared engine's knight-move set: a knight move onto an available square not in
// either trail and not the other knight's current cell. Mirrors Game.move's rule
// so the test drives genuinely-legal hops. Returns null if none (dead end).
function legalTarget(
  board: Board,
  from: Cell,
  visitedP1: Cell[],
  visitedP2: Cell[],
  otherKnight: Cell,
): Cell | null {
  for (const m of knightMoves(from, board.n)) {
    if (!board.available[m.r][m.c]) continue;
    if (inCells(visitedP1, m) || inCells(visitedP2, m)) continue;
    if (sameCell(m, otherKnight)) continue;
    return m;
  }
  return null;
}

// BFS the playable graph for a SHORTEST path of cells (excluding the source)
// from `from` to some cell that is a knight-move away from `target`, never
// stepping on `target` itself. The board is a knight's walk (connected), so such
// a path exists whenever `target` has any playable knight-neighbor. Returns the
// ordered hops to send, or null if unreachable.
function bfsToAdjacent(board: Board, from: Cell, target: Cell): Cell[] | null {
  const enc = (c: Cell) => c.r * board.n + c.c;
  const isAdjToTarget = (c: Cell) => knightMoves(c, board.n).some((m) => sameCell(m, target));
  if (isAdjToTarget(from)) return []; // already a knight-move away
  const prev = new Map<number, Cell | null>();
  prev.set(enc(from), null);
  const queue: Cell[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const m of knightMoves(cur, board.n)) {
      if (!board.available[m.r][m.c]) continue;
      if (sameCell(m, target)) continue; // never step onto p2
      if (prev.has(enc(m))) continue;
      prev.set(enc(m), cur);
      if (isAdjToTarget(m)) {
        // Reconstruct the path of hops (excluding `from`).
        const hops: Cell[] = [];
        let node: Cell | null = m;
        while (node && !sameCell(node, from)) {
          hops.push(node);
          node = prev.get(enc(node)) ?? null;
        }
        hops.reverse();
        return hops;
      }
      queue.push(m);
    }
  }
  return null;
}

// Reconstruct the board's witness path (start → end) by DFS over the playable
// graph. The board IS a single non-revisiting knight's walk, so the available
// cells form exactly that simple path; DFS from `start` covering all available
// cells and ending at `end` recovers it. This lets a test walk BOTH knights from
// the two ENDS toward a shared middle cell along disjoint halves of the path —
// the only board-agnostic way to set up a guaranteed shared concurrent target.
function reconstructPath(board: Board, start: Cell, end: Cell): Cell[] {
  const cells: Cell[] = [];
  for (let r = 0; r < board.n; r++)
    for (let c = 0; c < board.n; c++) if (board.available[r][c]) cells.push({ r, c });
  const total = cells.length;
  const enc = (c: Cell) => c.r * board.n + c.c;
  const visited = new Set<number>();
  const path: Cell[] = [];

  const dfs = (cur: Cell): boolean => {
    path.push(cur);
    visited.add(enc(cur));
    if (path.length === total) {
      if (sameCell(cur, end)) return true;
    } else {
      for (const m of knightMoves(cur, board.n)) {
        if (!board.available[m.r][m.c] || visited.has(enc(m))) continue;
        if (dfs(m)) return true;
      }
    }
    path.pop();
    visited.delete(enc(cur));
    return false;
  };

  if (!dfs(start)) throw new Error("could not reconstruct the witness path");
  return path;
}

// Drive one fresh active game and return both clients plus the active state.
async function activeGame() {
  const { p1, p2 } = await startGame();
  const s1 = await p1.waitFor("state", (m) => m.state.lobby === "active");
  await p2.waitFor("state", (m) => m.state.lobby === "active");
  return { p1, p2, init: activeState(s1) };
}

// Wait for both clients to observe a state whose `visited` matches a predicate,
// returning p1's view of that state.
async function awaitMoveApplied(
  p1: Client,
  p2: Client,
  pred: (v: { p1: Cell[]; p2: Cell[] }) => boolean,
) {
  const m1 = await p1.waitFor("state", (m) => m.state.visited != null && pred(m.state.visited));
  await p2.waitFor("state", (m) => m.state.visited != null && pred(m.state.visited));
  return activeState(m1);
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

describe("C2 movement + sync (real WS)", () => {
  test("both players hop several legal moves; both clients see both trails identically", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Walk each knight along the witness path so the hops are GUARANTEED legal on
    // any random board (greedy first-available picks can dead-end after a hop or
    // two). p1 (path[0]) steps forward to path[1], path[2]; p2 (path[last]) steps
    // backward to path[last-1], path[last-2]. The path is long enough (19 cells)
    // that these halves never collide, alternating p1/p2 to exercise sync.
    const path = reconstructPath(board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;

    for (let i = 1; i <= 2; i++) {
      const t1 = path[i];
      p1.send({ t: "move", cell: t1 });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t1));

      const t2 = path[last - i];
      p2.send({ t: "move", cell: t2 });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, t2));
    }

    // Both clients' latest active states must be byte-identical (board+knights+visited).
    const s1 = activeState(p1.last("state")!);
    const s2 = activeState(p2.last("state")!);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
    // Each trail grew from 1 (just the start) to 3 (start + 2 hops).
    expect(s1.visited.p1.length).toBe(3);
    expect(s1.visited.p2.length).toBe(3);

    p1.close();
    p2.close();
  });

  test("invariant: knights.pX === visited.pX[last] on both clients after moves", async () => {
    const { p1, p2, init } = await activeGame();
    const t1 = legalTarget(
      init.board,
      init.knights.p1,
      init.visited.p1,
      init.visited.p2,
      init.knights.p2,
    )!;
    p1.send({ t: "move", cell: t1 });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t1));

    for (const c of [p1, p2]) {
      const s = activeState(c.last("state")!);
      expect(s.visited.p1[s.visited.p1.length - 1]).toEqual(s.knights.p1);
      expect(s.visited.p2[s.visited.p2.length - 1]).toEqual(s.knights.p2);
    }
    p1.close();
    p2.close();
  });

  test("a move affects ONLY the sender's knight (p2 unchanged when p1 moves)", async () => {
    const { p1, p2, init } = await activeGame();
    const t1 = legalTarget(
      init.board,
      init.knights.p1,
      init.visited.p1,
      init.visited.p2,
      init.knights.p2,
    )!;
    p1.send({ t: "move", cell: t1 });
    const after = await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t1));

    expect(after.knights.p1).toEqual(t1);
    expect(after.knights.p2).toEqual(init.knights.p2); // p2 untouched
    expect(after.visited.p2).toEqual(init.visited.p2); // p2's trail untouched
    expect(after.visited.p1).toEqual([init.knights.p1, t1]);
    p1.close();
    p2.close();
  });

  test("reject a non-knight-move (adjacent cell) → illegal_move", async () => {
    const { p1, p2, init } = await activeGame();
    // An orthogonally-adjacent cell is never a knight move.
    const adj: Cell = { r: init.knights.p1.r, c: init.knights.p1.c + 1 };
    p1.send({ t: "move", cell: adj });
    expect((await p1.waitFor("error")).code).toBe("illegal_move");
    p1.close();
    p2.close();
  });

  test("reject landing on a cell already in either trail → illegal_move", async () => {
    const { p1, p2, init } = await activeGame();
    // Move p1 once, then try to move p1 back onto its own start (now visited).
    const t1 = legalTarget(
      init.board,
      init.knights.p1,
      init.visited.p1,
      init.visited.p2,
      init.knights.p2,
    )!;
    p1.send({ t: "move", cell: t1 });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t1));
    // From t1, the original start is a knight move (we just came from there) and
    // is available — but it is now in p1's trail, so it must be rejected.
    p1.send({ t: "move", cell: init.knights.p1 });
    expect((await p1.waitFor("error")).code).toBe("illegal_move");
    p1.close();
    p2.close();
  });

  // C3 (replaces the C2 "reject landing on the OTHER knight" anchor): landing on
  // the OTHER knight's current square is now the rendezvous WIN.
  test("rendezvous wins: hopping onto the OTHER knight's cell ends the game on both clients", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Drive p1 along legal hops until it sits a knight-move away from STATIONARY
    // p2's current cell, then hop ONTO p2 — that hop is the rendezvous. We BFS the
    // playable graph (the board IS a knight's walk, so it is connected) for a path
    // start→…→adjacent-to-p2 that never steps on p2's cell, and replay it.
    const target = init.knights.p2; // p2 never moves in this test
    const path = bfsToAdjacent(board, init.knights.p1, target);
    expect(path).not.toBeNull();

    let v1 = init.visited.p1.slice();
    for (const step of path!) {
      p1.send({ t: "move", cell: step });
      const after = await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
      v1 = after.visited.p1.slice();
    }

    // p1 now sits a knight-move from p2; hop ONTO p2 → the rendezvous.
    expect(knightMoves(v1[v1.length - 1], board.n).some((m) => sameCell(m, target))).toBe(true);
    p1.send({ t: "move", cell: target });

    // BOTH clients must observe the win.
    const w1 = await p1.waitFor("state", (m) => m.state.status === "won");
    const w2 = await p2.waitFor("state", (m) => m.state.status === "won");
    for (const w of [w1, w2]) {
      const s = activeState(w);
      expect(s.status).toBe("won");
      expect(s.result).not.toBeNull();
      expect(s.result!.meetCell).toEqual(init.knights.p2);
      // The mover (p1) now sits on p2's cell — the one allowed shared square.
      expect(s.knights.p1).toEqual(init.knights.p2);
      // p2 never moved.
      expect(s.knights.p2).toEqual(init.knights.p2);
      // Invariant survives the rendezvous: visited.p1[last] === knights.p1.
      expect(s.visited.p1[s.visited.p1.length - 1]).toEqual(s.knights.p1);
    }
    p1.close();
    p2.close();
  });

  test("perfect win TRUE: a full-cover solve meeting in the middle → status won, perfect true", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Reconstruct the witness (the available cells ARE a single knight's walk).
    // Walk both knights along DISJOINT halves consuming the WHOLE path, then meet:
    // p1 advances forward to path[i-1], p2 retreats back to path[i+1], so p1 lands
    // a knight-move from path[i] and p2 currently sits ON path[i]. p1 then hops
    // onto p2 — every cell is covered, so the win is perfect.
    const path = reconstructPath(board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    // Choose the meeting cell so that after both walks, p1 is adjacent to where p2
    // stands. p2 walks back to path[i]; p1 walks forward to path[i-1] (a knight
    // move from path[i] since consecutive path cells are knight moves). Meet cell
    // is path[i] — p2's final resting square.
    const i = last - 1; // p2 retreats by exactly one, leaving p1's whole half to cover

    // Walk p1 forward path[1]..path[i-1].
    for (let j = 1; j <= i - 1; j++) {
      const step = path[j];
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    // Walk p2 backward path[last-1]..path[i] (one step: from path[last] to path[i]).
    for (let j = last - 1; j >= i; j--) {
      const step = path[j];
      p2.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, step));
    }

    // Now p1 sits on path[i-1] (a knight move from path[i]); p2 sits on path[i].
    // Every cell of the path is in some trail (p1 covers 0..i-1, p2 covers i..last).
    const pre = activeState(p1.last("state")!);
    expect(sameCell(pre.knights.p2, path[i])).toBe(true);
    expect(knightMoves(pre.knights.p1, board.n).some((m) => sameCell(m, path[i]))).toBe(true);

    // p1 hops onto p2 → rendezvous; all cells covered → perfect.
    p1.send({ t: "move", cell: path[i] });
    const w1 = await p1.waitFor("state", (m) => m.state.status === "won");
    const w2 = await p2.waitFor("state", (m) => m.state.status === "won");
    for (const w of [w1, w2]) {
      const s = activeState(w);
      expect(s.status).toBe("won");
      expect(s.result).not.toBeNull();
      expect(s.result!.perfect).toBe(true);
      expect(s.result!.meetCell).toEqual(path[i]);
    }
    p1.close();
    p2.close();
  });

  test("premature meet → perfect FALSE (and the game STILL ends)", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Drive p1 straight to a knight-move from STATIONARY p2 and hop on — leaving
    // p2's whole half of the path uncovered, so the win is soft (perfect false).
    // (The path is 19 cells; p1's short BFS approach covers only a handful.)
    const target = init.knights.p2;
    const path = bfsToAdjacent(board, init.knights.p1, target)!;
    for (const step of path) {
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    p1.send({ t: "move", cell: target });

    const w1 = await p1.waitFor("state", (m) => m.state.status === "won");
    const w2 = await p2.waitFor("state", (m) => m.state.status === "won");
    for (const w of [w1, w2]) {
      const s = activeState(w);
      // Assert BOTH: the game ended AND it was not perfect (a regression that
      // fails to end the game OR mislabels coverage must be caught).
      expect(s.status).toBe("won");
      expect(s.result).not.toBeNull();
      expect(s.result!.perfect).toBe(false);
    }
    p1.close();
    p2.close();
  });

  test("post-win rejection: a move after the win → game_over, state unchanged", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    const target = init.knights.p2;
    const path = bfsToAdjacent(board, init.knights.p1, target)!;
    for (const step of path) {
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    p1.send({ t: "move", cell: target });
    const won = activeState(await p1.waitFor("state", (m) => m.state.status === "won"));
    await p2.waitFor("state", (m) => m.state.status === "won");

    // Snapshot the post-win state, then attempt ANY further move (p2 toward an
    // empty knight neighbor). It must be rejected as game_over, not illegal_move.
    const beforeJson = JSON.stringify(won);
    const p2Neighbor = knightMoves(won.knights.p2, board.n).find(
      (m) =>
        board.available[m.r][m.c] && !inCells(won.visited.p1, m) && !inCells(won.visited.p2, m),
    );
    // If there's no clean empty neighbor, any knight-move target still hits the
    // post-win guard FIRST; fall back to p2's own prior cell.
    const attempt = p2Neighbor ?? won.visited.p2[0];
    p2.send({ t: "move", cell: attempt });
    expect((await p2.waitFor("error", (m) => m.code === "game_over")).code).toBe("game_over");

    // State unchanged: p1's last broadcast state is still the winning one.
    const after = activeState(p1.last("state")!);
    expect(JSON.stringify(after)).toBe(beforeJson);
    p1.close();
    p2.close();
  });

  test("rendezvous race: both fire at the partner's cell → one win, the loser gets game_over", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Reconstruct the witness; have each knight walk so it sits a knight-move from
    // the OTHER's CURRENT cell. p1 walks forward to path[i] and p2 walks back to
    // path[i+1] — adjacent path cells are knight moves, so p1 is a knight-move
    // from p2's cell AND p2 is a knight-move from p1's cell. Then BOTH fire at the
    // other's current cell un-awaited: exactly one rendezvous wins.
    const path = reconstructPath(board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    const i = Math.floor(path.length / 2);

    for (let j = 1; j <= i; j++) {
      const step = path[j];
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    for (let j = last - 1; j >= i + 1; j--) {
      const step = path[j];
      p2.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, step));
    }

    const pre = activeState(p1.last("state")!);
    // p1 sits on path[i], p2 on path[i+1] — each a knight-move from the other.
    expect(knightMoves(pre.knights.p1, board.n).some((m) => sameCell(m, pre.knights.p2))).toBe(
      true,
    );
    expect(knightMoves(pre.knights.p2, board.n).some((m) => sameCell(m, pre.knights.p1))).toBe(
      true,
    );

    const p1Aim = pre.knights.p2; // p1 hops onto p2
    const p2Aim = pre.knights.p1; // p2 hops onto p1

    // Fire BOTH at the partner's cell WITHOUT awaiting. The single-threaded room
    // serializes them: the first IS the rendezvous (win); the second now hits the
    // post-win guard → game_over (NOT illegal_move).
    p1.send({ t: "move", cell: p1Aim });
    p2.send({ t: "move", cell: p2Aim });

    const w = await p1.waitFor("state", (m) => m.state.status === "won");
    await p2.waitFor("state", (m) => m.state.status === "won");
    const won = activeState(w);
    expect(won.status).toBe("won");
    expect(won.result).not.toBeNull();

    // Exactly one of the two aims is the meet cell (the winner's target).
    const meetIsP1Aim = sameCell(won.result!.meetCell, p1Aim);
    const meetIsP2Aim = sameCell(won.result!.meetCell, p2Aim);
    expect(meetIsP1Aim !== meetIsP2Aim).toBe(true);

    // The loser (whoever did NOT win) gets game_over, not illegal_move.
    const loser = meetIsP1Aim ? p2 : p1;
    expect((await loser.waitFor("error", (m) => m.code === "game_over")).code).toBe("game_over");

    p1.close();
    p2.close();
  });

  test("reject a blocked / off-board (not available) target → illegal_move", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    // A knight move from p1's start that lands on a NON-available (blocked) square,
    // if one exists. Most boards have one given the sparse playable set.
    let blocked: Cell | null = null;
    for (const m of knightMoves(init.knights.p1, board.n)) {
      if (!board.available[m.r][m.c]) {
        blocked = m;
        break;
      }
    }
    if (blocked) {
      p1.send({ t: "move", cell: blocked });
      expect((await p1.waitFor("error")).code).toBe("illegal_move");
    }
    // Off-board: a knight-shaped delta that lands outside the grid is not even a
    // legal knight move (knightMoves filters bounds) → illegal_move.
    const offBoard: Cell = { r: -1, c: init.knights.p1.c + 2 };
    p1.send({ t: "move", cell: offBoard });
    expect((await p1.waitFor("error")).code).toBe("illegal_move");
    p1.close();
    p2.close();
  });

  test("malformed cell → bad_message (envelope rejected before any game rule)", async () => {
    const { p1, p2 } = await activeGame();
    // Missing cell entirely.
    p1.send({ t: "move" } as unknown as ClientMsg);
    expect((await p1.waitFor("error")).code).toBe("bad_message");
    // Non-integer coords.
    p1.send({ t: "move", cell: { r: 1.5, c: 2 } } as unknown as ClientMsg);
    expect((await p1.waitFor("error", (m) => m.code === "bad_message")).code).toBe("bad_message");
    // cell not an object.
    p1.send({ t: "move", cell: "nope" } as unknown as ClientMsg);
    expect((await p1.waitFor("error", (m) => m.code === "bad_message")).code).toBe("bad_message");
    p1.close();
    p2.close();
  });

  // C2 concurrency regression, kept green under C3 rules. NOTE: under same-square
  // rendezvous, two un-awaited moves to the same EMPTY cell can NO LONGER both be
  // a simple race — the first lands normally, then the second (now onto the
  // winner's current cell) is the rendezvous WIN, not an error (see the dedicated
  // "rendezvous race" test). So the surviving NON-rendezvous same-target
  // concurrency case is a race onto an already-VISITED cell: both moves must be
  // rejected as no-reuse `illegal_move`, proving the win-check does NOT swallow
  // ordinary rejections and the game stays "playing".
  test("concurrency: two moves to the SAME already-visited cell → both illegal_move, no win", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Reconstruct the witness. p1 walks forward two hops, leaving V = path[1] as a
    // VISITED cell that is no longer anyone's CURRENT square (p1 now sits on
    // path[2]). p2 stays on its start (path[last]). Both clients then fire at V
    // un-awaited.
    //
    // Why this is the surviving NON-rendezvous same-target concurrency case under
    // C3's same-square rendezvous: a race onto an EMPTY cell can no longer yield a
    // plain "loser illegal" — the second mover lands on the winner and that is the
    // WIN (see the dedicated "rendezvous race" test). The only same-target race
    // that stays an error is one onto an already-VISITED cell: p1's move is a
    // no-reuse rejection (V is in its own trail); p2's move is rejected too (V is
    // not a knight-move from path[last] in this board, and even if it were it is
    // visited) — both `illegal_move`, the game stays "playing", proving the
    // win-check does NOT swallow ordinary rejections.
    const path = reconstructPath(board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    expect(last).toBeGreaterThan(2);

    for (let j = 1; j <= 2; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }
    const V = path[1]; // visited by p1, not anyone's current cell

    const pre = activeState(p1.last("state")!);
    expect(inCells(pre.visited.p1, V)).toBe(true);
    expect(sameCell(pre.knights.p1, V)).toBe(false);
    expect(sameCell(pre.knights.p2, V)).toBe(false);
    expect(pre.status).toBe("playing");
    // p1 IS a knight-move from V (it just came from there) so p1's move reaches
    // the no-reuse check; this is the no-reuse rejection we care about.
    expect(knightMoves(pre.knights.p1, board.n).some((m) => sameCell(m, V))).toBe(true);

    // Fire BOTH at the visited cell V WITHOUT awaiting. Both must be rejected as
    // illegal_move, and the game must remain unwon (no rendezvous on a visited
    // cell — the win-check only fires on the OTHER knight's CURRENT cell).
    p1.send({ t: "move", cell: V });
    p2.send({ t: "move", cell: V });
    expect((await p1.waitFor("error", (m) => m.code === "illegal_move")).code).toBe("illegal_move");
    expect((await p2.waitFor("error", (m) => m.code === "illegal_move")).code).toBe("illegal_move");

    // No win happened; last state is still "playing".
    expect(activeState(p1.last("state")!).status).toBe("playing");
    p1.close();
    p2.close();
  });

  test('the witness path NEVER leaks across C2 movement: no "path" in any state', async () => {
    const { p1, p2, init } = await activeGame();
    const t1 = legalTarget(
      init.board,
      init.knights.p1,
      init.visited.p1,
      init.visited.p2,
      init.knights.p2,
    )!;
    p1.send({ t: "move", cell: t1 });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t1));
    expect(p1.states().every((m) => !JSON.stringify(m.state).includes('"path"'))).toBe(true);
    expect(p2.states().every((m) => !JSON.stringify(m.state).includes('"path"'))).toBe(true);
    p1.close();
    p2.close();
  });
});

// Wait until `c` has received at least `n` total `state` messages, returning the
// latest active state. Used for retry/undo NO-OPs, which STILL broadcast (uniform
// "ok ⇒ broadcast") but leave `visited` unchanged, so a content predicate can't
// detect them — we count broadcasts instead.
async function awaitStateCount(c: Client, n: number) {
  await c.waitFor("state", () => c.states().length >= n);
  return activeState(c.last("state")!);
}

// Converge the two knights onto adjacent witness-path cells: drive p1 forward to
// path[i] and p2 back to path[i+1] (consecutive path cells are knight moves, so
// the two are a knight-move apart). Returns the path, the meet index i, and the
// post-convergence state. p1's trail = path[0..i], p2's trail = path[i+1..last].
async function convergeMidpoint(p1: Client, p2: Client, init: ReturnType<typeof activeState>) {
  const board = init.board;
  const path = reconstructPath(board, init.knights.p1, init.knights.p2);
  const last = path.length - 1;
  const i = Math.floor(path.length / 2);
  for (let j = 1; j <= i; j++) {
    p1.send({ t: "move", cell: path[j] });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
  }
  for (let j = last - 1; j >= i + 1; j--) {
    p2.send({ t: "move", cell: path[j] });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, path[j]));
  }
  return { path, i, pre: activeState(p1.last("state")!) };
}

describe("C4 retry + undo (real WS)", () => {
  test("retry resets ONLY the requester's trail to its start; the OTHER is byte-identical", async () => {
    const { p1, p2, init } = await activeGame();
    // p1 hops twice along the witness; p2 hops once. Then p1 retries.
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    for (let j = 1; j <= 2; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }
    p2.send({ t: "move", cell: path[last - 1] });
    const before = await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, path[last - 1]));
    const p2VisitedBefore = JSON.stringify(before.visited.p2);
    const p2KnightBefore = JSON.stringify(before.knights.p2);

    p1.send({ t: "retry" });
    // Require p2's hop to be present so we don't match the INITIAL state (where
    // p1.length is also 1 but p2 had not yet moved).
    const after = await awaitMoveApplied(
      p1,
      p2,
      (v) => v.p1.length === 1 && inCells(v.p2, path[last - 1]),
    );

    // Requester collapsed to [start]; knight back on start.
    expect(after.visited.p1).toEqual([init.knights.p1]);
    expect(after.knights.p1).toEqual(init.knights.p1);
    // The OTHER player is byte-identical before/after (deep-equal).
    expect(JSON.stringify(after.visited.p2)).toBe(p2VisitedBefore);
    expect(JSON.stringify(after.knights.p2)).toBe(p2KnightBefore);
    // Both clients agree.
    expect(JSON.stringify(activeState(p2.last("state")!))).toBe(JSON.stringify(after));
    p1.close();
    p2.close();
  });

  test("undo pops ONLY the requester's last hop; the OTHER is byte-identical", async () => {
    const { p1, p2, init } = await activeGame();
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    for (let j = 1; j <= 2; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }
    p2.send({ t: "move", cell: path[last - 1] });
    const before = await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, path[last - 1]));
    const p2VisitedBefore = JSON.stringify(before.visited.p2);
    const p2KnightBefore = JSON.stringify(before.knights.p2);

    p1.send({ t: "undo" });
    // p1's trail goes 3 → 2; path[2] is freed, path[1] stays. CONTENT-unique
    // predicate (NOT a length): it must also REQUIRE p2's hop so we don't match the
    // earlier 2-cell p1 state right after p1's first hop, when p2 had not yet moved.
    const after = await awaitMoveApplied(
      p1,
      p2,
      (v) => inCells(v.p1, path[1]) && !inCells(v.p1, path[2]) && inCells(v.p2, path[last - 1]),
    );

    expect(after.visited.p1).toEqual([init.knights.p1, path[1]]);
    expect(after.knights.p1).toEqual(path[1]);
    // The OTHER player byte-identical before/after.
    expect(JSON.stringify(after.visited.p2)).toBe(p2VisitedBefore);
    expect(JSON.stringify(after.knights.p2)).toBe(p2KnightBefore);
    p1.close();
    p2.close();
  });

  test("undo at the start (length <= 1) is a benign no-op: ok, no state change", async () => {
    const { p1, p2, init } = await activeGame();
    const beforeCount = p1.states().length;
    const before = activeState(p1.last("state")!);

    p1.send({ t: "undo" });
    // Uniform "ok ⇒ broadcast": a no-op STILL broadcasts. Wait for that broadcast,
    // then assert content is unchanged.
    const after = await awaitStateCount(p1, beforeCount + 1);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.visited.p1).toEqual([init.knights.p1]);
    expect(after.knights.p1).toEqual(init.knights.p1);
    // No error came back.
    expect(p1.last("error")).toBeNull();
    p1.close();
    p2.close();
  });

  test("retry when already at the start is idempotent: ok, no change", async () => {
    const { p1, p2, init } = await activeGame();
    const beforeCount = p1.states().length;
    const before = activeState(p1.last("state")!);

    p1.send({ t: "retry" });
    const after = await awaitStateCount(p1, beforeCount + 1);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.visited.p1).toEqual([init.knights.p1]);
    expect(after.knights.p1).toEqual(init.knights.p1);
    expect(p1.last("error")).toBeNull();
    p1.close();
    p2.close();
  });

  test("invariant knights.pX === visited.pX[last] holds after undo AND after retry", async () => {
    const { p1, p2, init } = await activeGame();
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);
    for (let j = 1; j <= 3; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }

    // CONTENT-unique predicate (length 3 alone would match the earlier 3-cell
    // state after p1's 2nd hop): undo frees path[3] and leaves path[2] as current.
    p1.send({ t: "undo" });
    const afterUndo = await awaitMoveApplied(
      p1,
      p2,
      (v) => inCells(v.p1, path[2]) && !inCells(v.p1, path[3]),
    );
    for (const s of [afterUndo, activeState(p2.last("state")!)]) {
      expect(s.visited.p1[s.visited.p1.length - 1]).toEqual(s.knights.p1);
      expect(s.visited.p2[s.visited.p2.length - 1]).toEqual(s.knights.p2);
    }

    // After retry p1's trail collapses to [start]; path[1] is no longer present.
    p1.send({ t: "retry" });
    const afterRetry = await awaitMoveApplied(
      p1,
      p2,
      (v) => v.p1.length === 1 && !inCells(v.p1, path[1]),
    );
    for (const s of [afterRetry, activeState(p2.last("state")!)]) {
      expect(s.visited.p1[s.visited.p1.length - 1]).toEqual(s.knights.p1);
      expect(s.visited.p2[s.visited.p2.length - 1]).toEqual(s.knights.p2);
    }
    p1.close();
    p2.close();
  });

  test("both retry and undo are rejected with game_over after a win (state unchanged)", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    // Drive p1 onto stationary p2 → rendezvous (clone of the post-win pattern).
    const target = init.knights.p2;
    const path = bfsToAdjacent(board, init.knights.p1, target)!;
    for (const step of path) {
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    p1.send({ t: "move", cell: target });
    const won = activeState(await p1.waitFor("state", (m) => m.state.status === "won"));
    await p2.waitFor("state", (m) => m.state.status === "won");
    const beforeJson = JSON.stringify(won);

    // Each of retry/undo, from each player, must be rejected as game_over.
    p1.send({ t: "retry" });
    expect((await p1.waitFor("error", (m) => m.code === "game_over")).code).toBe("game_over");
    p1.send({ t: "undo" });
    expect((await p1.waitFor("error", (m) => m.code === "game_over")).code).toBe("game_over");
    p2.send({ t: "retry" });
    expect((await p2.waitFor("error", (m) => m.code === "game_over")).code).toBe("game_over");
    p2.send({ t: "undo" });
    expect((await p2.waitFor("error", (m) => m.code === "game_over")).code).toBe("game_over");

    // State is unchanged: the last broadcast is still the winning one.
    expect(JSON.stringify(activeState(p1.last("state")!))).toBe(beforeJson);
    p1.close();
    p2.close();
  });

  test("vacated-cell re-legality: p1 undoes off cell X, then p2 legally hops onto X", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    // Converge: p1 on path[i], p2 on path[i+1] (a knight-move apart). X = path[i].
    const { path, i, pre } = await convergeMidpoint(p1, p2, init);
    const X = path[i];
    expect(sameCell(pre.knights.p1, X)).toBe(true);
    expect(inCells(pre.visited.p1, X)).toBe(true);
    // p2 is a knight-move from X, but X is currently in p1's trail → blocked.
    expect(knightMoves(pre.knights.p2, board.n).some((m) => sameCell(m, X))).toBe(true);

    // p1 undoes off X → X is freed (back to path[i-1]). CONTENT-unique predicate:
    // path[i-1] present, X absent, AND p2 already converged to path[i+1] — without
    // the p2 clause this also matches the forward-walk state where p1 first reached
    // path[i-1] (X not yet visited, and p2 had not yet moved).
    p1.send({ t: "undo" });
    const afterUndo = await awaitMoveApplied(
      p1,
      p2,
      (v) => inCells(v.p1, path[i - 1]) && !inCells(v.p1, X) && inCells(v.p2, path[i + 1]),
    );
    expect(inCells(afterUndo.visited.p1, X)).toBe(false);
    expect(afterUndo.knights.p1).toEqual(path[i - 1]);

    // p2 now legally hops onto X (proves the no-reuse union recomputes from live
    // trails — the freed cell is re-enterable).
    p2.send({ t: "move", cell: X });
    const afterHop = await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, X));
    expect(inCells(afterHop.visited.p2, X)).toBe(true);
    expect(afterHop.knights.p2).toEqual(X);
    // No error fired for p2.
    expect(p2.last("error")).toBeNull();
    p1.close();
    p2.close();
  });

  test("concurrency: p1 retry frees a cell an in-flight p2 move targets → that move now succeeds where it would have failed", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    // Converge so p2 (on path[i+1]) is a knight-move from X = path[i]. After the
    // converge, X is p1's CURRENT cell. The witness-path geometry only ever puts a
    // p1-OWNED cell adjacent to p2 at p1's current square, so X = path[i] is the
    // cell we can force p2 to target. WITHOUT the retry, p2's hop onto X would be
    // the rendezvous WIN (it ends the game); we want it as an ORDINARY move.
    const { path, i, pre } = await convergeMidpoint(p1, p2, init);
    const X = path[i];
    expect(sameCell(pre.knights.p1, X)).toBe(true); // X is p1's current cell now
    expect(knightMoves(pre.knights.p2, board.n).some((m) => sameCell(m, X))).toBe(true);
    expect(pre.status).toBe("playing");

    // Fire p1 RETRY then p2's hop onto X UN-AWAITED. The single-threaded room
    // serializes retry FIRST: p1 abandons X (resets to its start), so X is now a
    // free, unowned cell — and p2's hop lands as an ORDINARY move, NOT a
    // rendezvous (no win). Without the retry ordering, the SAME hop would have
    // ended the game on the partner's square; here it is a plain trail extension.
    p1.send({ t: "retry" });
    p2.send({ t: "move", cell: X });
    const after = await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, X));
    expect(after.knights.p2).toEqual(X);
    expect(inCells(after.visited.p2, X)).toBe(true);
    // The hop did NOT win — retry-first turned the rendezvous into an ordinary move.
    expect(after.status).toBe("playing");
    expect(after.result).toBeNull();
    // p1 was reset to its start by the retry (and is no longer on X).
    expect(after.visited.p1).toEqual([init.knights.p1]);
    expect(sameCell(after.knights.p1, X)).toBe(false);
    p1.close();
    p2.close();
  });

  test("concurrency: p2 moves, then p1 undoes — p2's trail is untouched by p1's undo", async () => {
    const { p1, p2, init } = await activeGame();
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    // p1 takes two hops so it has something to undo.
    for (let j = 1; j <= 2; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }
    // p2 moves.
    p2.send({ t: "move", cell: path[last - 1] });
    const afterP2 = await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, path[last - 1]));
    const p2VisitedAfterMove = JSON.stringify(afterP2.visited.p2);
    const p2KnightAfterMove = JSON.stringify(afterP2.knights.p2);

    // p1 undoes — p2's trail/knight must be byte-identical. CONTENT-unique
    // predicate (path[1] present, path[2] freed, AND p2's hop present) so we don't
    // match the earlier 2-cell p1 state from right after p1's first hop (before p2
    // moved).
    p1.send({ t: "undo" });
    const afterUndo = await awaitMoveApplied(
      p1,
      p2,
      (v) => inCells(v.p1, path[1]) && !inCells(v.p1, path[2]) && inCells(v.p2, path[last - 1]),
    );
    expect(JSON.stringify(afterUndo.visited.p2)).toBe(p2VisitedAfterMove);
    expect(JSON.stringify(afterUndo.knights.p2)).toBe(p2KnightAfterMove);
    p1.close();
    p2.close();
  });
});
