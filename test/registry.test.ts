import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isCallAllowed,
  makeToolkit,
  type BaseToolContext,
} from "../src/registry.js";
import { successResult } from "../src/server.js";
import { clip, stripAnsi } from "../src/text.js";

interface Ctx extends BaseToolContext {
  marker: string;
}
type Realm = "map" | "local";

const { defineTool, createRegistry } = makeToolkit<Ctx, Realm>();

const echo = defineTool({
  name: "read_echo",
  description: "echoes its input",
  realm: "local",
  inputSchema: { value: z.string() },
  handler: (args, ctx) => ({ value: args.value, marker: ctx.marker }),
});

const danger = defineTool({
  name: "write_danger",
  description: "guarded",
  realm: "map",
  guarded: true,
  inputSchema: { confirm: z.boolean().default(false) },
  handler: () => ({ ok: true }),
});

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const reg = createRegistry();
    reg.registerAll([echo, danger]);
    expect(reg.list().map((t) => t.name)).toEqual(["read_echo", "write_danger"]);
    expect(reg.get("read_echo")?.realm).toBe("local");
  });

  it("refuses a duplicate name rather than silently replacing it", () => {
    const reg = createRegistry();
    reg.register(echo);
    expect(() => reg.register(echo)).toThrow(/already registered/);
  });
});

describe("isCallAllowed", () => {
  it("lets an unguarded tool through", () => {
    expect(isCallAllowed(echo, {}, [])).toBe(true);
  });

  it("refuses a guarded tool without confirmation", () => {
    expect(isCallAllowed(danger, {}, [])).toBe(false);
    expect(isCallAllowed(danger, { confirm: false }, [])).toBe(false);
  });

  it("accepts confirm:true, or the name in the allowlist", () => {
    expect(isCallAllowed(danger, { confirm: true }, [])).toBe(true);
    expect(isCallAllowed(danger, {}, ["write_danger"])).toBe(true);
  });

  it("does not accept a truthy non-true confirm", () => {
    // The gate is an identity check, not a coercion: "yes" must not open it.
    expect(isCallAllowed(danger, { confirm: "yes" }, [])).toBe(false);
    expect(isCallAllowed(danger, { confirm: 1 }, [])).toBe(false);
  });
});

describe("successResult", () => {
  it("renders a plain result as JSON text", () => {
    const r = successResult({ a: 1 });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: "text" });
  });

  it("splits an _image key into a real image block", () => {
    const r = successResult({
      note: "hi",
      _image: { data: "AAAA", mimeType: "image/jpeg" },
    });
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    // The base64 must not also be billed as text.
    expect(JSON.stringify(r.content[0])).not.toContain("AAAA");
  });

  it("leaves a malformed _image inline rather than emitting a broken block", () => {
    const r = successResult({ _image: { data: 42 } });
    expect(r.content).toHaveLength(1);
  });
});

describe("text helpers", () => {
  it("clips past the limit and says how much it dropped", () => {
    expect(clip("abc", 10)).toBe("abc");
    const out = clip("x".repeat(50), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("40 bytes truncated");
  });

  it("strips ANSI colour", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripAnsi("plain")).toBe("plain");
  });
});
