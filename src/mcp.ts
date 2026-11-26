import { validate } from "./args.ts";
import { COMMANDS, type Command } from "./commands.ts";
import { toCliError } from "./errors.ts";
import { PROGRAM } from "./help.ts";

/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * It implements the lifecycle (initialize, ping) and tools (tools/list, tools/call); nothing else.
 * Standard output carries protocol messages only; diagnostics go to standard error.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Id = string | number;

interface Message {
  jsonrpc?: unknown;
  id?: Id | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function inputSchema(command: Command) {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const arg of command.args) properties[arg.name] = { type: "string", description: arg.description };
  for (const option of command.options) {
    properties[option.name] = {
      type: "string",
      description: option.description,
      ...(option.choices && { enum: option.choices }),
      ...(option.default !== undefined && { default: option.default }),
    };
  }
  const required = [...command.args.map((a) => a.name), ...command.options.filter((o) => o.required).map((o) => o.name)];
  return { type: "object", properties, required, additionalProperties: false };
}

const TOOLS = COMMANDS.map((c) => ({
  name: c.name,
  description: `${c.description}\n\nReturns: ${c.output}`,
  inputSchema: inputSchema(c),
}));

async function callTool(params: Record<string, unknown> | undefined) {
  const name = params?.name;
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) throw new RpcError(INVALID_PARAMS, `unknown tool: ${String(name)}`);
  const args = params?.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
  // Bad arguments and failed runs are tool errors, not protocol errors, so the model sees the message and can retry
  try {
    const result = await command.run(validate(command, args as Record<string, unknown>, "mcp"));
    return { content: [{ type: "text", text: result.text || "(empty)" }] };
  } catch (e) {
    const err = toCliError(e);
    const text = `Error: ${err.message}${err.hint ? `\n${err.hint}` : ""}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

async function dispatch(method: string, params: Record<string, unknown> | undefined, version: string): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return {
        protocolVersion:
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: PROGRAM, version },
        instructions:
          "Read and edit Notion pages with the user's browser session. Pages are given as URLs or IDs; " +
          "read-page tags every block with [block:<id>], which the editing tools take as block_id or after.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(line: string, version: string): Promise<void> {
  let message: Message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } });
    return;
  }
  const id = message.id;
  const isRequest = id !== undefined && id !== null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    // Responses to server-initiated requests would land here; this server sends none, so ignore them
    if (isRequest && message.method !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "invalid request" } });
    }
    return;
  }
  // Notifications (no id), e.g. notifications/initialized and notifications/cancelled, need no response
  if (!isRequest) return;
  try {
    send({ jsonrpc: "2.0", id, result: await dispatch(message.method, message.params, version) });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    send({ jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } });
  }
}

export async function serve(version: string): Promise<void> {
  const pending = new Set<Promise<void>>();
  // Bun's console async iterator yields standard input line by line
  for await (const line of console) {
    if (!line.trim()) continue;
    const task = handle(line, version).finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
