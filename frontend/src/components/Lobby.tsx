import { useState } from "react";
import { Button } from "@/components/Button";

const ADJ = [
  "Swift",
  "Sneaky",
  "Lucky",
  "Bold",
  "Cosmic",
  "Feral",
  "Quiet",
  "Royal",
  "Atomic",
  "Vivid",
];
const NOUN = [
  "Knight",
  "Comet",
  "Raven",
  "Tiger",
  "Specter",
  "Bishop",
  "Hydra",
  "Falcon",
  "Wolf",
  "Sphinx",
];

function randomName() {
  return `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
}

interface Props {
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  initialCode?: string;
  error?: string | null;
  busy?: boolean;
}

export function Lobby({ onCreate, onJoin, initialCode, error, busy }: Props) {
  const [name, setName] = useState(randomName);
  const [code, setCode] = useState((initialCode ?? "").toUpperCase().slice(0, 4));

  const trimmedName = () => name.trim() || "Player";

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center gap-9 px-6 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1
          className="text-5xl font-extrabold tracking-tight text-balance sm:text-6xl"
          style={{ color: "#3a3357" }}
        >
          Knight <span style={{ color: "var(--accent)" }}>Rendezvous</span>
        </h1>
        <p className="max-w-md text-base font-semibold leading-relaxed text-pretty text-[#6b6580]">
          Pair up and steer your two knights across the same board • Win when they meet on the same
          square.
        </p>
      </div>

      <div className="w-full rounded-3xl border-2 border-[#d6d8e6] bg-white p-6 shadow-[0_8px_0_0_#d6d8e6]">
        <label
          className="mb-2 block text-xs font-bold tracking-widest text-[#6b6580] uppercase"
          htmlFor="name"
        >
          Your name
        </label>
        <div className="mb-6 flex gap-2">
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-2xl border-2 border-[#d6d8e6] bg-white px-4 py-3 font-semibold outline-none transition-colors focus:border-[var(--accent)]"
            placeholder="Enter a name"
            maxLength={20}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => setName(randomName())}
            className="shrink-0 rounded-2xl"
            aria-label="Randomize name"
          >
            Shuffle
          </Button>
        </div>

        <Button
          className="w-full rounded-2xl py-6 text-base"
          disabled={busy}
          onClick={() => onCreate(trimmedName())}
        >
          Create game
        </Button>

        <div className="my-5 flex items-center gap-3 text-xs font-bold tracking-widest text-[#6b6580] uppercase">
          <span className="h-0.5 flex-1 rounded-full bg-[#d6d8e6]" />
          or join a room
          <span className="h-0.5 flex-1 rounded-full bg-[#d6d8e6]" />
        </div>

        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.length === 4 && !busy) onJoin(code, trimmedName());
            }}
            className="w-full rounded-2xl border-2 border-[#d6d8e6] bg-white px-4 py-3 text-center text-lg font-bold tracking-[0.4em] uppercase outline-none transition-colors focus:border-[var(--accent)]"
            placeholder="CODE"
            maxLength={4}
          />
          <Button
            type="button"
            variant="outline"
            disabled={code.length < 4 || busy}
            onClick={() => onJoin(code, trimmedName())}
            className="shrink-0 rounded-2xl"
          >
            Join
          </Button>
        </div>

        {error && (
          <p className="mt-3 rounded-2xl bg-[#9a4a4a]/10 px-3 py-2 text-center text-sm font-semibold text-[#9a4a4a]">
            {error}
          </p>
        )}
        {!error && (
          <p className="mt-3 text-center text-xs text-[#6b6580]">
            Create a game and share the 4-letter code with a friend to play.
          </p>
        )}
      </div>
    </main>
  );
}
