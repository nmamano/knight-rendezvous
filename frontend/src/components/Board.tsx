// The shared puzzle board, in the knights-puzzle grass/hedge theme. Rendered
// identically on both clients from the server-broadcast Board. No click handlers
// in C1 (no movement yet) — just the field, the start/end glyphs, and both
// knights as distinct-colored overlay pieces.

import type { Cell } from "@shared/engine";
import type { Board as BoardData } from "@shared/protocol";

const DESK_CELL = 56;
const GAP = 1;
const PAD = 0;

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

interface Props {
  board: BoardData;
  knights: { p1: Cell; p2: Cell };
}

export function Board({ board, knights }: Props) {
  const { n, available, start, end } = board;
  // Board frame is 5px each side; the playable field is n cells + (n-1) gaps.
  const maxBoardPx = n * DESK_CELL + (n - 1) * GAP + 2 * PAD + 10;

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
            const className = ["cell", dark ? "dark" : "light", avail ? "open" : "blocked"]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={k}
                data-cell={k}
                className={className}
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
