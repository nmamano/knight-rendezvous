/** Tiny class-name joiner: drops falsy values, joins the rest with spaces. */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(" ");
}
