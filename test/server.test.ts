import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "../src/logger.js";
import { makeToolkit, type BaseToolContext } from "../src/registry.js";
import { createMcpServer, type ServerMeta } from "../src/server.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    name: "read_measured",
    description: "returns a typed measurement",
    realm: "map",
    inputSchema: {},
    outputSchema: { units: z.number(), metres: z.number() },
    handler: () => ({ units: 31584, metres: 802.2 }),
  }),
  defineTool({
    name: "read_liar",
    description: "declares a shape and returns another",
    realm: "map",
    inputSchema: {},
    outputSchema: { units: z.number() },
    handler: () => ({ units: "not a number" }),
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
  const entries = (): Array<{ kind: string; data: Record<string, unknown> }> =>
    readFileSync(ctx.audit.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
  return { client, ctx, entries, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
        "read_liar",
        "read_measured",
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

  it("advertises the output schema and returns structured content", async () => {
    const { client, cleanup } = await connect(META);
    try {
      const listed = (await client.listTools()).tools;
      expect(listed.find((t) => t.name === "read_measured")?.outputSchema).toBeDefined();
      // A tool with no declared shape must NOT claim one -- otherwise the SDK
      // would reject every one of its successful calls.
      expect(listed.find((t) => t.name === "read_thing")?.outputSchema).toBeUndefined();

      const r = await client.callTool({ name: "read_measured", arguments: {} });
      expect(r.structuredContent).toEqual({ units: 31584, metres: 802.2 });
    } finally {
      cleanup();
    }
  });

  it("refuses a result that contradicts its declared output schema", async () => {
    // The negative control for the test above: it proves the schema is enforced
    // rather than merely advertised. Without it, a handler could drift from its
    // declared shape and every test would still pass.
    //
    // The violation becomes an error result rather than a rejection, so the transport
    // survives a mismatched tool -- worth pinning, because it is the difference between
    // one broken tool and a dead server.
    //
    // The check now runs in this wrapper rather than in the SDK downstream of it, which
    // is why the wording being matched is ours. That move is the point: validating where
    // the audit log can see it is what stopped these failures being recorded as
    // successes.
    const { client, cleanup } = await connect(META);
    try {
      const r = await client.callTool({ name: "read_liar", arguments: {} });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0]!.text).toMatch(/output schema rejects/i);

      const after = await client.callTool({ name: "read_thing", arguments: { n: 1 } });
      expect(after.isError).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  /**
   * The audit log's blind spot, found by reading it back after a real session and not
   * believing it.
   *
   * A handler that succeeds and then fails output validation was recorded `ok: true`,
   * because the recording happened before the SDK ever looked at the shape. So the log
   * said a tool had been called three times without incident while the caller was staring
   * at a hard protocol error on one of them -- and that error came *after* the tool had
   * written a file. The objective half of a measurement missed the most dangerous bug of
   * the session it was measuring.
   */
  it("records an output-schema failure as a failure, not as a success", async () => {
    const { client, entries, cleanup } = await connect(META);
    try {
      await client.callTool({ name: "read_liar", arguments: {} });

      const results = entries().filter((e) => e.kind === "tool_result" || e.kind === "error");
      const mine = results.filter((e) => e.data.tool === "read_liar");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.data.ok).toBe(false);
      expect(String(mine[0]!.data.error)).toMatch(/output/i);

      // The half that matters more than the label: whatever the handler did, it did.
      // An error that does not say so invites a retry, and a retry of a writer applies
      // its work twice.
      expect(String(mine[0]!.data.error)).toMatch(/already ran|had already/i);
    } finally {
      cleanup();
    }
  });

  it("records how long each call took", async () => {
    const { client, entries, cleanup } = await connect(META);
    try {
      await client.callTool({ name: "read_thing", arguments: { n: 1 } });
      const result = entries().find(
        (e) => e.kind === "tool_result" && e.data.tool === "read_thing",
      );
      expect(result).toBeDefined();
      expect(typeof result!.data.ms).toBe("number");
      expect(result!.data.ms as number).toBeGreaterThanOrEqual(0);
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
      expect(after.tools).toHaveLength(5);
    } finally {
      cleanup();
    }
  });
});
