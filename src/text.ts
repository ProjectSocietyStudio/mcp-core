/**
 * Truncates oversized output so a result cannot drown the agent's context. A 1.5 MB
 * entity lump pasted whole is the failure this exists to prevent.
 */
export function clip(s: string, max = 8000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...(${s.length - max} bytes truncated)`;
}

/** Strips ANSI escape sequences (colour, bold) from a string. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
