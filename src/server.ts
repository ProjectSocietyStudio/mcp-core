import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BaseToolContext, ToolRegistry, ToolResult } from "./registry.js";
import { IMAGE_KEY, isCallAllowed, isToolImage } from "./registry.js";

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/**
 * Turns a handler's result into MCP content. A result carrying `_image` is split: the
 * rest of the object goes out as JSON text, the image as a real image block. Emitting it
 * as text would bill the model for base64 it cannot see.
 */
export function successResult(result: ToolResult, structured = false): CallToolResult {
  const image = result[IMAGE_KEY];
  const body = { ...result };
  if (isToolImage(image)) delete body[IMAGE_KEY];

  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(body, null, 2) },
  ];
  if (isToolImage(image)) {
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }

  // Only when the tool declared an output schema: the SDK rejects a successful call
  // that has one and returns no structured content.
  return { content, ...(structured ? { structuredContent: body } : {}) };
}

export interface ServerMeta {
  name: string;
  version: string;
  /**
   * Prose handed to the client at connection time.
   *
   * This matters more than it looks: with tool search, a client no longer loads every
   * tool definition upfront -- these instructions may be the only text it sees before
   * deciding whether to go looking for our tools at all. Say what the server is for and
   * when to reach for it, not how each tool works.
   */
  instructions?: string;
}

/**
 * Builds the MCP server and wires every tool in the registry into it. Every handler is
 * wrapped with auditing (call/result/error) and a confirmation gate for guarded tools.
 * No tool writes MCP plumbing of its own.
 *
 * No socket: the caller wires up the transport.
 */
export function createMcpServer<Ctx extends BaseToolContext, Realm extends string>(
  registry: ToolRegistry<Ctx, Realm>,
  ctx: Ctx,
  meta: ServerMeta,
): McpServer {
  const server = new McpServer(
    { name: meta.name, version: meta.version },
    meta.instructions ? { instructions: meta.instructions } : {},
  );

  for (const def of registry.list()) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
        ...(def.meta ? { _meta: def.meta } : {}),
        annotations: { title: def.name },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const commandId = randomUUID();
        const startedAt = Date.now();
        ctx.audit.record({
          kind: "tool_call",
          commandId,
          data: { tool: def.name, realm: def.realm, args },
        });

        if (!isCallAllowed(def, args, ctx.config.toolAllowlist)) {
          const msg = `Guarded tool "${def.name}": pass confirm:true (sensitive action, audited).`;
          ctx.audit.record({
            kind: "tool_result",
            commandId,
            data: { tool: def.name, ok: false, error: msg },
          });
          return textResult(msg, true);
        }

        try {
          const result = await def.handler(args, ctx);

          // Validated here rather than left to the SDK, because where it is checked
          // decides what the log says. The SDK validates downstream of everything this
          // wrapper can see, so a handler that succeeded and then failed validation was
          // recorded `ok: true` -- and one real session's log showed a tool called three
          // times without incident while the caller was looking at a hard protocol error
          // on one of them.
          if (def.outputSchema) {
            const parsed = z.object(def.outputSchema).safeParse(result);
            if (!parsed.success) {
              const first = parsed.error.issues[0];
              const where = first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "";
              // The retry warning is the load-bearing half. This error arrives after the
              // handler has done whatever it does, and a caller that retries a writer
              // applies its work a second time.
              const message =
                `${def.name} returned a result its declared output schema rejects -- ${where}. ` +
                `The handler had already run, so anything it writes or executes has happened: ` +
                `do NOT retry, read the state back instead. This is a defect in the tool.`;
              ctx.audit.record({
                kind: "tool_result",
                commandId,
                data: {
                  tool: def.name,
                  ok: false,
                  ms: Date.now() - startedAt,
                  error: message,
                  handlerRan: true,
                },
              });
              return textResult(message, true);
            }
          }

          ctx.audit.record({
            kind: "tool_result",
            commandId,
            data: { tool: def.name, ok: true, ms: Date.now() - startedAt },
          });
          return successResult(result, def.outputSchema !== undefined);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.audit.record({
            kind: "error",
            commandId,
            data: { tool: def.name, error: message, ms: Date.now() - startedAt },
          });
          return textResult(`${def.name} failed: ${message}`, true);
        }
      },
    );
  }

  return server;
}
