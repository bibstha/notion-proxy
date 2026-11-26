#!/usr/bin/env bun
import { closest, parse } from "../src/args.ts";
import { COMMANDS, type Command } from "../src/commands.ts";
import { CliError, toCliError } from "../src/errors.ts";
import { commandHelp, mainHelp, PROGRAM, RUN_PREFIX, usage } from "../src/help.ts";
import { serve } from "../src/mcp.ts";
import { version } from "../package.json";

const MCP_HELP = `Usage: ${PROGRAM} mcp

Run as an MCP (Model Context Protocol) server over stdio. Every other command is exposed as a
tool with the same name; tool arguments use the argument and option names in snake_case, e.g.
{ "page": "...", "discussion_id": "..." }. The server runs until standard input closes.

Register it with an MCP client, e.g. in ~/.claude.json:
  "mcpServers": {
    "notion-proxy": { "type": "stdio", "command": "bunx", "args": ["github:kdm1jkm/notion-proxy", "mcp"] }
  }

Example:
  ${RUN_PREFIX} mcp
`;

const HELP_HELP = `Usage: ${PROGRAM} help [command]

Show the overview, or the options, output, and examples of one command.
`;

function writeError(err: CliError, json: boolean, command?: Command): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint } })}\n`);
    return;
  }
  const lines = [`${PROGRAM}${command ? ` ${command.name}` : ""}: ${err.message}`];
  if (err.hint) lines.push(err.hint);
  if (err.code === "usage") {
    if (command) lines.push(usage(command));
    lines.push(`Run '${PROGRAM} help${command ? ` ${command.name}` : ""}' for details.`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

function findCommand(name: string): Command {
  const command = COMMANDS.find((c) => c.name === name);
  if (command) return command;
  const suggestion = closest(name, [...COMMANDS.map((c) => c.name), "mcp", "help"]);
  throw new CliError("usage", `unknown command '${name}'${suggestion ? `; did you mean '${suggestion}'?` : ""}`);
}

function helpFor(name: string): string {
  if (name === "mcp") return MCP_HELP;
  if (name === "help") return HELP_HELP;
  return commandHelp(findCommand(name));
}

async function main(argv: string[]): Promise<number> {
  // --json is global: accept it anywhere before a "--" separator
  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const json = head.includes("--json");
  const args = json ? [...head.filter((a) => a !== "--json"), ...(separator === -1 ? [] : argv.slice(separator))] : argv;
  const [name, ...rest] = args;
  let command: Command | undefined;

  try {
    if (name === undefined) {
      process.stderr.write(mainHelp(version));
      return 2;
    }
    if (name === "-h" || name === "--help") {
      process.stdout.write(mainHelp(version));
      return 0;
    }
    if (name === "-V" || name === "--version") {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    if (name === "help") {
      if (rest.length > 1) throw new CliError("usage", `unexpected argument '${rest[1]}'`);
      process.stdout.write(rest[0] === undefined ? mainHelp(version) : helpFor(rest[0]));
      return 0;
    }
    if (name === "mcp") {
      if (rest.includes("-h") || rest.includes("--help")) {
        process.stdout.write(MCP_HELP);
        return 0;
      }
      if (rest.length) throw new CliError("usage", `mcp takes no arguments, got '${rest[0]}'`);
      await serve(version);
      return 0;
    }
    if (name.startsWith("-")) throw new CliError("usage", `unknown option ${name}; options go after the command`);

    command = findCommand(name);
    const parsed = await parse(command, rest);
    if (parsed.help) {
      process.stdout.write(commandHelp(command));
      return 0;
    }
    const result = await command.run(parsed.input);
    const out = json ? JSON.stringify(result.json, null, 2) : result.text;
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    return 0;
  } catch (e) {
    const err = toCliError(e);
    writeError(err, json, command);
    return err.exitCode;
  }
}

process.exitCode = await main(process.argv.slice(2));
