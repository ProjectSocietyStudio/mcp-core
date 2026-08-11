import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
}

export interface InstallSpec {
  /** Key under `mcpServers`, e.g. `hammer-mcp`. */
  serverName: string;
  /** Environment variable carrying the repo root, e.g. `HAMMER_MCP_REPO`. */
  envVar: string;
  repoRoot: string;
  /**
   * Absolute path to the server's `dist/index.js`.
   *
   * Passed in rather than derived from `import.meta.url`: this module lives in
   * `mcp-core`, so resolving `./index.js` against it would point at the shared package
   * instead of the server being installed. Each server computes it from its own module.
   */
  entryPath: string;
}

/**
 * Merges one server's entry into `<repoRoot>/.mcp.json` (project scope). Every other
 * declared server is preserved -- the two servers install independently and must never
 * evict each other.
 */
export function installProject(spec: InstallSpec): { path: string; entry: unknown } {
  const path = join(spec.repoRoot, ".mcp.json");
  let current: McpConfig = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as McpConfig;
    } catch {
      current = {};
    }
  }
  const entry = {
    command: "node",
    args: [spec.entryPath],
    env: { [spec.envVar]: spec.repoRoot },
  };
  const next: McpConfig = {
    ...current,
    mcpServers: { ...current.mcpServers, [spec.serverName]: entry },
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return { path, entry };
}

/** Renders the `install` subcommand's report. Callers write it to stdout. */
export function installReport(
  spec: InstallSpec,
  path: string,
  extraLines: readonly string[] = [],
): string {
  return [
    `${spec.serverName} installed (project scope): ${path}`,
    "",
    "Claude Code will load the server the next time it starts in this repo.",
    `Remember to add "${spec.serverName}" to enabledMcpjsonServers in .claude/settings.json.`,
    "Command-line equivalent:",
    `  claude mcp add ${spec.serverName} -e ${spec.envVar}=${spec.repoRoot} -- node ${spec.entryPath}`,
    ...extraLines,
    "",
  ].join("\n");
}
