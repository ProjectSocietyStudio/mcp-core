import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Audit kinds shared by every server. Each server widens this with its own vocabulary --
 * `bridge_command` for a server that drives a live engine, `compile_start` for one that
 * drives a toolchain -- by passing its own union as `K`.
 */
export type BaseAuditKind =
  | "server_start"
  | "tool_call"
  | "tool_result"
  | "error";

export interface AuditEntry<K extends string = string> {
  ts: number;
  kind: K;
  /** Correlates a session's entries. Only servers that hold a session set it. */
  sessionId?: string;
  commandId?: string;
  /** Free-form payload, shaped by `kind`. */
  data?: Record<string, unknown>;
}

/**
 * Append-only JSONL audit log, written to `<stateDir>/logs/audit.jsonl`. One line is one
 * event, correlated by `commandId`.
 *
 * Writes are synchronous on purpose: volumes are low, and these servers mutate real
 * things -- map sources, addon files, a running game server. If the process dies
 * mid-action we want the record of what it had already touched.
 */
export class AuditLog<K extends string = BaseAuditKind> {
  private readonly file: string;

  constructor(stateDir: string) {
    const dir = join(stateDir, "logs");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "audit.jsonl");
  }

  record(entry: Omit<AuditEntry<K>, "ts"> & { ts?: number }): void {
    const full: AuditEntry<K> = { ts: entry.ts ?? Date.now(), ...entry };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
  }

  get path(): string {
    return this.file;
  }
}
