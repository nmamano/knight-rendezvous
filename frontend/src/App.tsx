import { useCallback, useEffect, useRef, useState } from "react";
import { Lobby } from "@/components/Lobby";
import { Waiting } from "@/components/Waiting";
import { Board } from "@/components/Board";
import { Net, type Status } from "@/net/socket";
import type { Cell } from "@shared/engine";
import type { PlayerId, RoomSnapshot, ServerMsg } from "@shared/protocol";

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
          You met! Some squares were left uncovered — go for a perfect next time.
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
        setSnapshot(m.state);
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
          // An in-game rejection (illegal_move / game_over / bad_message): keep the
          // room and surface a transient toast. Bump the nonce so an identical
          // message re-fires it. A post-win `game_over` flows through here too.
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
    view = (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight" style={{ color: "#3a3357" }}>
          Knight <span style={{ color: "var(--accent)" }}>Rendezvous</span>
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {me && <PlayerTag name={me.name} color={me.color} you />}
          {opp && <PlayerTag name={opp.name} color={opp.color} you={false} />}
        </div>
        <Board
          board={snapshot.board}
          knights={snapshot.knights}
          visited={snapshot.visited}
          // Lock the board on a win — do NOT rely on the server error as the only
          // guard. A no-op onMove means clicks are ignored client-side too.
          onMove={won ? () => {} : move}
        />
        {won && snapshot.result ? (
          <WinPanel perfect={snapshot.result.perfect} />
        ) : (
          <p className="text-sm text-[#6b6580]">
            Hop your knight onto the other knight to rendezvous. Cover every square for a perfect
            win!
          </p>
        )}
        {opponentLeft && (
          <p className="rounded-2xl bg-[#9a4a4a]/10 px-4 py-2 text-sm font-semibold text-[#9a4a4a]">
            Your opponent left the room.
          </p>
        )}
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
