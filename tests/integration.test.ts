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
// present once active).
function activeState(s: ServerMsg & { t: "state" }) {
  const st = s.state;
  return {
    board: st.board!,
    knights: st.knights!,
    visited: st.visited!,
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

  // C3 ANCHOR: in C2, landing on the OTHER knight's current square is rejected.
  // C3 will flip exactly this branch into the rendezvous win.
  test("dedicated: reject landing on the OTHER knight's current cell → illegal_move", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Drive p1 along legal hops until it sits a knight-move away from p2's
    // current cell, then attempt to hop ONTO p2 — only the "other knight" rule
    // should reject it. We BFS the playable graph (the board IS a knight's walk,
    // so it is connected) for a path start→…→adjacent-to-p2 that never steps on
    // p2's current cell, and replay it with real moves.
    const target = init.knights.p2; // p2 never moves in this test
    const path = bfsToAdjacent(board, init.knights.p1, target);
    expect(path).not.toBeNull();

    let v1 = init.visited.p1.slice();
    for (const step of path!) {
      // Each hop must be legal at send time (BFS already guarantees availability,
      // knight-step, and avoidance of `target`; trail-uniqueness holds because a
      // BFS shortest path has no repeats and p2's trail is just its start).
      p1.send({ t: "move", cell: step });
      const after = await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
      v1 = after.visited.p1.slice();
    }

    // p1 now sits a knight-move from p2; p2's cell is available and unvisited —
    // only the dedicated "other knight" branch blocks this hop.
    expect(knightMoves(v1[v1.length - 1], board.n).some((m) => sameCell(m, target))).toBe(true);
    p1.send({ t: "move", cell: target });
    expect((await p1.waitFor("error")).code).toBe("illegal_move");
    // And p2 must be unmoved.
    const s = activeState(p1.last("state")!);
    expect(s.knights.p2).toEqual(init.knights.p2);
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

  test("concurrency: two moves to the SAME target → exactly one state, one illegal_move", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;

    // Reconstruct the witness path and pick a MIDDLE meeting cell T. p1 (at
    // path[0]) walks up to path[i-1] and p2 (at path[last]) walks down to
    // path[i+1]; both then sit a knight-move from T = path[i] along DISJOINT
    // halves of the path. This guarantees a shared, legal concurrent target on
    // ANY random board (no seed pinning needed).
    const path = reconstructPath(board, init.knights.p1, init.knights.p2);
    const i = Math.floor(path.length / 2);
    const target = path[i];

    // Walk p1 forward: path[1] .. path[i-1].
    for (let j = 1; j < i; j++) {
      const step = path[j];
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    // Walk p2 backward: path[last-1] .. path[i+1].
    for (let j = path.length - 2; j > i; j--) {
      const step = path[j];
      p2.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, step));
    }

    // Sanity: both knights are now a knight-move from T and T is unvisited.
    const pre = activeState(p1.last("state")!);
    expect(knightMoves(pre.knights.p1, board.n).some((m) => sameCell(m, target))).toBe(true);
    expect(knightMoves(pre.knights.p2, board.n).some((m) => sameCell(m, target))).toBe(true);
    expect(inCells(pre.visited.p1, target) || inCells(pre.visited.p2, target)).toBe(false);

    // Send BOTH moves to the same target WITHOUT awaiting between sends. The
    // single-threaded room serializes them: first valid wins, the other errors.
    p1.send({ t: "move", cell: target });
    p2.send({ t: "move", cell: target });

    // Collect both outcomes. Exactly one client's knight advances to T (a state),
    // and exactly one client gets an illegal_move.
    const winnerState = await awaitMoveApplied(
      p1,
      p2,
      (v) => inCells(v.p1, target) || inCells(v.p2, target),
    );

    const p1Landed = inCells(winnerState.visited.p1, target);
    const p2Landed = inCells(winnerState.visited.p2, target);
    // Exactly one of them landed on T.
    expect(p1Landed !== p2Landed).toBe(true);

    // The loser received an illegal_move.
    const loser = p1Landed ? p2 : p1;
    expect((await loser.waitFor("error", (m) => m.code === "illegal_move")).code).toBe(
      "illegal_move",
    );

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
