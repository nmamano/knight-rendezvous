import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "default" | "secondary" | "outline";

const VARIANTS: Record<Variant, string> = {
  default: "bg-[var(--accent)] text-white hover:opacity-90",
  secondary: "bg-[#e6e2fb] text-[#4a4366] hover:opacity-80",
  outline: "border-2 border-[#c9bdf4] bg-white text-[#4a4366] hover:bg-[#f3effd]",
};

export function Button({
  variant = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full px-4 py-2 text-sm font-bold whitespace-nowrap transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
