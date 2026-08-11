import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { z } from "zod";

/**
 * Files that identify the root of the Project Society repo. Both servers walk up looking
 * for the same markers: they are siblings inside it, not standalone tools.
 */
export const REPO_MARKERS = ["tools/lint.sh", "CLAUDE.md"];

function looksLikeRepoRoot(dir: string, markers: readonly string[]): boolean {
  return markers.some((m) => existsSync(join(dir, m)));
}

/** Walks up from `start` until it finds the repo root. */
export function findRepoRoot(
  start: string,
  markers: readonly string[] = REPO_MARKERS,
): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (looksLikeRepoRoot(dir, markers)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveRepoRoot(
  envRoot: string | undefined,
  fileRoot: string | undefined,
  fallback: string,
): string {
  const candidate = envRoot ?? fileRoot ?? fallback;
  return isAbsolute(candidate) ? candidate : resolve(fallback, candidate);
}

/** What a server must tell the loader about itself. */
export interface ConfigSpec<S extends z.ZodType<{ repoRoot?: string }>> {
  /** Environment variable naming the repo root, e.g. `HAMMER_MCP_REPO`. */
  envVar: string;
  /** State directory name under the repo root, e.g. `.hammer-mcp`. */
  stateDirName: string;
  /** The server's own schema. Every field must be optional or defaulted. */
  schema: S;
  /** Overridden only by tests. */
  markers?: readonly string[];
}

export type LoadedConfig<S extends z.ZodType<{ repoRoot?: string }>> = z.infer<S> & {
  repoRoot: string;
  /** Runtime state directory: `<repoRoot>/<stateDirName>`. */
  stateDir: string;
};

/**
 * Loads a server's effective configuration from `<repoRoot>/<stateDirName>/config.json`
 * when present, otherwise from the schema's defaults. The root is resolved in this order:
 * 1. the env var  2. the file's `repoRoot` field  3. walking up from cwd.
 *
 * A malformed config file is a hard error rather than a silent fallback to defaults: a
 * server that quietly ignores the settings it was given is worse than one that refuses to
 * start.
 */
export function loadConfig<S extends z.ZodType<{ repoRoot?: string }>>(
  spec: ConfigSpec<S>,
  cwd: string = process.cwd(),
): LoadedConfig<S> {
  const envRoot = process.env[spec.envVar];

  const probeRoot = envRoot ?? findRepoRoot(cwd, spec.markers ?? REPO_MARKERS) ?? cwd;
  const configPath = join(probeRoot, spec.stateDirName, "config.json");

  let fromFile = spec.schema.parse({});
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    fromFile = spec.schema.parse(raw);
  }

  const repoRoot = resolveRepoRoot(envRoot, fromFile.repoRoot, probeRoot);
  return {
    ...fromFile,
    repoRoot,
    stateDir: join(repoRoot, spec.stateDirName),
  };
}
