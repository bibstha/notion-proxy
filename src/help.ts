import { flagName } from "./args.ts";
import { COMMANDS, type Command, type Option } from "./commands.ts";

export const PROGRAM = "notion-proxy";
export const RUN_PREFIX = "bunx github:kdm1jkm/notion-proxy";

/** Lays out "term  description" rows with the descriptions aligned, wrapping long descriptions. */
function table(rows: [string, string][], width = 100): string {
  const termWidth = Math.max(...rows.map(([term]) => term.length)) + 2;
  const descWidth = Math.max(30, width - 2 - termWidth);
  const lines: string[] = [];
  for (const [term, desc] of rows) {
    const words = desc.split(" ");
    const wrapped: string[] = [];
    let line = "";
    for (const word of words) {
      if (line && line.length + 1 + word.length > descWidth) {
        wrapped.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    wrapped.push(line);
    lines.push(`  ${term.padEnd(termWidth)}${wrapped[0]}`);
    for (const rest of wrapped.slice(1)) lines.push(`  ${" ".repeat(termWidth)}${rest}`);
  }
  return lines.join("\n");
}

export function usage(command: Command): string {
  const parts = [PROGRAM, command.name, ...command.args.map((a) => `<${a.label ?? a.name}>`)];
  for (const option of command.options.filter((o) => o.required)) parts.push(`${flagName(option)} ${option.value}`);
  if (command.options.some((o) => !o.required)) parts.push("[options]");
  return `Usage: ${parts.join(" ")}`;
}

function optionRow(option: Option): [string, string] {
  const term = `${option.short ? `-${option.short}, ` : "    "}${flagName(option)} ${option.value}`;
  let desc = option.description;
  if (option.stdin) desc += "; '-' reads standard input";
  if (option.choices) desc += `. One of: ${option.choices.join(", ")}`;
  if (option.default !== undefined) desc += ` (default: ${option.default})`;
  if (option.required) desc += " (required)";
  return [term, desc];
}

export function commandHelp(command: Command): string {
  const sections = [usage(command), command.description];
  if (command.args.length) {
    sections.push(`Arguments:\n${table(command.args.map((a) => [`<${a.label ?? a.name}>`, a.description]))}`);
  }
  sections.push(
    `Options:\n${table([
      ...command.options.map(optionRow),
      ["    --json", "Print the result as JSON"],
      ["-h, --help", "Show this help"],
    ])}`,
  );
  sections.push(`Output:\n  ${command.output}\n  With --json: ${command.json.replace(/\n/g, "\n  ")}`);
  sections.push(`Examples:\n${command.examples.map((e) => `  ${e}`).join("\n")}`);
  return `${sections.join("\n\n")}\n`;
}

export function mainHelp(version: string): string {
  const commandRows: [string, string][] = COMMANDS.map((c) => [
    [c.name, ...c.args.map((a) => `<${a.label ?? a.name}>`)].join(" "),
    c.summary,
  ]);
  commandRows.push(["mcp", "Run as an MCP server over stdio, exposing the commands above as tools"]);
  commandRows.push(["help [command]", "Show help for a command"]);

  return `${PROGRAM} ${version} - read and edit Notion pages as a guest, using your browser session

${PROGRAM} talks to Notion's internal API with your logged-in browser cookies, so it can read
and write any page you can open in the browser, including pages in workspaces where you are only
a guest. Each command does one thing and exits; nothing is ever asked interactively.

Usage:
  ${RUN_PREFIX} <command> [arguments] [options]
  (examples below write '${PROGRAM}' for short)

Commands:
${table(commandRows)}

Arguments:
${table([
  ["<page>, <parent>", "Notion page URL (https://www.notion.so/Title-<32 hex chars>), 32-character hex ID, or UUID"],
  ["<block>", "Block ID. read-page tags every block with [block:<id>]"],
])}

Global options:
${table([
  ["--json", "Print results, and errors, as JSON"],
  ["-h, --help", "Show help; after a command, show that command's help"],
  ["-V, --version", "Print the version"],
])}

Text options marked "'-' reads standard input" take multi-line text from a pipe: --text -

Authentication:
  Cookies are read from Firefox's cookie store, so being logged in to notion.so in Firefox is
  enough. Otherwise set NOTION_COOKIE to the Cookie header of a logged-in notion.so request,
  in the environment or in a .env file in the current directory.

Examples:
  ${PROGRAM} read-page https://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef
  ${PROGRAM} edit-block <block> --text "Updated wording"
  ${PROGRAM} add-block <page> --after <block> --type bulleted_list --text "New item"
  ${PROGRAM} read-comments <page> --json

Exit status:
  0  success
  1  Notion, authentication, or network error
  2  usage error (unknown command, missing or invalid argument)

Errors are printed to standard error; results to standard output.
Run '${PROGRAM} help <command>' for a command's options, output, and examples.
`;
}
