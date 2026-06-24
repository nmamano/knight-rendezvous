// Authoritative game state for one room. Fresh for Knight Rendezvous — NOT a
// port of chess's turn-based Match. It holds the generated puzzle, the two knight
// positions, and each knight's trail. C2 added independent (non-turn-based)
// movement; C3 adds rendezvous (same-square win) detection + win status; C4 added
// per-player retry/undo; C5 adds room-wide view-solution PLAYBACK (a reversible
// `playback` status) and a per-player, actor-only witness hint.
//
// The server is the only oracle: it generates the puzzle ONCE per room from a
// random seed and projects a client-facing Board snapshot. The witness `path`
// stays inside the Puzzle and is NEVER projected onto the wire — view-solution
// drives animation via server frames (the live knights/visited mutate per frame)
// and a hint projects only the SINGLE next witness cell, never the whole path.

import { generatePuzzle, knightMoves, type Cell, type Puzzle } from "../shared/engine";
import { BOARD_N, BOARD_STEPS, PLAYBACK_STEP_MS, clampN, clampSteps } from "../shared/config";
import type { Board, ColorToken, PlayerId, PlayerView, RoomSnapshot } from "../shared/protocol";

// The win projection: `status` flips to "won" on the rendezvous hop, and
// `result` (null while playing) then carries soft-vs-perfect + where they met.
type GameStatus = RoomSnapshot["status"];
type GameResult = RoomSnapshot["result"];

export interface GamePlayer {
  id: PlayerId;
  name: string;
  connected: boolean;
}

// Discriminated result for a move attempt, mirroring chess's Match.move →
// Room.move contract (an ActionResult). On failure, the room sends the error to
// the ACTOR only; on success, it broadcasts the new state. The failure `code` is
// `illegal_move` for a rule violation and `game_over` once the rendezvous has
// already happened (the post-win guard, check (0)).
export interface MoveError {
  code: "illegal_move" | "game_over";
  message: string;
}
// A move/retry/undo attempt resolves to one of THREE outcomes for the Room:
//   { ok: true }                 → broadcast the new state.
//   { ok: false, error }         → send the error to the ACTOR only.
//   { ok: true, silent: true }   → do NOTHING (no broadcast, no error). Used by
//                                  the playback guard: while a view-solution is
//                                  animating, a stray move must NOT inject a frame
//                                  into the playback stream nor surface an error.
export type MoveResult =
  | { ok: true; silent?: false }
  | { ok: true; silent: true }
  | { ok: false; error: MoveError };

function fail(message: string): MoveResult {
  return { ok: false, error: { code: "illegal_move", message } };
}

function gameOver(message: string): MoveResult {
  return { ok: false, error: { code: "game_over", message } };
}

// The silent no-op result: the op was swallowed (playback in progress) with no
// state change, no broadcast, and no error to the actor.
function silentNoop(): MoveResult {
  return { ok: true, silent: true };
}

// One playback frame = a full snapshot of the LIVE mutable game fields the wire
// projects (knights + visited). The Room ticks through the ordered frame list on
// its timer, applying each onto the live fields and broadcasting. Cloned cells —
// the same no-leak discipline as every other projection — so a frame can never
// alias engine-owned state.
export interface PlaybackFrame {
  knights: { p1: Cell; p2: Cell };
  visited: { p1: Cell[]; p2: Cell[] };
}

// The deep-cloned pre-playback state, saved on viewSolution() and restored
// verbatim when playback ends — so view-solution returns the game to EXACTLY its
// prior state and NEVER marks the puzzle solved (locked decision 7).
interface SavedState {
  knights: { p1: Cell; p2: Cell };
  visited: { p1: Cell[]; p2: Cell[] };
  status: GameStatus;
  result: GameResult;
}

// What viewSolution() hands back to the Room. `entered:false` means the request
// was a no-op (not "playing"): the Room broadcasts nothing and starts no timer.
// `entered:true` carries the ordered frames for the Room to drive on its timer.
export type ViewSolutionResult = { entered: false } | { entered: true; frames: PlaybackFrame[] };

// The actor-only hint result (locked decision 7). `null` is the "no hint"
// sentinel (status not "playing") the Room turns into NOTHING sent. Otherwise it
// mirrors the `hint` ServerMsg: a single forward/backward witness cell or
// off_path. The raw `path` is never exposed — only this single next cell.
export type HintResult =
  | null
  | { status: "prefix"; cell: Cell }
  | { status: "off_path"; cell: null };

function cloneCell(c: Cell): Cell {
  return { r: c.r, c: c.c };
}

const otherPid = (pid: PlayerId): PlayerId => (pid === "p1" ? "p2" : "p1");

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

// Distinct knight + trail colors. p1 = amber, p2 = violet (locked decision 3).
export function colorOf(pid: PlayerId): ColorToken {
  return pid === "p1" ? "amber" : "violet";
}

// Server-only seed source. Math.random is fine HERE (never in shared/): the seed
// is the single nondeterministic input, and it is broadcast so both clients
// reproduce the identical board.
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

export class Game {
  readonly puzzle: Puzzle;
  // The path length (knight MOVES) this board was generated with, CLAMPED into
  // [MIN_STEPS, maxSteps(n)]. Stored separately because the engine's Puzzle does
  // not carry `steps`; board() projects it so both clients echo the same value
  // (and the sliders can initialize from it).
  readonly steps: number;
  // Knight positions. p1 starts on the puzzle start, p2 on the end (locked
  // decision 3). In C1 they never move; C2 will mutate these on validated hops.
  readonly knights: { p1: Cell; p2: Cell };
  // Each knight's trail (ordered visited squares, including its start). Seeded
  // here so C2's movement/sync has the structure ready; unused in C1 rendering.
  readonly visited: { p1: Cell[]; p2: Cell[] };
  // Status. "playing" until the rendezvous hop flips it to "won" (forever — there
  // is no un-winning), OR until a view-solution flips it to "playback" (C5). Unlike
  // "won", "playback" is REVERSIBLE: it returns to "playing" when playback ends
  // (locked decision 7 — view-solution never marks the puzzle solved). `result`
  // stays null until a win, then carries soft-vs-perfect + the shared meeting cell;
  // it is never set during playback.
  status: GameStatus = "playing";
  result: GameResult = null;

  // The deep-cloned pre-playback state, populated only while status === "playback"
  // and consumed (then cleared) by restore(). null whenever not in playback.
  private saved: SavedState | null = null;

  // Per-frame playback interval the Room drives playback on. A normal watchable
  // pace by default; tests/smoke inject a small value so they never wait real time.
  readonly stepMs: number;

  constructor(
    readonly players: { p1: GamePlayer; p2: GamePlayer },
    seed: number = randomSeed(),
    stepMs: number = PLAYBACK_STEP_MS,
    // Requested board size + path length. Default to the first-board params; the
    // server CLAMPS both before generating (never trusts the caller's range).
    n: number = BOARD_N,
    steps: number = BOARD_STEPS,
  ) {
    // Clamp n FIRST, then steps against the clamped n (steps' upper bound is
    // maxSteps(n) = n*n-1). Mirrors knights-puzzle's customSettings discipline.
    const cn = clampN(n);
    const cSteps = clampSteps(cn, steps);
    this.steps = cSteps;
    this.puzzle = generatePuzzle(cn, cSteps, seed);
    const start: Cell = { r: this.puzzle.start.r, c: this.puzzle.start.c };
    const end: Cell = { r: this.puzzle.end.r, c: this.puzzle.end.c };
    this.knights = { p1: start, p2: end };
    this.visited = { p1: [{ ...start }], p2: [{ ...end }] };
    this.stepMs = stepMs;
  }

  colorOf(pid: PlayerId): ColorToken {
    return colorOf(pid);
  }

  /**
   * Attempt to hop `pid`'s OWN knight to `cell`. Not turn-based: either player
   * may call this at any time. The room is single-threaded, so concurrent moves
   * are serialized here — first valid wins, a now-illegal follow-up errors.
   *
   * Validation runs in a fixed order; crucially we bounds-check `cell` BEFORE
   * indexing `available`, so a malformed/off-board target is a clean
   * `illegal_move`, never a crash:
   *   (0) POST-WIN GUARD (first, unconditional): if already `won`, short-circuit
   *       with `game_over`. No move may follow the rendezvous.
   *   (a) `cell` is a legal knight move from this knight's CURRENT cell;
   *   (b) `cell` is in-bounds AND available[r][c] is true;
   *   (W) RENDEZVOUS WIN-CHECK: if `cell` is the OTHER knight's CURRENT cell, this
   *       hop IS the win (locked decision 1) — the SOLE allowed exception to
   *       no-reuse. It runs BEFORE (c) precisely because the partner's cell is the
   *       last entry of its own trail, so (c) would otherwise reject it. We append
   *       `cell` to visited[pid] and set knights[pid] = cell (keeping the
   *       invariant `knights.pX === visited.pX[last]`; the two knights now share
   *       that one square), flip status to "won", and compute `perfect`.
   *   (c) `cell` is not in union(visited.p1, visited.p2) (no-reuse spans both).
   *
   * The old C2 check (d) ("cannot land on the OTHER knight") is GONE: (W) now
   * handles the partner's cell as the win, and that is the only no-reuse exception.
   *
   * On a non-win success: push `cell` onto visited[pid] and set knights[pid].
   */
  move(pid: PlayerId, cell: Cell): MoveResult {
    const n = this.puzzle.n;
    const current = this.knights[pid];

    // (P) PLAYBACK guard — silent no-op. While a view-solution is animating, all
    // three mutators (move/retry/undo) are locked (locked decision 7). We swallow
    // the op WITHOUT broadcasting so it cannot inject a stray frame into the
    // playback stream, and WITHOUT an error (the UI already disables inputs).
    if (this.status === "playback") {
      return silentNoop();
    }

    // (0) post-win guard FIRST — unconditional short-circuit. Once the rendezvous
    // has happened the game is over; no further move is accepted from either side.
    if (this.status === "won") {
      return gameOver("The game is over.");
    }

    // (a) legal knight move from the current cell.
    const reachable = knightMoves(current, n);
    if (!reachable.some((m) => sameCell(m, cell))) {
      return fail("That is not a knight move from your current square.");
    }

    // (b) in-bounds AND available. BOUNDS FIRST — never index `available` with an
    // out-of-range cell. (knightMoves already keeps cells in-bounds, but this
    // guard is independent and defensive.)
    if (cell.r < 0 || cell.r >= n || cell.c < 0 || cell.c >= n) {
      return fail("That square is off the board.");
    }
    if (!this.puzzle.available[cell.r][cell.c]) {
      return fail("That square is not part of the board.");
    }

    // (W) rendezvous win-check — AFTER (a)/(b), BEFORE (c). Landing on the OTHER
    // knight's CURRENT cell is the win (the one allowed shared square). Must beat
    // (c), which would otherwise reject the partner's cell as already visited.
    if (sameCell(cell, this.knights[otherPid(pid)])) {
      this.visited[pid].push({ r: cell.r, c: cell.c });
      this.knights[pid] = { r: cell.r, c: cell.c };
      this.status = "won";
      // Perfect = every playable square is covered by ≥1 trail. Count DISTINCT
      // cells across both trails (keyed r*n+c, NOT Board.tsx's r*1000+c) and
      // compare to the number of available-true cells (counted inline so the
      // engine's public surface is untouched).
      const covered = new Set<number>();
      for (const v of this.visited.p1) covered.add(v.r * n + v.c);
      for (const v of this.visited.p2) covered.add(v.r * n + v.c);
      let availableCells = 0;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (this.puzzle.available[r][c]) availableCells++;
        }
      }
      const perfect = covered.size === availableCells;
      this.result = { perfect, meetCell: { r: cell.r, c: cell.c } };
      return { ok: true };
    }

    // (c) not already visited by EITHER knight (no-reuse spans both trails). The
    // rendezvous hop (W) above is the only square this rule does not guard.
    const visitedByEither = (c: Cell): boolean =>
      this.visited.p1.some((v) => sameCell(v, c)) || this.visited.p2.some((v) => sameCell(v, c));
    if (visitedByEither(cell)) {
      return fail("That square has already been visited.");
    }

    this.visited[pid].push({ r: cell.r, c: cell.c });
    this.knights[pid] = { r: cell.r, c: cell.c };
    return { ok: true };
  }

  /**
   * Reset ONLY `pid`'s OWN knight to its start, freeing its entire trail (locked
   * decision 6). NEVER touches the other player's visited/knight. Truncates
   * visited[pid] to just its first cell (p1 = puzzle.start, p2 = puzzle.end) and
   * snaps knights[pid] back to it, preserving the invariant
   * knights.pX === visited.pX[last]. Idempotent when already at the start.
   *
   * Freed cells correctly become legal again for EITHER knight — the no-reuse
   * union (move check (c)) recomputes from the LIVE trails, so there is nothing
   * else to update here.
   */
  retry(pid: PlayerId): MoveResult {
    // Playback-locked (silent no-op): inputs are locked during view-solution
    // playback (locked decision 7); swallow without broadcasting an extra frame.
    if (this.status === "playback") {
      return silentNoop();
    }
    // Win-blocked: retry is an in-play affordance only (locked decision 6). Since
    // it can only run while playing, status/result are already "playing"/null —
    // intentionally NOT reset here (no dead status="playing"/result=null writes).
    if (this.status === "won") {
      return gameOver("The game is over.");
    }
    const start = this.visited[pid][0];
    this.visited[pid] = [start];
    // CLONE the start cell so knights[pid] is not an alias of visited[pid][0].
    this.knights[pid] = { r: start.r, c: start.c };
    return { ok: true };
  }

  /**
   * Pop ONLY `pid`'s OWN last move (locked decision 6). NEVER touches the other
   * player's visited/knight. If the knight is already at its start
   * (visited[pid].length <= 1) this is a benign no-op (ok, NO mutation). Else it
   * pops the last visited cell and snaps knights[pid] to the new last cell,
   * preserving the invariant knights.pX === visited.pX[last].
   *
   * The vacated cell becomes legal again for EITHER knight via the same live-trail
   * no-reuse recompute as retry — nothing else to update.
   */
  undo(pid: PlayerId): MoveResult {
    // Playback-locked (silent no-op): same as move/retry — inputs are locked
    // during view-solution playback (locked decision 7).
    if (this.status === "playback") {
      return silentNoop();
    }
    // Win-blocked, same reasoning as retry: status/result are already
    // "playing"/null when this runs — intentionally NOT reset here.
    if (this.status === "won") {
      return gameOver("The game is over.");
    }
    if (this.visited[pid].length <= 1) {
      return { ok: true }; // already at start — benign no-op, no mutation
    }
    this.visited[pid].pop();
    const last = this.visited[pid][this.visited[pid].length - 1];
    // CLONE the new last cell so knights[pid] is not an alias of the trail entry.
    this.knights[pid] = { r: last.r, c: last.c };
    return { ok: true };
  }

  // ---- C5: view-solution playback + per-player hint ---------------------

  /** True while a view-solution animation is in progress. */
  inPlayback(): boolean {
    return this.status === "playback";
  }

  /**
   * Enter view-solution PLAYBACK (locked decision 7). Triggered by ONE player but
   * room-wide: both knights animate along the witness toward the rendezvous.
   *
   * The SINGLE guard `status !== "playing"` blocks BOTH "during won" AND "second
   * playback" (and "while waiting"): if we are not cleanly playing, this is a
   * no-op the Room turns into nothing ({ entered: false }).
   *
   * Otherwise we DEEP-CLONE and SAVE the live state ({knights, visited, status,
   * result}), flip status to "playback", and compute canonical frames from
   * `puzzle.path` (NOT a re-derivation). The frames mutate the LIVE knights/visited
   * fields as the Room ticks them (so the snapshot + reconnect reflect the current
   * frame). status is NEVER set to "won" by playback — even the rendezvous frame
   * only co-locates the two knights; restore() returns to "playing".
   */
  viewSolution(): ViewSolutionResult {
    if (this.status !== "playing") return { entered: false };

    this.saved = {
      knights: { p1: cloneCell(this.knights.p1), p2: cloneCell(this.knights.p2) },
      visited: {
        p1: this.visited.p1.map(cloneCell),
        p2: this.visited.p2.map(cloneCell),
      },
      status: this.status,
      result:
        this.result === null ? null : { ...this.result, meetCell: cloneCell(this.result.meetCell) },
    };
    this.status = "playback";
    return { entered: true, frames: this.buildFrames() };
  }

  /**
   * Apply one playback frame onto the LIVE fields. The Room calls this per tick so
   * the snapshot (and any mid-playback reconnect) reflects the current frame —
   * there is NO separate frame buffer the snapshot can't see. Cells are cloned so
   * the live arrays never alias the frame list. No-op once playback has ended
   * (defensive against a late tick after teardown/restore).
   */
  applyFrame(frame: PlaybackFrame): void {
    if (this.status !== "playback") return;
    // Mutate the existing (readonly-typed) field objects IN PLACE — never reassign
    // the field — so the C2–C4 in-place discipline (push/pop/truncate) is unbroken.
    this.knights.p1 = cloneCell(frame.knights.p1);
    this.knights.p2 = cloneCell(frame.knights.p2);
    this.visited.p1 = frame.visited.p1.map(cloneCell);
    this.visited.p2 = frame.visited.p2.map(cloneCell);
  }

  /**
   * Restore the saved pre-playback state and return to "playing" (locked decision
   * 7: view-solution returns the game to EXACTLY its prior state and NEVER marks
   * it solved). Overwrites the live fields from the deep-clone. IDEMPOTENT and a
   * NO-OP if not currently in playback (no saved state) — so a late tick or a
   * double restore (e.g. teardown racing the final tick) cannot corrupt state.
   */
  restore(): void {
    if (this.status !== "playback" || !this.saved) return;
    const s = this.saved;
    // Mutate field objects in place (same reason as applyFrame): the fields are
    // readonly-typed; their contents are overwritten from the deep-clone.
    this.knights.p1 = cloneCell(s.knights.p1);
    this.knights.p2 = cloneCell(s.knights.p2);
    this.visited.p1 = s.visited.p1.map(cloneCell);
    this.visited.p2 = s.visited.p2.map(cloneCell);
    this.result =
      s.result === null ? null : { ...s.result, meetCell: cloneCell(s.result.meetCell) };
    this.status = s.status; // back to "playing"
    this.saved = null;
  }

  /**
   * Canonical playback frames from the witness `puzzle.path` (NOT a re-derivation,
   * and deliberately NOT C3's win-path code, which flips status to "won").
   *
   * Split at the midpoint k exactly like the tests' convergeMidpoint: P1 walks the
   * forward prefix path[0..k]; P2 walks the backward suffix path[last..k+1]. The
   * two halves are disjoint and together cover every cell. The FINAL frame hops P1
   * path[k] → path[k+1] so BOTH knights end on the SAME cell (path[k+1]) — the
   * rendezvous geometry — WITHOUT setting status "won".
   *
   * Each frame is a full {knights, visited} snapshot with growing trails. Frame 0
   * is the reset state (both knights at their starts) so playback reads cleanly
   * from the beginning regardless of where the live trails were when triggered.
   */
  private buildFrames(): PlaybackFrame[] {
    const path = this.puzzle.path;
    const last = path.length - 1;
    const k = Math.floor(path.length / 2);

    const frames: PlaybackFrame[] = [];
    // p1Len / p2Len are how many cells of each half are currently revealed.
    // p1 reveals path[0..p1Len-1]; p2 reveals path[last..last-(p2Len-1)].
    const emit = (p1Len: number, p2Len: number): void => {
      const p1Trail = path.slice(0, p1Len).map(cloneCell);
      const p2Trail: Cell[] = [];
      for (let j = 0; j < p2Len; j++) p2Trail.push(cloneCell(path[last - j]));
      frames.push({
        knights: {
          p1: cloneCell(p1Trail[p1Trail.length - 1]),
          p2: cloneCell(p2Trail[p2Trail.length - 1]),
        },
        visited: { p1: p1Trail, p2: p2Trail },
      });
    };

    // Frame 0: reset — both knights on their starts.
    emit(1, 1);
    // P1 walks forward path[1..k]; P2 holds at its start (path[last]).
    for (let i = 1; i <= k; i++) emit(i + 1, 1);
    // P2 walks backward path[last-1..k+1]; P1 holds at path[k].
    // p2 reveals down to path[k+1], i.e. (last - (k+1)) extra cells beyond its start.
    const p2FullLen = last - k; // cells path[last..k+1]
    for (let m = 2; m <= p2FullLen; m++) emit(k + 1, m);
    // FINAL frame: P1 hops path[k] → path[k+1] (onto P2) — both on path[k+1].
    // P1's trail becomes path[0..k] plus path[k+1] (the shared rendezvous cell).
    {
      const p1Trail = path.slice(0, k + 1).map(cloneCell);
      p1Trail.push(cloneCell(path[k + 1]));
      const p2Trail: Cell[] = [];
      for (let j = 0; j < p2FullLen; j++) p2Trail.push(cloneCell(path[last - j]));
      frames.push({
        knights: {
          p1: cloneCell(path[k + 1]),
          p2: cloneCell(path[k + 1]),
        },
        visited: { p1: p1Trail, p2: p2Trail },
      });
    }
    return frames;
  }

  /**
   * A per-player, witness-only hint (locked decision 7) — NEW logic, not a literal
   * analysis.ts port. Points the REQUESTER's OWN knight to its next witness cell.
   * Only allowed while "playing": any other status returns the `null` no-hint
   * sentinel (the Room sends nothing).
   *
   * The witness is split at the SAME midpoint k as playback so a hint never points
   * onto the other knight's reserved half / past the meeting middle:
   *   - P1 (forward): on-prefix iff visited.p1 equals path[0..len-1]; the next cell
   *     is path[len] — but capped at path[k] (P1's last own cell before the
   *     rendezvous hop). If already at/over path[k], there is no forward hint.
   *   - P2 (backward): on-suffix iff visited.p2 equals path[last..last-len+1]
   *     (reversed); the next cell is path[last-len] — capped at path[k+1] (P2's
   *     last own cell). If already at/over path[k+1], there is no forward hint.
   * Off the prefix/suffix → off_path. Never projects the raw `path`.
   */
  hint(pid: PlayerId): HintResult {
    if (this.status !== "playing") return null; // hint only while playing
    const path = this.puzzle.path;
    const last = path.length - 1;
    const k = Math.floor(path.length / 2);
    const trail = this.visited[pid];
    const len = trail.length;

    if (pid === "p1") {
      // On the forward prefix? trail must equal path[0..len-1].
      const onPrefix = trail.every((c, i) => sameCell(c, path[i]));
      // P1's own half is path[0..k]; the next forward cell is path[len], valid only
      // while len <= k (so the hint never points onto P2's reserved suffix or the
      // meeting middle). path[k] is P1's final own cell before the rendezvous hop.
      if (onPrefix && len <= k) {
        return { status: "prefix", cell: cloneCell(path[len]) };
      }
      return { status: "off_path", cell: null };
    }

    // P2 walks backward from path[last]; its trail (in order) is
    // path[last], path[last-1], …, path[last-(len-1)]. On-suffix iff each entry
    // matches that reversed sequence.
    const onSuffix = trail.every((c, i) => sameCell(c, path[last - i]));
    // P2's own half is path[last..k+1]; the next backward cell is path[last-len],
    // valid only while last-len >= k+1 (so it never points onto P1's prefix or the
    // meeting middle). path[k+1] is P2's final own cell.
    if (onSuffix && last - len >= k + 1) {
      return { status: "prefix", cell: cloneCell(path[last - len]) };
    }
    return { status: "off_path", cell: null };
  }

  /**
   * Project the public Board. Carries the full (n, steps, seed) triple so any
   * client/test reproduces the puzzle deterministically, plus the derived
   * available/start/end. Arrays are CLONED so neither tests nor server internals
   * can mutate engine-owned state through the snapshot. The witness `path` is
   * NEVER included.
   */
  board(): Board {
    const p = this.puzzle;
    return {
      n: p.n,
      steps: this.steps,
      seed: p.seed,
      available: p.available.map((row) => row.slice()),
      start: { r: p.start.r, c: p.start.c },
      end: { r: p.end.r, c: p.end.c },
    };
  }

  snapshotKnights(): { p1: Cell; p2: Cell } {
    return {
      p1: { r: this.knights.p1.r, c: this.knights.p1.c },
      p2: { r: this.knights.p2.r, c: this.knights.p2.c },
    };
  }

  /**
   * Project each knight's trail. CLONES every cell (same discipline as board()
   * and snapshotKnights()) so the live engine arrays are never exposed on the
   * wire and a client/test cannot mutate game state through the snapshot.
   * `visited.pX[0]` is the start cell, `visited.pX[last]` is the current cell.
   */
  snapshotVisited(): { p1: Cell[]; p2: Cell[] } {
    return {
      p1: this.visited.p1.map((c) => ({ r: c.r, c: c.c })),
      p2: this.visited.p2.map((c) => ({ r: c.r, c: c.c })),
    };
  }

  /**
   * Project the win state. `status` defaults "playing"; `result` stays null until
   * the rendezvous flips status to "won", then carries soft-vs-perfect + the
   * shared meeting cell (cloned, same no-leak discipline as the other snapshots).
   */
  snapshotStatus(): GameStatus {
    return this.status;
  }

  snapshotResult(): GameResult {
    if (!this.result) return null;
    return {
      perfect: this.result.perfect,
      meetCell: { r: this.result.meetCell.r, c: this.result.meetCell.c },
    };
  }

  playerViews(): PlayerView[] {
    return (["p1", "p2"] as const).map((id) => ({
      id,
      color: colorOf(id),
      name: this.players[id].name,
      connected: this.players[id].connected,
    }));
  }
}
