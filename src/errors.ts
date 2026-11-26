/**
 * Error categories, shared by the CLI (exit codes, --json errors) and the MCP server.
 * usage: the caller passed a bad command, argument, option, or value. Exit status 2.
 * auth, notion, network: the request was well-formed but could not be carried out. Exit status 1.
 * internal: an unexpected failure inside notion-proxy. Exit status 1.
 */
export type ErrorCode = "usage" | "auth" | "notion" | "network" | "internal";

export class CliError extends Error {
  override name = "CliError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** What the user can do about it. Printed on its own line under the message. */
    readonly hint?: string,
  ) {
    super(message);
  }

  get exitCode(): number {
    return this.code === "usage" ? 2 : 1;
  }
}

export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new CliError("internal", `unexpected error: ${message}`);
}
