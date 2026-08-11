import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { findRepoRoot, loadConfig } from "../src/config.js";
import { installProject, installReport } from "../src/install.js";

const Schema = z.object({
  repoRoot: z.string().optional(),
  toolAllowlist: z.array(z.string()).default([]),
  backend: z.enum(["wine", "proton"]).default("wine"),
});

const ENV = "MCP_CORE_TEST_REPO";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-core-"));
  writeFileSync(join(root, "CLAUDE.md"), "marker\n");
  delete process.env[ENV];
});

afterEach(() => {
  delete process.env[ENV];
  rmSync(root, { recursive: true, force: true });
});

const spec = { envVar: ENV, stateDirName: ".test-mcp", schema: Schema };

describe("findRepoRoot", () => {
  it("walks up to the directory carrying a marker", () => {
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });

  it("returns undefined when no marker is ever found", () => {
    // The negative control: without it, a walk that always succeeds by accident
    // (say, matching "/") would look identical to a correct one.
    const orphan = mkdtempSync(join(tmpdir(), "mcp-core-orphan-"));
    try {
      expect(findRepoRoot(orphan, ["this-marker-does-not-exist"])).toBeUndefined();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

describe("loadConfig", () => {
  it("falls back to schema defaults when no file exists", () => {
    const cfg = loadConfig(spec, root);
    expect(cfg.repoRoot).toBe(root);
    expect(cfg.stateDir).toBe(join(root, ".test-mcp"));
    expect(cfg.backend).toBe("wine");
    expect(cfg.toolAllowlist).toEqual([]);
  });

  it("reads the file and lets it override defaults", () => {
    mkdirSync(join(root, ".test-mcp"), { recursive: true });
    writeFileSync(
      join(root, ".test-mcp", "config.json"),
      JSON.stringify({ backend: "proton", toolAllowlist: ["write_thing"] }),
    );
    const cfg = loadConfig(spec, root);
    expect(cfg.backend).toBe("proton");
    expect(cfg.toolAllowlist).toEqual(["write_thing"]);
  });

  it("prefers the env var over the file's repoRoot", () => {
    mkdirSync(join(root, ".test-mcp"), { recursive: true });
    writeFileSync(
      join(root, ".test-mcp", "config.json"),
      JSON.stringify({ repoRoot: "/from/file" }),
    );
    process.env[ENV] = root;
    expect(loadConfig(spec, root).repoRoot).toBe(root);
  });

  it("refuses a malformed config rather than silently using defaults", () => {
    // A server that ignores the settings it was handed is worse than one that
    // refuses to start: the operator never learns their file did nothing.
    mkdirSync(join(root, ".test-mcp"), { recursive: true });
    writeFileSync(
      join(root, ".test-mcp", "config.json"),
      JSON.stringify({ backend: "vulkan" }),
    );
    expect(() => loadConfig(spec, root)).toThrow();
  });
});

describe("installProject", () => {
  const base = {
    serverName: "hammer-mcp",
    envVar: "HAMMER_MCP_REPO",
    entryPath: "/abs/hammer-mcp/dist/index.js",
  };

  it("writes the entry with the entry path it was given", () => {
    const { path, entry } = installProject({ ...base, repoRoot: root });
    expect(path).toBe(join(root, ".mcp.json"));
    expect(entry).toMatchObject({
      command: "node",
      args: ["/abs/hammer-mcp/dist/index.js"],
      env: { HAMMER_MCP_REPO: root },
    });
  });

  it("preserves a sibling server already declared", () => {
    // This is the whole point: the two servers install independently, and an
    // install that evicted the other would break the repo silently.
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "gmod-mcp": { command: "node", args: ["x"] } } }),
    );
    installProject({ ...base, repoRoot: root });
    const written = JSON.parse(
      readFileSync(join(root, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["gmod-mcp", "hammer-mcp"]);
  });

  it("survives an unparseable .mcp.json instead of throwing", () => {
    writeFileSync(join(root, ".mcp.json"), "{ not json");
    expect(() => installProject({ ...base, repoRoot: root })).not.toThrow();
  });

  it("names the server and env var it was given in the report", () => {
    const spec2 = { ...base, repoRoot: root };
    const report = installReport(spec2, join(root, ".mcp.json"));
    expect(report).toContain("hammer-mcp installed");
    expect(report).toContain("HAMMER_MCP_REPO");
    expect(report).not.toContain("gmod-mcp");
  });
});
