import { useState } from "react";
import { Button } from "@/components/Button";
import { copyText } from "@/lib/clipboard";

interface Props {
  code: string;
  onCancel: () => void;
}

export function Waiting({ code, onCancel }: Props) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [failed, setFailed] = useState(false);

  const shareLink = `${location.origin}/?room=${code}`;

  const copy = async (what: "code" | "link", text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setFailed(false);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } else {
      setFailed(true);
      setTimeout(() => setFailed(false), 2500);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="rounded-full border-2 border-[var(--accent)]/30 bg-white px-4 py-1.5 text-xs font-bold tracking-widest text-[var(--accent)] uppercase">
          room created
        </span>
        <h1
          className="text-4xl font-extrabold tracking-tight sm:text-5xl"
          style={{ color: "#3a3357" }}
        >
          Share your code
        </h1>
        <p className="mt-1 max-w-sm text-[#6b6580]">
          Send the code or link to a friend. The game starts the moment they join.
        </p>
      </div>

      <div className="w-full rounded-3xl border-2 border-[#d6d8e6] bg-white p-8 shadow-[0_8px_0_0_#d6d8e6]">
        <button
          onClick={() => copy("code", code)}
          className="text-6xl font-extrabold tracking-[0.3em] text-[var(--accent)] transition-opacity hover:opacity-80"
          aria-label="Copy room code"
          title="Click to copy"
        >
          {code}
        </button>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="flex-1 rounded-2xl"
            onClick={() => copy("code", code)}
          >
            {copied === "code" ? "Copied!" : "Copy code"}
          </Button>
          <Button
            variant="outline"
            className="flex-1 rounded-2xl"
            onClick={() => copy("link", shareLink)}
          >
            {copied === "link" ? "Copied!" : "Copy link"}
          </Button>
        </div>

        {failed && (
          <p className="mt-3 text-xs font-semibold text-[#6b6580]">
            Couldn&apos;t copy automatically. Just read the code above to your friend.
          </p>
        )}

        <div className="mt-6 flex items-center justify-center gap-2 text-sm font-semibold text-[#6b6580]">
          <span className="flex gap-1">
            <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--accent)] [animation-delay:-0.3s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--accent)] [animation-delay:-0.15s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--accent)]" />
          </span>
          Waiting for an opponent…
        </div>
      </div>

      <Button variant="outline" className="rounded-2xl" onClick={onCancel}>
        Cancel
      </Button>
    </main>
  );
}
