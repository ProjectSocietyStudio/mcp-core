# @projectsociety/mcp-core

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Shared MCP plumbing: tool registry, confirmation guard, audit log, config loading, process
running.

```bash
npm install @projectsociety/mcp-core
```

**Extracted from two real MCP servers rather than designed in the abstract** —
[`hammer-mcp`](https://github.com/ProjectSocietyStudio/hammer-mcp), which drives the Source-engine
toolchain, and `gmod-mcp`, which drives a running game server. What follows says why it exists, and
above all what deliberately stayed behind in each server.

Node ≥ 20. `@modelcontextprotocol/sdk` ≥ 1.30 and `zod` ^3.23 are **peer dependencies**: the host
server provides them, so there is only ever one instance of the SDK.

## Why it exists

The two servers duplicated this plumbing **on purpose** — around 350 lines across two repositories,
where a shared package looked premature. The revision threshold was written down at the time: *a
third MCP server, or the same plumbing bug fixed twice.*

It was reached on 11/08/2026, on two fronts at once:

1. **The drift was already there.** `clip()` lived in one server's registry and had been copied
   twice into the other; `stripAnsi()` existed on only one side, the image block on only the other.
   Three divergences across six files.
2. **An SDK upgrade was coming.** Going from `^1.12` to `1.30` — and using what it unlocks
   (`outputSchema`, `serverInstructions`, elicitation, progress notifications) — would have had to
   be done and proven twice.

## What moves up, and what does not

| Moves up | Stays in the server |
|---|---|
| `ToolRegistry`, `defineTool`, `isCallAllowed` | its write guard — the trees it refuses are its own |
| `createMcpServer`, `successResult`, image blocks | the file transport and lock of the live-engine server |
| `AuditLog` | file backup and restore |
| `loadConfig`, `findRepoRoot` | each server's config **schema** |
| `run`, `clip`, `stripAnsi` | each server's `Realm` enum — `map`/`local` against `sv`/`cl`/`local` |

The core is **parameterised, not generic on principle**: `loadConfig` takes the environment
variable and the state directory name; `AuditLog` takes the server's own vocabulary of entry kinds;
`ToolDef` is generic over context and realm, so each server keeps its own typed `defineTool` via
`makeToolkit`.

`installProject` takes the entry-point path **as a parameter**. That is the trap of extraction: the
original computed it with `new URL("./index.js", import.meta.url)`, which, moved here, would have
resolved to the core's own `dist/` and installed the wrong binary.

## The oracle that proves the sharing is real

A passing test proves nothing until it has been shown it can fail — and a "shared" package that was
in fact copied would pass every test exactly the same way.

So the control is direct: break the guard in `src/registry.ts`, rebuild, and run all three suites.
Measured 11/08/2026:

| Suite | Result |
|---|---|
| `mcp-core` | 2 failures / 21 |
| `hammer-mcp` | 1 failure / 46 |
| `gmod-mcp` | 2 failures / 130 |

One byte changed here turns both servers red. That is the property the extraction was for.

## What the tool wrapper records

Every call goes through one wrapper, and what it writes to the audit log is a contract the
servers' own tooling reads back. Each `tool_result` and `error` carries `ms`; a result also
carries `ok`, and a failure carries `error`.

**A result that fails its own declared output schema is recorded as a failure**, which is less
obvious than it sounds. The SDK validates downstream of anything this wrapper can see, so a
handler that succeeded and then failed validation used to be recorded `ok: true` — one real
session's log showed a tool called three times without incident while the caller was looking at
a hard protocol error on one of them, raised *after* that tool had written a file.

So the validation happens here instead, and the error it produces says the thing the SDK's own
wording does not: **the handler already ran, so do not retry — read the state back.** A retry is
what an error invites, and retrying a writer applies its work twice. Such entries carry
`handlerRan: true`.

## Development

```bash
pnpm install
pnpm build       # tsc -> dist/
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit, tests included
```

Consumers read the published `dist/`. In local development — server checkouts beside this one,
consuming it through `file:../mcp-core` — **rebuilding is required** for a change to reach them.
The trap is paid once: a stale `dist/` makes tests green and typecheck red on the same tree.

## License

MIT. See [LICENSE](LICENSE).
