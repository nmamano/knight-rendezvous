import { useCallback, useEffect, useRef, useState } from "react";
import { Lobby } from "@/components/Lobby";
import { Waiting } from "@/components/Waiting";
import { Board } from "@/components/Board";
import { Net, type Status } from "@/net/socket";
import { knightMoves, type Cell } from "@shared/engine";
import { MIN_N, MAX_N, MIN_STEPS, maxSteps, clampSteps } from "@shared/config";
import type { Board, PlayerId, RoomSnapshot, ServerMsg } from "@shared/protocol";

const SESSION_KEY = "knight-rendezvous";

// Evidence surface for the smoke gate: window.__KR__ mirrors the latest snapshot
// plus our own PlayerId. The smoke gate asserts against the SERVER state via this
// mirror, never against pixels (mirrors knights-puzzle's window.__KP__ idea).
declare global {
  interface Window {
    __KR__?: { you: PlayerId | null; ready: boolean } & RoomSnapshot;
  }
}

interface Session {
  code: string;
  token: string;
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function roomFromUrl(): string | undefined {
  try {
    return new URLSearchParams(location.search).get("room")?.toUpperCase() ?? undefined;
  } catch {
    return undefined;
  }
}

// Strip ?room= from the URL (e.g. on cancel/exit), so the lobby doesn't keep
// prefilling a code for a room you've already left.
function clearRoomParam() {
  try {
    if (new URLSearchParams(location.search).has("room")) {
      history.replaceState(null, "", location.pathname);
    }
  } catch {
    // history may be unavailable in some embeds; ignore
  }
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

// The LOCAL player's legal next squares, computed to EXACTLY match the server's
// move() rule (server/game.ts): from `knights[you]`, every knight move that is
// in-bounds + `board.available` + NOT in union(visited.p1, visited.p2), PLUS the
// OTHER knight's CURRENT cell IF it is a knight-move away (the rendezvous WINNING
// hop — the one allowed exception to no-reuse, locked decision 1). We do NOT
// reuse the engine's `legalMoves` here: it would exclude the partner's cell (it
// is in the partner's trail), but that cell is exactly the square we must surface
// so players can see how to win. Returns [] for a missing `you`.
function legalTargets(
  board: Board,
  you: PlayerId | null,
  knights: { p1: Cell; p2: Cell },
  visited: { p1: Cell[]; p2: Cell[] },
): Cell[] {
  if (!you) return [];
  const from = knights[you];
  const other = you === "p1" ? knights.p2 : knights.p1;
  const visitedByEither = (c: Cell): boolean =>
    visited.p1.some((v) => sameCell(v, c)) || visited.p2.some((v) => sameCell(v, c));

  const out: Cell[] = [];
  for (const m of knightMoves(from, board.n)) {
    // The rendezvous square: the OTHER knight's current cell. It IS in the
    // partner's trail (visitedByEither would reject it), so it gets ADDED back
    // here as the sole exception — it is the winning move and MUST be shown.
    if (sameCell(m, other)) {
      out.push(m);
      continue;
    }
    if (!board.available[m.r][m.c]) continue;
    if (visitedByEither(m)) continue;
    out.push(m);
  }
  return out;
}

// Fix 3 — co-op SCORE, computed CLIENT-side from the snapshot. The original
// (knights-puzzle) score is the single knight's visited count; the co-op adaptation
// is the number of cells covered by EITHER knight = |union(visited.p1, visited.p2)|.
// The denominator is the count of playable (available-true) board cells.
function coverage(visited: { p1: Cell[]; p2: Cell[] }): number {
  const covered = new Set<number>();
  // r*1000+c keying is collision-free for these small boards (n <= 9).
  for (const v of visited.p1) covered.add(v.r * 1000 + v.c);
  for (const v of visited.p2) covered.add(v.r * 1000 + v.c);
  return covered.size;
}

function availableCount(board: Board): number {
  let total = 0;
  for (const row of board.available) for (const a of row) if (a) total++;
  return total;
}

function PlayerTag({ name, color, you }: { name: string; color: string; you: boolean }) {
  const swatch = color === "amber" ? "var(--amber)" : "var(--violet)";
  return (
    <span className="inline-flex items-center gap-2 rounded-full border-2 border-[#d6d8e6] bg-white px-3 py-1 text-sm font-bold text-[#4a4366]">
      <span
        className="inline-block h-3 w-3 rounded-full"
        style={{ background: swatch }}
        aria-hidden="true"
      />
      {name}
      {you ? " (you)" : ""}
    </span>
  );
}

// Shown on BOTH clients once the rendezvous lands (snapshot.status === "won").
// `perfect` distinguishes a full-cover perfect win (a badge) from a soft win
// (a gentler "you met!" message).
function WinPanel({ perfect }: { perfect: boolean }) {
  return (
    <div
      role="status"
      data-win-panel={perfect ? "perfect" : "soft"}
      className="flex flex-col items-center gap-2 rounded-2xl border-2 border-[var(--accent)] bg-white px-6 py-4 shadow-[0_4px_0_0_#d6d8e6]"
    >
      <p className="text-2xl font-extrabold" style={{ color: "var(--accent)" }}>
        Rendezvous!
      </p>
      {perfect ? (
        <span className="rounded-full bg-[var(--accent)] px-3 py-1 text-sm font-bold text-white">
          ✦ Perfect! Every square covered ✦
        </span>
      ) : (
        <p className="text-sm font-semibold text-[#6b6580]">
          Some squares were left uncovered. Go for a perfect score next time.
        </p>
      )}
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [you, setYou] = useState<PlayerId | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumps on every in-game rejection (illegal_move) so the toast re-fires even
  // when the message text is identical to the previous one (chess pattern).
  const [actionNonce, setActionNonce] = useState(0);
  const [opponentLeft, setOpponentLeft] = useState(false);
  // C5 hint UI (actor-only): the highlighted next-witness cell to pulse, or a
  // transient "no hint from here" flag for an off_path response. Both clear on a
  // timer and on any new server `state`. `hintNonce` re-fires the pulse even when
  // the same cell is hinted twice in a row.
  const [hintCell, setHintCell] = useState<Cell | null>(null);
  const [hintOffPath, setHintOffPath] = useState(false);
  const [hintNonce, setHintNonce] = useState(0);
  // Fix 2 — play-screen sliders (board size + path length). These are LOCAL
  // pending values that ONLY take effect when "New puzzle" is pressed; dragging
  // them never regenerates. null = "follow the current board" (initialized from
  // board.n/board.steps the first time an active board renders, and re-synced
  // whenever the active board changes via the effect below).
  const [pendingN, setPendingN] = useState<number | null>(null);
  const [pendingSteps, setPendingSteps] = useState<number | null>(null);

  const netRef = useRef<Net | null>(null);
  const urlRoom = roomFromUrl();

  const handleMessage = useCallback((m: ServerMsg) => {
    switch (m.t) {
      case "joined":
        setYou(m.you);
        setOpponentLeft(false);
        setError(null);
        setSnapshot(m.state);
        saveSession({ code: m.code, token: m.token });
        break;
      case "state":
        setError(null);
        // A fresh server frame supersedes any pending hint highlight.
        setHintCell(null);
        setHintOffPath(false);
        setSnapshot(m.state);
        break;
      case "hint":
        // Actor-only response: only the requester ever receives this. Pulse the
        // returned cell, or flash a brief "no hint from here" for off_path.
        if (m.status === "prefix") {
          setHintCell(m.cell);
          setHintOffPath(false);
        } else {
          setHintCell(null);
          setHintOffPath(true);
        }
        setHintNonce((n) => n + 1);
        break;
      case "opponentLeft":
        setOpponentLeft(true);
        break;
      case "error":
        setError(m.message);
        if (m.code === "room_not_found" || m.code === "bad_token") {
          // A failed (auto-)reconnect or stale code: drop back to the lobby.
          clearSession();
          setYou(null);
          setSnapshot(null);
        } else {
          // An in-game rejection (illegal_move / bad_message): keep the room and
          // surface a transient toast. Bump the nonce so an identical message
          // re-fires it. (A post-win move is now a SILENT no-op, not an error.)
          setActionNonce((n) => n + 1);
        }
        break;
    }
  }, []);

  useEffect(() => {
    const net = new Net({
      onMessage: handleMessage,
      onStatus: setStatus,
      getReconnect: () => {
        const s = loadSession();
        if (!s) return null;
        // A ?room= link is the user's explicit intent: never auto-rejoin a
        // *different* stored room over it. Same room (or no URL room) is fine.
        const fromUrl = roomFromUrl();
        if (fromUrl && s.code !== fromUrl) return null;
        return { t: "reconnect", code: s.code, token: s.token };
      },
    });
    netRef.current = net;
    net.connect();
    return () => net.close();
  }, [handleMessage]);

  // Publish the evidence surface. The smoke gate reads window.__KR__ from both
  // contexts and asserts board/knights/visited are byte-identical (server is the
  // oracle). Spreading the snapshot exposes `visited` automatically.
  useEffect(() => {
    if (snapshot) {
      window.__KR__ = { ...snapshot, you, ready: true };
    }
  }, [snapshot, you]);

  // Fix 2 — keep the slider pending values in sync with the ACTIVE board. We
  // re-sync whenever the broadcast board's n/steps change (e.g. after a New
  // puzzle regenerates at a new size): the sliders then reflect the live board
  // until the player drags them. Keyed on the board's n+steps so an unrelated
  // re-render (a move, a hint) does NOT clobber an in-progress drag.
  const boardN = snapshot?.board?.n;
  const boardSteps = snapshot?.board?.steps;
  useEffect(() => {
    if (boardN != null) setPendingN(boardN);
    if (boardSteps != null) setPendingSteps(boardSteps);
  }, [boardN, boardSteps]);

  // Transient, non-blocking toast for in-game rejections (illegal_move). Re-fires
  // on each actionNonce bump even if the message text repeats.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!error) {
      setToast(null); // a later success cleared the error → drop any stale toast
      return;
    }
    setToast(error);
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [error, actionNonce]);

  // Transient hint highlight: a prefix-cell pulse or an off_path flash auto-clears
  // after a short window. Keyed on hintNonce so a repeat hint re-fires the timer.
  useEffect(() => {
    if (!hintCell && !hintOffPath) return;
    const id = setTimeout(() => {
      setHintCell(null);
      setHintOffPath(false);
    }, 2200);
    return () => clearTimeout(id);
  }, [hintCell, hintOffPath, hintNonce]);

  // User-initiated create/join: clear any stored session FIRST so a stale
  // reconnect isn't replayed ahead of this and silently swallow it (the server
  // ignores create/join while already bound).
  const create = useCallback((name: string) => {
    clearSession();
    setError(null);
    netRef.current?.send({ t: "create", name });
  }, []);

  const join = useCallback((code: string, name: string) => {
    clearSession();
    setError(null);
    netRef.current?.send({ t: "join", code, name });
  }, []);

  // Permissive: send the move for ANY clicked cell. The server is authoritative
  // and rejects illegal moves; we render only on the resulting server `state`
  // (no optimistic UI). Clearing the error first means a success that follows a
  // prior rejection drops the stale toast.
  const move = useCallback((cell: Cell) => {
    setError(null);
    netRef.current?.send({ t: "move", cell });
  }, []);

  // Per-player Retry/Undo (locked decision 6 — they only ever affect YOUR own
  // knight; the server is the authority). No optimistic UI: we render only on the
  // resulting server `state`. The button-disable below is UX; the server guards
  // (win-blocked / boundary no-op) are the actual rules.
  const retry = useCallback(() => {
    setError(null);
    netRef.current?.send({ t: "retry" });
  }, []);

  const undo = useCallback(() => {
    setError(null);
    netRef.current?.send({ t: "undo" });
  }, []);

  // C5 — view solution (room-wide) + hint (per-player). No optimistic UI: the
  // server drives playback frames on `state`, and the hint highlight comes from
  // the actor-only `hint` ServerMsg. Both buttons are disabled while locked.
  const viewSolution = useCallback(() => {
    setError(null);
    netRef.current?.send({ t: "viewSolution" });
  }, []);

  const hint = useCallback(() => {
    setError(null);
    netRef.current?.send({ t: "hint" });
  }, []);

  // C6 — New puzzle (room-wide reset, locked decision 5). No optimistic UI: the
  // server regenerates the board and broadcasts; the WinPanel disappears and the
  // board becomes interactive again purely from the resulting server `state`.
  // Fix 2 — carries the slider-chosen n/steps; the server clamps them. We send
  // the pending values when set (falling back to undefined → server defaults).
  const newPuzzle = useCallback((n?: number, steps?: number) => {
    setError(null);
    netRef.current?.send({ t: "newPuzzle", n, steps });
  }, []);

  const exit = useCallback(() => {
    netRef.current?.send({ t: "leave" });
    clearSession();
    clearRoomParam(); // drop ?room= so the lobby doesn't prefill a now-stale code
    setYou(null);
    setSnapshot(null);
    setOpponentLeft(false);
    setError(null);
  }, []);

  const disconnected = status !== "open";

  let view;
  if (!you || !snapshot) {
    view = (
      <Lobby
        onCreate={create}
        onJoin={join}
        initialCode={urlRoom}
        error={error}
        busy={disconnected}
      />
    );
  } else if (snapshot.lobby === "waiting") {
    view = <Waiting code={snapshot.code} onCancel={exit} />;
  } else if (snapshot.board && snapshot.knights && snapshot.visited) {
    const me = snapshot.players.find((p) => p.id === you);
    const opp = snapshot.players.find((p) => p.id !== you);
    const won = snapshot.status === "won";
    const playback = snapshot.status === "playback";
    // ONE authoritative input lock: anything other than "playing" disables ALL
    // inputs (board clicks, retry, undo, hint, view-solution). This single
    // predicate is the source every control consults (locked decision 7: inputs
    // locked during playback; the win panel already covers "won").
    const locked = snapshot.status !== "playing";
    // Fix 1 — the LOCAL player's legal next squares, highlighted ONLY while
    // "playing" (never during playback/won). Computed to EXACTLY mirror the
    // server's move() rule, and it INCLUDES the rendezvous square (the partner's
    // current cell when a knight-move away) so players can see the winning hop.
    const legalCells =
      snapshot.status === "playing"
        ? legalTargets(snapshot.board, you, snapshot.knights, snapshot.visited)
        : [];
    // Fix 2 — slider display values. Default to the live board's n/steps until a
    // drag sets a pending value; the steps label is clamped to maxSteps(n) so the
    // "(cells)" count is always self-consistent for the chosen n.
    const sliderN = pendingN ?? snapshot.board.n;
    const sliderSteps = clampSteps(sliderN, pendingSteps ?? snapshot.board.steps);
    // Your own trail length drives the undo-disable UX (server is the authority).
    // length<=1 means you are at your start: nothing to undo.
    const myTrailLen = you ? snapshot.visited[you].length : 0;
    const atStart = myTrailLen <= 1;
    // Fix 2 — undo/retry stay available when WON (they un-meet, mirroring the
    // original stepping back off the goal). They are ONLY disabled during
    // playback (the one truly input-locked status). Undo additionally disables at
    // the start (nothing to pop); retry is always enabled off playback (it is an
    // idempotent reset that also un-meets a won game).
    const playbackLock = snapshot.status === "playback";
    const undoDisabled = playbackLock || atStart;
    const retryDisabled = playbackLock;
    // Fix 3 — co-op score (covered cells / total playable cells), computed
    // client-side from the snapshot, and the server-supplied difficulty number.
    const scoreVal = coverage(snapshot.visited);
    const totalCells = availableCount(snapshot.board);
    const difficulty = snapshot.board.difficulty;
    // C6 — "New puzzle" has its OWN enable rule: a room-wide RESET, allowed while
    // "playing" OR "won" (so it works on the win screen — folding it under the
    // shared `locked` predicate would wrongly disable it there), DISABLED only
    // during "playback".
    const newPuzzleDisabled = !(snapshot.status === "playing" || snapshot.status === "won");
    // Connection / presence banners (C6). Once a game is active we show whether
    // the opponent is mid grace-window (reconnect pending) vs gone for good.
    const oppConnected = opp ? opp.connected : true;
    view = (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight" style={{ color: "#3a3357" }}>
          Knight <span style={{ color: "var(--accent)" }}>Rendezvous</span>
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {me && <PlayerTag name={me.name} color={me.color} you />}
          {opp && <PlayerTag name={opp.name} color={opp.color} you={false} />}
        </div>
        {/* Fix 3 — Score + Difficulty status line (mirrors knights-puzzle's
            `.status` placement just above the board). Score = cells covered by
            either knight / total playable cells; Difficulty is the server-computed
            branching-product number (the witness `path` it derives from never
            reaches the client). */}
        <p className="status" role="status" data-status="1">
          Score {scoreVal} / {totalCells}
          <span className="status-sep" aria-hidden="true">
            ·
          </span>
          <span className="diff-score">Difficulty {difficulty.toLocaleString()}</span>
        </p>
        <Board
          board={snapshot.board}
          knights={snapshot.knights}
          visited={snapshot.visited}
          // Lock the board whenever not "playing" (win OR playback) — do NOT rely
          // on the server error as the only guard. A no-op onMove ignores clicks
          // client-side too.
          onMove={locked ? () => {} : move}
          // Fix 1 — the local player's legal next squares (incl. the rendezvous
          // square), highlighted with a pulsing ring while "playing".
          legalCells={legalCells}
          // Fix 4 — the local player's id, so the ring is drawn in THEIR knight
          // color (p1 amber, p2 violet).
          you={you}
          // The actor-only hint cell to pulse (null when none). Keyed by nonce so a
          // repeat hint re-triggers the animation.
          hintCell={hintCell}
          hintNonce={hintNonce}
        />
        {/* Per-player controls (locked decision 6). Retry resets ONLY your knight
            to its start; Undo pops ONLY your last move. They STAY available when
            won (they step a knight off the shared square → un-meet, mirroring the
            original); only playback truly locks them. Undo also disables at the
            start (nothing to pop). Those disables are UX hints only — the server
            guards are the authority (no optimistic UI). The look ports
            knights-puzzle's pill/shadow/handwritten controls into KR's Tailwind. */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={retry}
            disabled={retryDisabled}
            className="rounded-full border-2 border-[#c9bdf4] bg-white px-5 py-2 text-lg font-bold text-[#4a4366] shadow-[0_4px_0_0_#d6d8e6] transition hover:bg-[#f3effd] active:translate-y-0.5 active:shadow-[0_2px_0_0_#d6d8e6] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 disabled:active:shadow-[0_4px_0_0_#d6d8e6]"
            style={{ fontFamily: "var(--display)" }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={undoDisabled}
            className="rounded-full border-2 border-[#c9bdf4] bg-white px-5 py-2 text-lg font-bold text-[#4a4366] shadow-[0_4px_0_0_#d6d8e6] transition hover:bg-[#f3effd] active:translate-y-0.5 active:shadow-[0_2px_0_0_#d6d8e6] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 disabled:active:shadow-[0_4px_0_0_#d6d8e6]"
            style={{ fontFamily: "var(--display)" }}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={hint}
            disabled={locked}
            className="rounded-full border-2 border-[#c9bdf4] bg-white px-5 py-2 text-lg font-bold text-[#4a4366] shadow-[0_4px_0_0_#d6d8e6] transition hover:bg-[#f3effd] active:translate-y-0.5 active:shadow-[0_2px_0_0_#d6d8e6] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 disabled:active:shadow-[0_4px_0_0_#d6d8e6]"
            style={{ fontFamily: "var(--display)" }}
          >
            Hint
          </button>
          <button
            type="button"
            onClick={viewSolution}
            disabled={locked}
            className="rounded-full border-2 border-[#c9bdf4] bg-white px-5 py-2 text-lg font-bold text-[#4a4366] shadow-[0_4px_0_0_#d6d8e6] transition hover:bg-[#f3effd] active:translate-y-0.5 active:shadow-[0_2px_0_0_#d6d8e6] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 disabled:active:shadow-[0_4px_0_0_#d6d8e6]"
            style={{ fontFamily: "var(--display)" }}
          >
            View solution
          </button>
          {/* C6 — New puzzle: room-wide reset (locked decision 5). Its OWN enable
              rule (playing OR won; disabled only during playback) so it stays
              clickable on the win screen. Accent-filled to read as the primary
              "play again" affordance. No optimistic UI — the server resets. */}
          <button
            type="button"
            onClick={() => newPuzzle(sliderN, sliderSteps)}
            disabled={newPuzzleDisabled}
            className="rounded-full border-2 border-[var(--accent)] bg-[var(--accent)] px-5 py-2 text-lg font-bold text-white shadow-[0_4px_0_0_#c9bdf4] transition hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_0_#c9bdf4] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 disabled:active:shadow-[0_4px_0_0_#c9bdf4]"
            style={{ fontFamily: "var(--display)" }}
          >
            New puzzle
          </button>
        </div>
        {/* Fix 2 — board-size + path-length sliders (ported from knights-puzzle,
            co-op-adapted). They set LOCAL pending values ONLY; dragging never
            regenerates. The "New puzzle" button above sends the chosen n/steps to
            regenerate the room-wide board. Labels/format mirror the original. */}
        <div className="random-knobs">
          <label className="slider">
            <span>
              Board size: <strong>{sliderN}</strong>
            </span>
            <input
              type="range"
              min={MIN_N}
              max={MAX_N}
              step={1}
              value={sliderN}
              aria-label="Board size"
              onChange={(e) => {
                const next = Number(e.target.value);
                setPendingN(next);
                // Keep steps consistent with the new n's max so the label never
                // shows an out-of-range path length (the server clamps too).
                setPendingSteps((s) => clampSteps(next, s ?? sliderSteps));
              }}
            />
          </label>
          <label className="slider">
            <span>
              Path length: <strong>{sliderSteps}</strong> ({sliderSteps + 1} cells)
            </span>
            <input
              type="range"
              min={MIN_STEPS}
              max={maxSteps(sliderN)}
              step={1}
              value={sliderSteps}
              aria-label="Path length"
              onChange={(e) => setPendingSteps(Number(e.target.value))}
            />
          </label>
        </div>
        {playback && (
          <p
            role="status"
            data-playback="1"
            className="rounded-2xl border-2 border-[var(--accent)] bg-white px-4 py-2 text-sm font-bold text-[var(--accent)] shadow-[0_4px_0_0_#d6d8e6]"
          >
            Playing solution…
          </p>
        )}
        {hintOffPath && (
          <p
            role="status"
            data-hint="off_path"
            className="rounded-2xl bg-[#9a7a2a]/10 px-4 py-2 text-sm font-semibold text-[#8a6a1a]"
          >
            You’ve strayed from the planned solution. Undo or Retry.
          </p>
        )}
        {won && snapshot.result ? (
          <WinPanel perfect={snapshot.result.perfect} />
        ) : !playback ? (
          <p className="text-sm text-[#6b6580]">
            Hop your knight onto the other knight to rendezvous. Cover every square for a perfect
            win!
          </p>
        ) : null}
        {/* C6 presence/reconnect UX. While the opponent is mid grace-window
            (still in the room but their socket dropped) we show a soft "waiting
            to return" banner; once they leave for good the server sends
            opponentLeft and we show the firm "left the room" banner. The
            opponentLeft message wins (it is terminal). */}
        {opponentLeft ? (
          <p
            role="status"
            data-opponent="left"
            className="rounded-2xl bg-[#9a4a4a]/10 px-4 py-2 text-sm font-semibold text-[#9a4a4a]"
          >
            Your opponent left the room. Start a new game to play again.
          </p>
        ) : opp && !oppConnected ? (
          <p
            role="status"
            data-opponent="waiting"
            className="rounded-2xl bg-[#9a7a2a]/10 px-4 py-2 text-sm font-semibold text-[#8a6a1a]"
          >
            Waiting for {opp.name} to return…
          </p>
        ) : null}
        {/* C6 outbound cross-link ONLY (rail #2): a tiny "more games" link back to
            Knight's Puzzle. The KP→KR back-link is C7 (edits the KP repo). */}
        <footer className="pt-2 text-xs text-[#8b86a0]">
          <a
            href="https://knight.nilmamano.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
          >
            ↩ Knight&apos;s Puzzle
          </a>{" "}
          — single player
        </footer>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      {disconnected && (
        <div className="fixed inset-x-0 top-0 z-40 bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-white">
          {status === "connecting" ? "Connecting…" : "Connection lost. Reconnecting…"}
        </div>
      )}
      {view}
      {toast && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <button
            onClick={() => setToast(null)}
            className="rounded-2xl border-2 border-[#9a4a4a]/40 bg-white px-4 py-2 text-sm font-semibold text-[#9a4a4a] shadow-[0_4px_0_0_#d6d8e6]"
          >
            {toast}
          </button>
        </div>
      )}
    </div>
  );
}
