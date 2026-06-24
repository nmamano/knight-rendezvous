// The shared puzzle board, in the knights-puzzle grass/hedge theme. Rendered
// identically on both clients from the server-broadcast Board.
//
// C2: cells are clickable. Clicking a cell sends a move for the LOCAL player's
// knight (onMove). We are deliberately PERMISSIVE — any cell click for the local
// player is sent; the server is authoritative and rejects illegal moves. There
// is NO optimistic UI: the board only re-renders on a server `state`. Both
// players' trails are drawn (p1 amber, p2 violet) as a themed cell tint plus an
// SVG polyline over each `visited` array; the two knights are drawn on top.

import type { Cell } from "@shared/engine";
import type { Board as BoardData, PlayerId } from "@shared/protocol";

const DESK_CELL = 56;
const GAP = 1;
const PAD = 0;

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

function cellKey(r: number, c: number): number {
  return r * 1000 + c; // n is small (6); 1000 stride is ample and collision-free
}

interface Props {
  board: BoardData;
  knights: { p1: Cell; p2: Cell };
  visited: { p1: Cell[]; p2: Cell[] };
  onMove: (cell: Cell) => void;
  // Fix 1 — the LOCAL player's legal next squares (computed in App to match the
  // server's move() rule, INCLUDING the rendezvous square). Highlighted with a
  // pulsing ring. Empty unless the game is "playing".
  legalCells?: Cell[];
  // Fix 4 — the LOCAL player's id, so the legal-move ring is drawn in THEIR knight
  // color (p1 = amber, p2 = violet) rather than a shared lavender. null → amber
  // (a harmless default; legalCells is empty when `you` is unset anyway).
  you?: PlayerId | null;
  // C5 actor-only hint: the witness cell to pulse for the LOCAL player (null when
  // none). `hintNonce` re-keys the element so a repeat hint restarts the pulse.
  hintCell?: Cell | null;
  hintNonce?: number;
}

// SVG polyline points for a trail in board coordinates (cell centers).
function polyPoints(trail: Cell[]): string {
  return trail.map((v) => `${v.c + 0.5},${v.r + 0.5}`).join(" ");
}

export function Board({
  board,
  knights,
  visited,
  onMove,
  legalCells,
  you,
  hintCell,
  hintNonce,
}: Props) {
  const { n, available, start, end } = board;
  // True when both knights occupy the SAME square — the rendezvous WIN and the
  // view-solution FINAL frame. Drives the side-by-side "huddle" render so neither
  // knight is hidden behind the other. Independent of `status` (covers both cases).
  const coLocated = sameCell(knights.p1, knights.p2);
  // Fix 1 — fast lookup of the local player's legal next squares for the .legal ring.
  const legalSet = new Set<number>();
  for (const lc of legalCells ?? []) legalSet.add(cellKey(lc.r, lc.c));
  // Fix 4 — the legal ring wears the LOCAL player's knight color (p1 amber, p2
  // violet). Default to amber when `you` is unset (legalCells is empty then anyway).
  const legalVariant = you === "p2" ? "legal-violet" : "legal-amber";
  // Board frame is 5px each side; the playable field is n cells + (n-1) gaps.
  const maxBoardPx = n * DESK_CELL + (n - 1) * GAP + 2 * PAD + 10;

  // Which player owns each visited cell, for the themed tint. The two trails are
  // disjoint during play, with ONE exception: the rendezvous hop (C3) lands a
  // knight on the other's square, so after a win that single shared cell appears
  // in both trails. p2 is written last, so it wins the tint there — a harmless
  // cosmetic overwrite on that one meeting cell.
  const trailOwner = new Map<number, PlayerId>();
  for (const v of visited.p1) trailOwner.set(cellKey(v.r, v.c), "p1");
  for (const v of visited.p2) trailOwner.set(cellKey(v.r, v.c), "p2");

  return (
    <div className="board-wrap">
      <div
        className="board"
        style={{
          gridTemplateColumns: `repeat(${n}, 1fr)`,
          width: `min(92vw, ${maxBoardPx}px)`,
        }}
      >
        {available.flatMap((row, r) =>
          row.map((avail, c) => {
            const k = `${r}-${c}`;
            const dark = (r + c) % 2 === 1;
            const cell = { r, c };
            const isStart = sameCell(start, cell);
            const isEnd = sameCell(end, cell);
            const owner = trailOwner.get(cellKey(r, c));
            const isHint = hintCell != null && sameCell(hintCell, cell);
            const isLegal = legalSet.has(cellKey(r, c));
            const className = [
              "cell",
              dark ? "dark" : "light",
              avail ? "open" : "blocked",
              owner === "p1" ? "trail-amber" : owner === "p2" ? "trail-violet" : "",
              isLegal ? "legal" : "",
              isLegal ? legalVariant : "",
              isHint ? "hint-pulse" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                // Re-key the hinted cell on each hint so the pulse animation restarts.
                key={isHint ? `${k}-hint-${hintNonce ?? 0}` : k}
                data-cell={k}
                data-legal={isLegal ? "1" : undefined}
                data-hint={isHint ? "1" : undefined}
                className={className}
                role={avail ? "button" : undefined}
                tabIndex={avail ? 0 : undefined}
                onClick={avail ? () => onMove(cell) : undefined}
                onKeyDown={
                  avail
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onMove(cell);
                        }
                      }
                    : undefined
                }
                aria-label={`square ${r},${c}${isEnd ? " (player 2 start)" : isStart ? " (player 1 start)" : ""}`}
              >
                {avail && (isStart || isEnd) ? (
                  <span className="glyph" aria-hidden="true">
                    ◎
                  </span>
                ) : null}
              </div>
            );
          }),
        )}
      </div>

      {/* Both trails as SVG polylines tracing each knight's route (p1 amber, p2
          violet). Board-coordinate viewBox; the layer is inset to the 5px frame. */}
      <svg
        className="trail"
        viewBox={`0 0 ${n} ${n}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {visited.p1.length > 1 && (
          <polyline className="trail-line trail-amber-line" points={polyPoints(visited.p1)} />
        )}
        {visited.p2.length > 1 && (
          <polyline className="trail-line trail-violet-line" points={polyPoints(visited.p2)} />
        )}
      </svg>

      {/* Both knights as overlay pieces in distinct colors (p1 amber, p2 violet).
          When the two knights occupy the SAME cell — the rendezvous WIN and the
          view-solution FINAL frame (held ~2s) — they would otherwise stack and
          look like one ate the other. The `huddled` class shrinks + offsets +
          tilts each so BOTH read clearly, side-by-side, leaning toward each other.
          Triggered purely on co-location, regardless of `status`. */}
      <div className="piece-layer" style={{ "--n": n } as React.CSSProperties} aria-hidden="true">
        <span
          className={`piece amber${coLocated ? " huddled" : ""}`}
          data-knight="p1"
          data-huddled={coLocated ? "1" : undefined}
          style={{
            left: `${((knights.p1.c + 0.5) / n) * 100}%`,
            top: `${((knights.p1.r + 0.5) / n) * 100}%`,
          }}
        >
          ♞
        </span>
        <span
          className={`piece violet${coLocated ? " huddled" : ""}`}
          data-knight="p2"
          data-huddled={coLocated ? "1" : undefined}
          style={{
            left: `${((knights.p2.c + 0.5) / n) * 100}%`,
            top: `${((knights.p2.r + 0.5) / n) * 100}%`,
          }}
        >
          ♞
        </span>
      </div>
    </div>
  );
}
