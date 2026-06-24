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
}

// SVG polyline points for a trail in board coordinates (cell centers).
function polyPoints(trail: Cell[]): string {
  return trail.map((v) => `${v.c + 0.5},${v.r + 0.5}`).join(" ");
}

export function Board({ board, knights, visited, onMove }: Props) {
  const { n, available, start, end } = board;
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
            const className = [
              "cell",
              dark ? "dark" : "light",
              avail ? "open" : "blocked",
              owner === "p1" ? "trail-amber" : owner === "p2" ? "trail-violet" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={k}
                data-cell={k}
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
                    {isEnd ? "🏁" : "◎"}
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

      {/* Both knights as overlay pieces in distinct colors (p1 amber, p2 violet). */}
      <div className="piece-layer" style={{ "--n": n } as React.CSSProperties} aria-hidden="true">
        <span
          className="piece amber"
          data-knight="p1"
          style={{
            left: `${((knights.p1.c + 0.5) / n) * 100}%`,
            top: `${((knights.p1.r + 0.5) / n) * 100}%`,
          }}
        >
          ♞
        </span>
        <span
          className="piece violet"
          data-knight="p2"
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
