import type { z, ZodRawShape } from "zod";

/**
 * The minimum a server's tool context must carry for the shared plumbing to work.
 * Everything else -- a bridge, a lock, a patch engine, a write guard -- stays private to
 * the server that needs it.
 */
export interface BaseToolContext {
  config: { toolAllowlist: readonly string[] };
  audit: {
    record(entry: {
      kind: string;
      commandId?: string;
      data?: Record<string, unknown>;
    }): void;
  };
}

/** What a handler returns: a serialisable JSON object exposed to the agent. */
export type ToolResult = Record<string, unknown>;

/**
 * An image the agent should actually SEE, carried under `IMAGE_KEY` in a ToolResult.
 *
 * Without this, a screenshot comes back as base64 inside a text block: the model is
 * billed for every byte and still cannot look at the picture. The failure is silent --
 * the tool returns, the tests pass, and the "see" half of an act/see loop quietly does
 * nothing. `createMcpServer` lifts the key out of the JSON body and emits a real image
 * content block, so the payload is never billed twice.
 */
export interface ToolImage {
  /** Base64 payload, with no `data:` prefix. */
  data: string;
  /** MIME type, e.g. `image/jpeg`. */
  mimeType: string;
}

export const IMAGE_KEY = "_image";

export function isToolImage(value: unknown): value is ToolImage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["data"] === "string" && typeof v["mimeType"] === "string";
}

/**
 * Definition of an MCP tool. The zod `shape` describes the inputs; the handler receives
 * arguments already validated and typed.
 *
 * `guarded: true` means the call requires `confirm: true` in its args (or the tool's name
 * in the config allowlist), otherwise it is refused without running. Guarded tools MUST
 * declare `confirm` in their `inputSchema`: zod strips undeclared keys, so a guarded tool
 * that omits it can never be called at all.
 */
export interface ToolDef<
  Ctx extends BaseToolContext,
  Realm extends string = string,
  Shape extends ZodRawShape = ZodRawShape,
> {
  name: string;
  description: string;
  realm: Realm;
  guarded?: boolean;
  inputSchema: Shape;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    ctx: Ctx,
  ) => Promise<ToolResult> | ToolResult;
}

/** Shape-erased version, as stored in the registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef<Ctx extends BaseToolContext, Realm extends string = string> =
  ToolDef<Ctx, Realm, any>;

/** In-memory tool registry, keyed by name. */
export class ToolRegistry<Ctx extends BaseToolContext, Realm extends string = string> {
  private readonly tools = new Map<string, AnyToolDef<Ctx, Realm>>();

  register(def: AnyToolDef<Ctx, Realm>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  registerAll(defs: readonly AnyToolDef<Ctx, Realm>[]): void {
    for (const d of defs) this.register(d);
  }

  get(name: string): AnyToolDef<Ctx, Realm> | undefined {
    return this.tools.get(name);
  }

  list(): AnyToolDef<Ctx, Realm>[] {
    return [...this.tools.values()];
  }
}

/**
 * Decides whether a call to a guarded tool is allowed: when it is not guarded, when
 * `confirm === true`, or when its name is in the allowlist.
 */
export function isCallAllowed(
  def: { name: string; guarded?: boolean },
  args: Record<string, unknown>,
  allowlist: readonly string[],
): boolean {
  if (!def.guarded) return true;
  if (args["confirm"] === true) return true;
  return allowlist.includes(def.name);
}

/**
 * Binds the generic machinery to one server's context and realm vocabulary, so tool
 * modules can write `defineTool({...})` and keep full inference on `inputSchema` without
 * naming type parameters at every definition site.
 */
export function makeToolkit<Ctx extends BaseToolContext, Realm extends string = string>() {
  return {
    defineTool<Shape extends ZodRawShape>(
      def: ToolDef<Ctx, Realm, Shape>,
    ): ToolDef<Ctx, Realm, Shape> {
      return def;
    },
    createRegistry(): ToolRegistry<Ctx, Realm> {
      return new ToolRegistry<Ctx, Realm>();
    },
  };
}
