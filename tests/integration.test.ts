// End-to-end integration over a real WebSocket against the actual server, booted
// in-process on an ephemeral port. The C1 contract: two clients create+join a
// room and BOTH receive an active snapshot carrying the SAME board (identical
// seed AND available/start/end), with p1's knight on start, p2's on end, in
// distinct colors — and the witness `path` must NEVER appear on the wire.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import app from "../server/index.ts";
import type { Board, ClientMsg, ServerMsg } from "../shared/protocol";
import { generatePuzzle, knightMoves, type Cell } from "../shared/engine";
import { difficultyScore } from "../shared/analysis";

type OfType<K extends ServerMsg["t"]> = Extract<ServerMsg, { t: K }>;

let server: ReturnType<typeof Bun.serve>;
let WS_URL = "";

beforeAll(() => {
  // C5: drive view-solution playback at a tiny per-frame interval so tests assert
  // the frame SEQUENCE without ever waiting real time. RoomStore.resolveStepMs
  // reads this env lazily per createRoom, so setting it before any room is created
  // (i.e. here, before the first test) is sufficient.
  process.env.KR_PLAYBACK_STEP_MS = "1";
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
  // Count of received messages of a given type (for actor-only assertions: the
  // OTHER client's count must not change when we request a hint).
  inboxCount(t: ServerMsg["t"]): number;
  // Every received message, for the path-leak guard across ALL message types.
  allMessages(): ServerMsg[];
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
    inboxCount: (t) => inbox.filter((m) => m.t === t).length,
    allMessages: () => inbox.slice(),
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

  test("board carries the difficulty NUMBER (derived from the path) but never the path", async () => {
    const { p1, p2 } = await startGame();
    const s1 = (await p1.waitFor("state", (m) => m.state.lobby === "active")).state;
    const board = s1.board!;
    // Difficulty is a finite number on the wire, identical across clients.
    expect(typeof board.difficulty).toBe("number");
    expect(Number.isFinite(board.difficulty)).toBe(true);
    const s2 = (await p2.waitFor("state", (m) => m.state.lobby === "active")).state;
    expect(s2.board!.difficulty).toBe(board.difficulty);
    // It EQUALS a server-side recompute from the regenerated puzzle (proving it is
    // the genuine branching-product score) — yet the raw `path` it derives from is
    // NOT on the wire (the dedicated path-leak guard covers that).
    const regen = generatePuzzle(board.n, board.steps, board.seed);
    expect(board.difficulty).toBe(difficultyScore(regen));
    expect(JSON.stringify(s1)).not.toContain('"path"');
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

  test("post-win move is a SILENT no-op: no error, no state change, status STAYS won", async () => {
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
    // empty knight neighbor). `won` is now a SOFT, reversible state: the move is a
    // SILENT no-op — NO error, NO broadcast, status STAYS "won" (the board is
    // locked until someone undoes).
    const beforeJson = JSON.stringify(won);
    const beforeCount = p1.states().length;
    const p2Neighbor = knightMoves(won.knights.p2, board.n).find(
      (m) =>
        board.available[m.r][m.c] && !inCells(won.visited.p1, m) && !inCells(won.visited.p2, m),
    );
    const attempt = p2Neighbor ?? won.visited.p2[0];
    p2.send({ t: "move", cell: attempt });
    // Prove the move was fully processed-and-swallowed: a following bad_message we
    // CAN await comes back, but NO error and NO new state arrived for the move.
    p2.send({ t: "nope" } as unknown as ClientMsg);
    await p2.waitFor("error", (m) => m.code === "bad_message");
    expect(p2.last("error")!.code).toBe("bad_message"); // never game_over / illegal_move
    // No new broadcast happened from the swallowed move; state unchanged + still won.
    expect(p1.states().length).toBe(beforeCount);
    const after = activeState(p1.last("state")!);
    expect(after.status).toBe("won");
    expect(JSON.stringify(after)).toBe(beforeJson);
    p1.close();
    p2.close();
  });

  test("rendezvous race: both fire at the partner's cell → one win, the loser gets NO error (silent)", async () => {
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
    // post-win guard → a SILENT no-op (NO error, exactly one win).
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

    // The loser (whoever did NOT win) gets NO error — the second move is a SILENT
    // no-op now, not a rejection. Prove it was processed-and-swallowed via a
    // following bad_message we can await; no error from the move itself.
    const loser = meetIsP1Aim ? p2 : p1;
    loser.send({ t: "nope" } as unknown as ClientMsg);
    await loser.waitFor("error", (m) => m.code === "bad_message");
    expect(loser.last("error")!.code).toBe("bad_message");
    // Still exactly one win across both clients; status stays "won".
    expect(activeState(p1.last("state")!).status).toBe("won");
    expect(activeState(p2.last("state")!).status).toBe("won");

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

  test("post-win UNDO succeeds: the winning hop is popped → status playing, result null, OTHER untouched", async () => {
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
    // The mover (p1) sits on the shared meet cell; p1's trail ends with it.
    expect(won.knights.p1).toEqual(target);
    const p1PrevCell = won.visited.p1[won.visited.p1.length - 2]; // where p1 came from
    const p2VisitedBefore = JSON.stringify(won.visited.p2);
    const p2KnightBefore = JSON.stringify(won.knights.p2);

    // p1 UNDOES the winning hop. `won` is reversible: the shared cell is popped, so
    // p1 steps back off it → status returns to "playing", result null, knights no
    // longer co-located. The OTHER knight (p2) is byte-identical throughout.
    // Count-gated waits: the inbox already holds many earlier "playing" states from
    // the walk, so we must read the NEW broadcast (past the baseline), not a stale one.
    const baseCount1 = p1.states().length;
    const baseCount2 = p2.states().length;
    p1.send({ t: "undo" });
    const after = await awaitStateCount(p1, baseCount1 + 1);
    await awaitStateCount(p2, baseCount2 + 1);
    expect(after.status).toBe("playing");
    expect(after.result).toBeNull();
    expect(after.knights.p1).toEqual(p1PrevCell); // stepped back
    expect(sameCell(after.knights.p1, after.knights.p2)).toBe(false); // un-met
    expect(JSON.stringify(after.visited.p2)).toBe(p2VisitedBefore); // p2 untouched
    expect(JSON.stringify(after.knights.p2)).toBe(p2KnightBefore);
    // Both clients agree on the un-won state.
    expect(JSON.stringify(activeState(p2.last("state")!))).toBe(JSON.stringify(after));
    p1.close();
    p2.close();
  });

  test("post-win RETRY succeeds: the mover resets to its start → status playing, result null, OTHER untouched", async () => {
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
    const p2VisitedBefore = JSON.stringify(won.visited.p2);
    const p2KnightBefore = JSON.stringify(won.knights.p2);

    // p1 RETRIES from the won state: it resets to its start, off the shared square
    // → status returns to "playing", result null, knights no longer co-located.
    // The OTHER knight (p2) is byte-identical. Count-gated waits (the inbox holds
    // stale "playing" states from the walk).
    const baseCount1 = p1.states().length;
    const baseCount2 = p2.states().length;
    p1.send({ t: "retry" });
    const after = await awaitStateCount(p1, baseCount1 + 1);
    await awaitStateCount(p2, baseCount2 + 1);
    expect(after.status).toBe("playing");
    expect(after.result).toBeNull();
    expect(after.visited.p1).toEqual([init.knights.p1]); // collapsed to start
    expect(after.knights.p1).toEqual(init.knights.p1);
    expect(sameCell(after.knights.p1, after.knights.p2)).toBe(false); // un-met
    expect(JSON.stringify(after.visited.p2)).toBe(p2VisitedBefore); // p2 untouched
    expect(JSON.stringify(after.knights.p2)).toBe(p2KnightBefore);
    expect(JSON.stringify(activeState(p2.last("state")!))).toBe(JSON.stringify(after));
    p1.close();
    p2.close();
  });

  test("imperfect rendezvous → undo un-meets → status playing, result null, knights apart, play continues", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    // Drive p1 straight onto STATIONARY p2 (a premature/imperfect meet — most of
    // the board uncovered, so the win is soft, not perfect).
    const target = init.knights.p2;
    const path = bfsToAdjacent(board, init.knights.p1, target)!;
    for (const step of path) {
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    p1.send({ t: "move", cell: target });
    const won = activeState(await p1.waitFor("state", (m) => m.state.status === "won"));
    await p2.waitFor("state", (m) => m.state.status === "won");
    expect(won.result!.perfect).toBe(false); // imperfect meet
    const p1PrevCell = won.visited.p1[won.visited.p1.length - 2];

    // Undo the winning hop → un-meet. Count-gated waits (stale "playing" states
    // from the walk are already in the inbox).
    const baseCount1 = p1.states().length;
    const baseCount2 = p2.states().length;
    p1.send({ t: "undo" });
    const after = await awaitStateCount(p1, baseCount1 + 1);
    await awaitStateCount(p2, baseCount2 + 1);
    expect(after.status).toBe("playing");
    expect(after.result).toBeNull();
    expect(sameCell(after.knights.p1, after.knights.p2)).toBe(false); // no longer co-located
    expect(after.knights.p1).toEqual(p1PrevCell);

    // Play can continue: p1 makes a subsequent LEGAL move from its restored cell.
    const next = legalTarget(
      after.board,
      after.knights.p1,
      after.visited.p1,
      after.visited.p2,
      after.knights.p2,
    );
    expect(next).not.toBeNull();
    p1.send({ t: "move", cell: next! });
    const cont = await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, next!));
    expect(cont.knights.p1).toEqual(next!);
    expect(cont.status).toBe("playing");
    expect(p1.last("error")).toBeNull();
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

// ---- C5: view-solution playback + per-player hint --------------------------

// Drive a view-solution to completion on BOTH clients and return the captured
// pre-playback state, the observed playback frame count, and the restored state.
// Rooms run at KR_PLAYBACK_STEP_MS=1 (set in beforeAll), so this never waits real
// time — it asserts on the SEQUENCE of broadcasts, not on a clock.
async function runViewSolution(p1: Client, p2: Client, actor: Client) {
  const prePlayback = activeState(actor.last("state")!);
  const baseCount1 = p1.states().length;

  actor.send({ t: "viewSolution" });

  // BOTH clients must observe the playback status.
  await p1.waitFor("state", (m) => m.state.status === "playback");
  await p2.waitFor("state", (m) => m.state.status === "playback");

  // Then BOTH must observe the return to "playing" (the restore frame). Capture
  // EACH client's restored state from its own restore broadcast (reading
  // p2.last("state") right after p1's restore can race p2's restore broadcast).
  const restored1 = await p1.waitFor(
    "state",
    (m) => m.state.status === "playing" && p1.states().length > baseCount1 + 1,
  );
  const restored2 = await p2.waitFor(
    "state",
    (m) =>
      m.state.status === "playing" &&
      m.state.visited != null &&
      // The restore broadcast is the one whose trails match the pre-playback ones
      // (NOT a stale "playing" state before playback began).
      JSON.stringify(m.state.visited) === JSON.stringify(prePlayback.visited),
  );

  return {
    prePlayback,
    restored: activeState(restored1),
    restored2: activeState(restored2),
  };
}

describe("C5 view-solution + hint (real WS)", () => {
  test("viewSolution: BOTH clients see playback frames, then state RESTORES byte-equal; never won", async () => {
    const { p1, p2, init } = await activeGame();
    // Move both knights a few hops so the restore target is a NON-trivial state
    // (not just the initial position) — a regression that fails to restore would
    // leave the knights at a playback frame, not here.
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    for (let j = 1; j <= 2; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }
    p2.send({ t: "move", cell: path[last - 1] });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, path[last - 1]));

    // Capture the playback frames as they stream: collect every state with status
    // "playback" on p1. There must be MORE THAN ONE (knights advancing).
    const beforePlaybackStates = p1.states().length;
    const { prePlayback, restored, restored2 } = await runViewSolution(p1, p2, p1);

    const playbackFrames = p1
      .states()
      .slice(beforePlaybackStates)
      .filter((m) => m.state.status === "playback");
    expect(playbackFrames.length).toBeGreaterThan(1);
    // Frames actually MOVE the knights (the trails grow across frames).
    const firstFrame = playbackFrames[0].state;
    const lastFrame = playbackFrames[playbackFrames.length - 1].state;
    expect(JSON.stringify(firstFrame.knights)).not.toBe(JSON.stringify(lastFrame.knights));

    // Playback NEVER marked the puzzle solved.
    expect(playbackFrames.every((m) => m.state.status === "playback")).toBe(true);
    expect(playbackFrames.every((m) => m.state.result === null)).toBe(true);

    // After playback the state is byte-equal to the pre-playback state
    // (knights + visited + status + result) and status is "playing", NOT "won".
    expect(restored.status).toBe("playing");
    expect(restored.result).toBeNull();
    expect(JSON.stringify(restored)).toBe(JSON.stringify(prePlayback));
    // Both clients agree on the restored state (each read from its own restore).
    expect(JSON.stringify(restored2)).toBe(JSON.stringify(restored));
    p1.close();
    p2.close();
  });

  test("during playback: move/retry/undo are silent no-ops — no state change, no error, no stray frame", async () => {
    const { p1, p2, init } = await activeGame();
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);

    p1.send({ t: "viewSolution" });
    await p1.waitFor("state", (m) => m.state.status === "playback");
    await p2.waitFor("state", (m) => m.state.status === "playback");

    // While in playback, fire a move/retry/undo from BOTH players. None may error,
    // and none may inject a broadcast that isn't a playback frame. We assert: no
    // error arrives, and every state seen until the restore is a playback frame.
    const errCountBefore = p2.states().length; // (unused count anchor)
    void errCountBefore;
    p1.send({ t: "move", cell: path[1] });
    p1.send({ t: "retry" });
    p2.send({ t: "undo" });
    p2.send({ t: "move", cell: path[path.length - 2] });

    // Drive to the restore; collect everything in between.
    const restored = await p1.waitFor(
      "state",
      (m) => m.state.status === "playing" && m.state.visited != null,
    );
    await p2.waitFor("state", (m) => m.state.status === "playing");

    // No client ever received an error from the locked ops.
    expect(p1.last("error")).toBeNull();
    expect(p2.last("error")).toBeNull();

    // After restore, the state equals the (untouched) initial active state — the
    // locked ops changed nothing.
    expect(JSON.stringify(activeState(restored))).toBe(
      JSON.stringify({
        board: init.board,
        knights: init.knights,
        visited: init.visited,
        status: "playing",
        result: null,
      }),
    );
    p1.close();
    p2.close();
  });

  test("viewSolution while WON is ignored (no status flip, no frames)", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    const target = init.knights.p2;
    const bfsPath = bfsToAdjacent(board, init.knights.p1, target)!;
    for (const step of bfsPath) {
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    p1.send({ t: "move", cell: target });
    await p1.waitFor("state", (m) => m.state.status === "won");
    await p2.waitFor("state", (m) => m.state.status === "won");

    const countBefore = p1.states().length;
    p1.send({ t: "viewSolution" });
    // Give the server a round-trip: send another viewSolution (also ignored while
    // won) — neither should produce any broadcast.
    p2.send({ t: "viewSolution" });
    // A subsequent bad_message we CAN await proves the prior viewSolution messages
    // were fully processed (and ignored — `won` is not "playing", so no playback).
    p1.send({ t: "nope" } as unknown as ClientMsg);
    expect((await p1.waitFor("error", (m) => m.code === "bad_message")).code).toBe("bad_message");

    // No new state broadcast happened from the viewSolution attempts (the only new
    // states, if any, would carry status "playback" — there must be none).
    const newStates = p1.states().slice(countBefore);
    expect(newStates.every((m) => m.state.status !== "playback")).toBe(true);
    expect(activeState(p1.last("state")!).status).toBe("won");
    p1.close();
    p2.close();
  });

  test("a 2nd viewSolution mid-playback is ignored (frame sequence unbroken)", async () => {
    const { p1, p2 } = await activeGame();
    p1.send({ t: "viewSolution" });
    await p1.waitFor("state", (m) => m.state.status === "playback");
    await p2.waitFor("state", (m) => m.state.status === "playback");

    // Fire a 2nd viewSolution from the OTHER player mid-playback. It must NOT start
    // a second timer / reset the frames — playback continues to its single restore.
    p2.send({ t: "viewSolution" });

    // Exactly ONE return to playing follows; the playback completes cleanly.
    const restored = await p1.waitFor(
      "state",
      (m) => m.state.status === "playing" && m.state.visited != null,
    );
    await p2.waitFor("state", (m) => m.state.status === "playing");
    expect(activeState(restored).status).toBe("playing");
    // No error from the ignored 2nd request.
    expect(p2.last("error")).toBeNull();
    p1.close();
    p2.close();
  });

  // The board's available cells are A single knight's walk, but a DFS
  // reconstruction is not guaranteed to recover the SAME Hamiltonian path the
  // server used as its witness (other start→end covers may exist). So the hint
  // tests assert the DEFINING property of the server's path[1]/path[last-1] — a
  // legal, available, unvisited knight move from the requester's current cell that
  // is NOT the other knight — rather than equality with the reconstruction.
  function isLegalNext(init: ReturnType<typeof activeState>, from: Cell, cell: Cell): boolean {
    return (
      knightMoves(from, init.board.n).some((m) => sameCell(m, cell)) &&
      init.board.available[cell.r][cell.c] &&
      !inCells(init.visited.p1, cell) &&
      !inCells(init.visited.p2, cell) &&
      !sameCell(cell, init.knights.p1) &&
      !sameCell(cell, init.knights.p2)
    );
  }

  test("hint P1 on-prefix → a legal forward witness cell, status prefix, ACTOR-ONLY", async () => {
    const { p1, p2, init } = await activeGame();
    // P1 is at its start (len 1) → on-prefix; the hint is its witness's next cell.
    const p2HintsBefore = p2.inboxCount("hint");
    p1.send({ t: "hint" });
    const h = await p1.waitFor("hint");
    expect(h.status).toBe("prefix");
    expect(h.status === "prefix" && isLegalNext(init, init.knights.p1, h.cell)).toBe(true);
    // ACTOR-ONLY: p2 received NOTHING new on the hint channel.
    expect(p2.inboxCount("hint")).toBe(p2HintsBefore);
    expect(p2.last("hint")).toBeNull();
    p1.close();
    p2.close();
  });

  test("hint P2 on-suffix → a legal BACKWARD witness cell, status prefix, actor-only", async () => {
    const { p1, p2, init } = await activeGame();
    // P2 is at its start (len 1) → on-suffix; the hint is its witness's prev cell.
    const p1HintsBefore = p1.inboxCount("hint");
    p2.send({ t: "hint" });
    const h = await p2.waitFor("hint");
    expect(h.status).toBe("prefix");
    expect(h.status === "prefix" && isLegalNext(init, init.knights.p2, h.cell)).toBe(true);
    expect(p1.inboxCount("hint")).toBe(p1HintsBefore);
    p1.close();
    p2.close();
  });

  test("following hints walks the server's witness: P1 hint → move → hint stays on-prefix", async () => {
    const { p1, p2, init } = await activeGame();
    // Request a hint, move onto the hinted cell, request again — each must be a
    // legal "prefix" cell, proving the hint genuinely tracks the SERVER witness
    // (independent of any DFS reconstruction).
    let from = init.knights.p1;
    let visitedP1 = init.visited.p1.slice();
    for (let step = 0; step < 3; step++) {
      // Wait for a NEW hint (the inbox count must grow) — waitFor would otherwise
      // resolve immediately with a STALE earlier hint already in the inbox.
      const before = p1.inboxCount("hint");
      p1.send({ t: "hint" });
      await p1.waitFor("hint", () => p1.inboxCount("hint") > before, 2500);
      const h = p1.last("hint")!;
      expect(h.status).toBe("prefix");
      if (h.status !== "prefix") break;
      const cell = h.cell;
      // Legal knight move from current, available, unvisited by either trail.
      expect(knightMoves(from, init.board.n).some((m) => sameCell(m, cell))).toBe(true);
      expect(init.board.available[cell.r][cell.c]).toBe(true);
      expect(inCells(visitedP1, cell)).toBe(false);
      p1.send({ t: "move", cell });
      const after = await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, cell));
      from = after.knights.p1;
      visitedP1 = after.visited.p1.slice();
    }
    p1.close();
    p2.close();
  });

  test("hint after diverging from the witness → off_path (cell null)", async () => {
    const { p1, p2, init } = await activeGame();
    // Learn the SERVER witness's first cell from the hint itself (a DFS
    // reconstruction is not guaranteed to recover the same path), then move P1 to a
    // DIFFERENT legal first cell — that genuinely diverges from the witness.
    p1.send({ t: "hint" });
    const h0 = await p1.waitFor("hint");
    expect(h0.status).toBe("prefix");
    const witnessNext = h0.status === "prefix" ? h0.cell : null;
    const off = knightMoves(init.knights.p1, init.board.n).find(
      (m) =>
        init.board.available[m.r][m.c] &&
        !inCells(init.visited.p1, m) &&
        !inCells(init.visited.p2, m) &&
        !sameCell(m, init.knights.p2) &&
        witnessNext != null &&
        !sameCell(m, witnessNext),
    );
    // Some boards may force the witness as the only legal first move; skip the
    // divergence assertion only in that (rare) case but still exercise the path.
    if (off) {
      const before = p1.inboxCount("hint");
      p1.send({ t: "move", cell: off });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, off));
      p1.send({ t: "hint" });
      await p1.waitFor("hint", () => p1.inboxCount("hint") > before);
      const h = p1.last("hint")!;
      expect(h.status).toBe("off_path");
      expect(h.status === "off_path" && h.cell).toBeNull();
    }
    p1.close();
    p2.close();
  });

  test("hint while WON or during PLAYBACK sends nothing", async () => {
    // ---- while won ----
    {
      const { p1, p2, init } = await activeGame();
      const board = init.board;
      const target = init.knights.p2;
      const bfsPath = bfsToAdjacent(board, init.knights.p1, target)!;
      for (const step of bfsPath) {
        p1.send({ t: "move", cell: step });
        await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
      }
      p1.send({ t: "move", cell: target });
      await p1.waitFor("state", (m) => m.state.status === "won");
      await p2.waitFor("state", (m) => m.state.status === "won");

      const hintsBefore = p1.inboxCount("hint");
      p1.send({ t: "hint" });
      // Prove the hint was processed-and-ignored: a following bad_message we can
      // await comes back (a post-win move is now a silent no-op, not an error).
      p1.send({ t: "nope" } as unknown as ClientMsg);
      await p1.waitFor("error", (m) => m.code === "bad_message");
      expect(p1.inboxCount("hint")).toBe(hintsBefore);
      p1.close();
      p2.close();
    }
    // ---- during playback ----
    {
      const { p1, p2 } = await activeGame();
      p1.send({ t: "viewSolution" });
      await p1.waitFor("state", (m) => m.state.status === "playback");
      const hintsBefore = p1.inboxCount("hint");
      p1.send({ t: "hint" });
      // Drive to the restore; the hint must have produced no `hint` message.
      await p1.waitFor("state", (m) => m.state.status === "playing" && m.state.visited != null);
      expect(p1.inboxCount("hint")).toBe(hintsBefore);
      p1.close();
      p2.close();
    }
  });

  test("leave mid-playback: room torn down, playback timer canceled, no late broadcasts / no crash", async () => {
    const { p1, p2 } = await activeGame();
    p1.send({ t: "viewSolution" });
    await p1.waitFor("state", (m) => m.state.status === "playback");
    await p2.waitFor("state", (m) => m.state.status === "playback");

    // p1 leaves mid-playback. p2 must be notified the opponent left, and NO further
    // playback frames may arrive after that (the timer is canceled in teardown).
    p1.send({ t: "leave" });
    await p2.waitFor("opponentLeft");
    const countAtLeave = p2.states().length;

    // Wait a handful of would-be frame intervals worth of round-trips by pinging
    // the server (a bad_message ping we can await) — no new `state` may arrive.
    p2.send({ t: "nope" } as unknown as ClientMsg);
    await p2.waitFor("error", (m) => m.code === "bad_message");
    expect(p2.states().length).toBe(countAtLeave);
    p1.close();
    p2.close();
  });

  test("the witness path NEVER leaks across playback frames OR the hint message", async () => {
    const { p1, p2, init } = await activeGame();

    // Hint (prefix), then a full playback. Guard EVERY message on both clients.
    p1.send({ t: "hint" });
    const h = await p1.waitFor("hint");
    p1.send({ t: "viewSolution" });
    await p1.waitFor("state", (m) => m.state.status === "playback");
    await p1.waitFor("state", (m) => m.state.status === "playing" && m.state.visited != null);
    await p2.waitFor("state", (m) => m.state.status === "playing" && m.state.visited != null);

    // No serialized message on EITHER client contains a raw "path" field — covers
    // playback frames AND the actor-only hint.
    const noPath = (c: Client) =>
      c.allMessages().every((m) => !JSON.stringify(m).includes('"path"'));
    expect(noPath(p1)).toBe(true);
    expect(noPath(p2)).toBe(true);
    // Sanity: the hint projects a SINGLE next cell (a legal first move), not the
    // whole path — and the off_path branch never carries a cell either.
    expect(h.status).toBe("prefix");
    expect(h.status === "prefix" && isLegalNext(init, init.knights.p1, h.cell)).toBe(true);
    p1.close();
    p2.close();
  });
});

// ---- C6: new puzzle (room-wide reset) --------------------------------------

describe("C6 newPuzzle (real WS)", () => {
  // Assert a fresh board is fully reset and BYTE-IDENTICAL across the two clients.
  // We deliberately do NOT assert the new seed differs from the previous one —
  // randomSeed can repeat — only that the two clients agree and everything reset.
  function assertFreshAndIdentical(
    s1: ReturnType<typeof activeState>,
    s2: ReturnType<typeof activeState>,
  ) {
    // Byte-identical across the two clients (seed/available/start/end via board,
    // plus knights + visited).
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
    // Full reset: a fresh playing board with no result.
    expect(s1.status).toBe("playing");
    expect(s1.result).toBeNull();
    // Knights back on the endpoints, trails back to the singleton starts.
    expect(s1.knights.p1).toEqual(s1.board.start);
    expect(s1.knights.p2).toEqual(s1.board.end);
    expect(s1.visited.p1).toEqual([s1.board.start]);
    expect(s1.visited.p2).toEqual([s1.board.end]);
    // Optional soft check: the broadcast board EQUALS generatePuzzle for its own
    // seed (proves genuine regeneration, not a stale board). steps echoes config.
    const regen = generatePuzzle(s1.board.n, s1.board.steps, s1.board.seed);
    expect(s1.board.available).toEqual(regen.available.map((row) => row.slice()));
    expect(s1.board.start).toEqual({ r: regen.start.r, c: regen.start.c });
    expect(s1.board.end).toEqual({ r: regen.end.r, c: regen.end.c });
  }

  test("newPuzzle while playing → both clients get a NEW identical board, fully reset", async () => {
    const { p1, p2, init } = await activeGame();
    // Move both knights so the pre-reset state is non-trivial.
    const path = reconstructPath(init.board, init.knights.p1, init.knights.p2);
    const last = path.length - 1;
    for (let j = 1; j <= 2; j++) {
      p1.send({ t: "move", cell: path[j] });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, path[j]));
    }
    p2.send({ t: "move", cell: path[last - 1] });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p2, path[last - 1]));

    // newPuzzle broadcasts exactly ONE fresh state per client. Wait for the count
    // to tick up, then read each client's LATEST state (the reset). We read last()
    // rather than a content predicate because randomSeed can repeat, so the new
    // board is not guaranteed to differ from the old by any single field.
    const baseCount1 = p1.states().length;
    const baseCount2 = p2.states().length;
    p1.send({ t: "newPuzzle" });
    const r1 = await awaitStateCount(p1, baseCount1 + 1);
    const r2 = await awaitStateCount(p2, baseCount2 + 1);
    assertFreshAndIdentical(r1, r2);
    p1.close();
    p2.close();
  });

  test("newPuzzle with explicit n/steps → both clients get a board of that size, identical, fully reset", async () => {
    const { p1, p2 } = await activeGame();
    const before1 = p1.states().length;
    const before2 = p2.states().length;
    // A different, in-range size from the default (n=6, steps=18): n=5 → maxSteps 24.
    p1.send({ t: "newPuzzle", n: 5, steps: 10 });
    const r1 = await awaitStateCount(p1, before1 + 1);
    const r2 = await awaitStateCount(p2, before2 + 1);
    // The board carries the chosen n/steps, identical across clients, fully reset.
    expect(r1.board.n).toBe(5);
    expect(r1.board.steps).toBe(10);
    assertFreshAndIdentical(r1, r2);
    p1.close();
    p2.close();
  });

  test("newPuzzle CLAMPS out-of-range n/steps server-side (never trusts the client)", async () => {
    const { p1, p2 } = await activeGame();

    // (a) n=99, steps=999 → n clamps to MAX_N (9), steps clamps to maxSteps(9)=80.
    {
      const before1 = p1.states().length;
      const before2 = p2.states().length;
      p1.send({ t: "newPuzzle", n: 99, steps: 999 });
      const r1 = await awaitStateCount(p1, before1 + 1);
      const r2 = await awaitStateCount(p2, before2 + 1);
      expect(r1.board.n).toBe(9);
      expect(r1.board.steps).toBe(9 * 9 - 1); // 80
      assertFreshAndIdentical(r1, r2);
    }

    // (b) n=1 → clamps to MIN_N (4); a tiny steps clamps up to MIN_STEPS (3).
    {
      const before1 = p1.states().length;
      const before2 = p2.states().length;
      p1.send({ t: "newPuzzle", n: 1, steps: 1 });
      const r1 = await awaitStateCount(p1, before1 + 1);
      const r2 = await awaitStateCount(p2, before2 + 1);
      expect(r1.board.n).toBe(4);
      expect(r1.board.steps).toBe(3); // MIN_STEPS
      assertFreshAndIdentical(r1, r2);
    }

    p1.close();
    p2.close();
  });

  test("newPuzzle with non-integer n/steps is ignored → falls back to defaults", async () => {
    const { p1, p2 } = await activeGame();
    const before1 = p1.states().length;
    const before2 = p2.states().length;
    // Non-integer values are dropped by the envelope validator → server defaults
    // (BOARD_N=6, BOARD_STEPS=18).
    p1.send({ t: "newPuzzle", n: 5.5, steps: "big" } as unknown as ClientMsg);
    const r1 = await awaitStateCount(p1, before1 + 1);
    const r2 = await awaitStateCount(p2, before2 + 1);
    expect(r1.board.n).toBe(6);
    expect(r1.board.steps).toBe(18);
    assertFreshAndIdentical(r1, r2);
    p1.close();
    p2.close();
  });

  test('the witness path NEVER leaks after a PARAMETERIZED newPuzzle: no "path" on the wire', async () => {
    const { p1, p2 } = await activeGame();
    const before1 = p1.states().length;
    const before2 = p2.states().length;
    p1.send({ t: "newPuzzle", n: 7, steps: 20 });
    await awaitStateCount(p1, before1 + 1);
    await awaitStateCount(p2, before2 + 1);
    const noPath = (c: Client) =>
      c.allMessages().every((m) => !JSON.stringify(m).includes('"path"'));
    expect(noPath(p1)).toBe(true);
    expect(noPath(p2)).toBe(true);
    p1.close();
    p2.close();
  });

  test("newPuzzle DURING playback → playback canceled (no late frames) and reset to a fresh playing board", async () => {
    const { p1, p2 } = await activeGame();
    p1.send({ t: "viewSolution" });
    await p1.waitFor("state", (m) => m.state.status === "playback");
    await p2.waitFor("state", (m) => m.state.status === "playback");

    // Reset mid-playback. The Room clears the playback timer FIRST (so no frame
    // fires AFTER the reset), then swaps in a fresh game → the reset broadcast is
    // "playing". A stray playback frame (KR_PLAYBACK_STEP_MS=1) can still arrive
    // BEFORE the reset is processed, so we don't key on "exactly +1"; instead we
    // wait until each client's LATEST state is "playing" with a NEW broadcast past
    // the reset send. Once playback is canceled the newest state stays "playing".
    const beforeReset1 = p1.states().length;
    const beforeReset2 = p2.states().length;
    p1.send({ t: "newPuzzle" });
    await p1.waitFor(
      "state",
      () =>
        p1.states().length > beforeReset1 && activeState(p1.last("state")!).status === "playing",
    );
    await p2.waitFor(
      "state",
      () =>
        p2.states().length > beforeReset2 && activeState(p2.last("state")!).status === "playing",
    );
    const r1 = activeState(p1.last("state")!);
    const r2 = activeState(p2.last("state")!);
    expect(r1.status).toBe("playing");
    expect(r2.status).toBe("playing");
    assertFreshAndIdentical(r1, r2);

    // No LATE playback frame may arrive after the reset (the timer was canceled).
    // Prove the reset broadcast was fully processed, then assert no "playback"
    // state appears afterward. We ping with a bad_message we can await, then check.
    const countAfterReset = p1.states().length;
    p1.send({ t: "nope" } as unknown as ClientMsg);
    await p1.waitFor("error", (m) => m.code === "bad_message");
    const tail = p1.states().slice(countAfterReset);
    expect(tail.every((m) => m.state.status !== "playback")).toBe(true);
    expect(activeState(p1.last("state")!).status).toBe("playing");
    p1.close();
    p2.close();
  });

  test("newPuzzle AFTER a win → resets to a fresh playing board on both clients", async () => {
    const { p1, p2, init } = await activeGame();
    const board = init.board;
    // Drive p1 onto stationary p2 → rendezvous win.
    const target = init.knights.p2;
    const bfsPath = bfsToAdjacent(board, init.knights.p1, target)!;
    for (const step of bfsPath) {
      p1.send({ t: "move", cell: step });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, step));
    }
    p1.send({ t: "move", cell: target });
    await p1.waitFor("state", (m) => m.state.status === "won");
    await p2.waitFor("state", (m) => m.state.status === "won");

    // newPuzzle is NOT win-gated (it is a reset): from the win screen it resets.
    // One fresh broadcast per client; read each client's latest.
    const before1 = p1.states().length;
    const before2 = p2.states().length;
    p2.send({ t: "newPuzzle" });
    const r1 = await awaitStateCount(p1, before1 + 1);
    const r2 = await awaitStateCount(p2, before2 + 1);
    expect(r1.status).toBe("playing");
    expect(r1.result).toBeNull();
    assertFreshAndIdentical(r1, r2);
    // No error came back for the reset request.
    expect(p2.last("error")).toBeNull();
    p1.close();
    p2.close();
  });

  test('the witness path NEVER leaks across a newPuzzle round-trip: no "path" in any message', async () => {
    const { p1, p2, init } = await activeGame();
    // A couple of moves, then a reset, then another move on the fresh board.
    const t1 = legalTarget(
      init.board,
      init.knights.p1,
      init.visited.p1,
      init.visited.p2,
      init.knights.p2,
    )!;
    p1.send({ t: "move", cell: t1 });
    await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t1));

    const before1 = p1.states().length;
    const before2 = p2.states().length;
    p1.send({ t: "newPuzzle" });
    const fs = await awaitStateCount(p1, before1 + 1);
    await awaitStateCount(p2, before2 + 1);
    expect(fs.status).toBe("playing");
    expect(fs.visited.p1.length).toBe(1);

    // A legal move on the NEW board (uses the fresh board/knights).
    const t2 = legalTarget(fs.board, fs.knights.p1, fs.visited.p1, fs.visited.p2, fs.knights.p2);
    if (t2) {
      p1.send({ t: "move", cell: t2 });
      await awaitMoveApplied(p1, p2, (v) => inCells(v.p1, t2));
    }

    // No serialized message on EITHER client contains a raw "path" field.
    const noPath = (c: Client) =>
      c.allMessages().every((m) => !JSON.stringify(m).includes('"path"'));
    expect(noPath(p1)).toBe(true);
    expect(noPath(p2)).toBe(true);
    p1.close();
    p2.close();
  });
});
