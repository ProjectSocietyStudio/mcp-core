import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "../src/logger.js";
import { makeToolkit, type BaseToolContext } from "../src/registry.js";
import { createMcpServer, type ServerMeta } from "../src/server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Realm = "map" | "local";
interface Ctx extends BaseToolContext {
  config: { toolAllowlist: string[] };
  audit: AuditLog;
}

const { defineTool, createRegistry } = makeToolkit<Ctx, Realm>();

const tools = [
  defineTool({
    name: "read_thing",
    description: "reads",
    realm: "map",
    inputSchema: { n: z.number() },
    handler: (args) => ({ doubled: args.n * 2 }),
  }),
  defineTool({
    name: "write_thing",
    description: "writes",
    realm: "map",
    guarded: true,
    inputSchema: { confirm: z.boolean().default(false) },
    handler: () => ({ wrote: true }),
  }),
  defineTool({
    name: "read_boom",
    description: "throws",
    realm: "map",
    inputSchema: {},
    handler: () => {
      throw new Error("kaboom");
    },
  }),
];

async function connect(meta: ServerMeta, allowlist: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-core-srv-"));
  const ctx: Ctx = {
    config: { toolAllowlist: allowlist },
    audit: new AuditLog(dir),
  };
  const registry = createRegistry();
  registry.registerAll(tools);
  const server = createMcpServer(registry, ctx, meta);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const META: ServerMeta = {
  name: "test-mcp",
  version: "1.2.3",
  instructions: "Reach for this when you need a thing.",
};

describe("createMcpServer", () => {
  it("delivers serverInstructions to the client", async () => {
    // With tool search, this prose may be the only thing a client reads before
    // deciding whether to look for our tools. An option that silently went
    // nowhere would be invisible in every other test.
    const { client, cleanup } = await connect(META);
    try {
      expect(client.getInstructions()).toBe("Reach for this when you need a thing.");
    } finally {
      cleanup();
    }
  });

  it("reports no instructions when none were set", async () => {
    // The negative control for the assertion above: proves it reads the value we
    // passed rather than some constant that happens to match.
    const { client, cleanup } = await connect({ name: "t", version: "0" });
    try {
      expect(client.getInstructions()).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("exposes every registered tool", async () => {
    const { client, cleanup } = await connect(META);
    try {
      const { tools: listed } = await client.listTools();
      expect(listed.map((t) => t.name).sort()).toEqual([
        "read_boom",
        "read_thing",
        "write_thing",
      ]);
    } finally {
      cleanup();
    }
  });

  it("runs an unguarded tool and returns its JSON", async () => {
    const { client, cleanup } = await connect(META);
    try {
      const r = await client.callTool({ name: "read_thing", arguments: { n: 21 } });
      const content = r.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]!.text)).toEqual({ doubled: 42 });
    } finally {
      cleanup();
    }
  });

  it("refuses a guarded tool without confirm, and runs it with", async () => {
    const { client, cleanup } = await connect(META);
    try {
      const refused = await client.callTool({ name: "write_thing", arguments: {} });
      expect(refused.isError).toBe(true);
      expect((refused.content as { text: string }[])[0]!.text).toContain("confirm:true");

      const ok = await client.callTool({
        name: "write_thing",
        arguments: { confirm: true },
      });
      expect(ok.isError).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("lets the allowlist stand in for confirm", async () => {
    const { client, cleanup } = await connect(META, ["write_thing"]);
    try {
      const ok = await client.callTool({ name: "write_thing", arguments: {} });
      expect(ok.isError).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("turns a thrown handler into an error result, not a dead transport", async () => {
    const { client, cleanup } = await connect(META);
    try {
      const r = await client.callTool({ name: "read_boom", arguments: {} });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0]!.text).toContain("read_boom failed");
      // The connection must survive it.
      const after = await client.listTools();
      expect(after.tools).toHaveLength(3);
    } finally {
      cleanup();
    }
  });
});
