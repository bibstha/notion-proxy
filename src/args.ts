import type { Command, Input, Option } from "./commands.ts";
import { CliError } from "./errors.ts";

/** How option names appear in messages: CLI flags, or MCP property names. */
export type Surface = "cli" | "mcp";

export function flagName(option: Option): string {
  return `--${option.name.replace(/_/g, "-")}`;
}

function optionLabel(option: Option, surface: Surface): string {
  return surface === "cli" ? flagName(option) : option.name;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The closest candidate within a small edit distance, for "did you mean" hints. */
export function closest(input: string, candidates: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = levenshtein(input, name);
    if (distance <= Math.max(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best?.name;
}

/**
 * Validates named input against a command's arguments and options: rejects unknown names,
 * non-string values, missing required values, and values outside `choices`; fills in defaults.
 */
export function validate(command: Command, raw: Record<string, unknown>, surface: Surface): Input {
  const input: Input = {};
  const known = new Map<string, string>();
  for (const arg of command.args) known.set(arg.name, `<${arg.label ?? arg.name}>`);
  for (const option of command.options) known.set(option.name, optionLabel(option, surface));

  for (const [name, value] of Object.entries(raw)) {
    const label = known.get(name);
    if (!label) {
      const suggestion = closest(name, [...known.keys()]);
      throw new CliError("usage", `unknown argument '${name}'${suggestion ? `; did you mean '${suggestion}'?` : ""}`);
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new CliError("usage", `${label} must be a string`);
    input[name] = value;
  }

  for (const arg of command.args) {
    if (input[arg.name] === undefined || input[arg.name] === "") {
      throw new CliError("usage", `missing ${surface === "cli" ? `<${arg.label ?? arg.name}>` : `'${arg.name}'`}`);
    }
  }
  for (const option of command.options) {
    const value = input[option.name];
    if (value === undefined) {
      if (option.required) throw new CliError("usage", `missing required option ${optionLabel(option, surface)}`);
      if (option.default !== undefined) input[option.name] = option.default;
      continue;
    }
    if (option.choices && !option.choices.includes(value)) {
      throw new CliError(
        "usage",
        `invalid value '${value}' for ${optionLabel(option, surface)}; expected one of: ${option.choices.join(", ")}`,
      );
    }
  }
  return input;
}

export interface Parsed {
  help: boolean;
  input: Input;
}

/**
 * Parses CLI arguments for one command. Accepts `--name value`, `--name=value`, `-s value`, and `-svalue`;
 * everything after `--` is positional. An option whose value is "-" and that allows stdin reads standard input.
 */
export async function parse(command: Command, argv: string[]): Promise<Parsed> {
  const byLong = new Map(command.options.map((o) => [flagName(o), o]));
  const byShort = new Map(command.options.filter((o) => o.short).map((o) => [`-${o.short}`, o]));
  const raw: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-h" || token === "--help") return { help: true, input: {} };
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    let flag = token;
    let value: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) [flag, value] = [token.slice(0, eq), token.slice(eq + 1)];
    } else if (token.length > 2) {
      [flag, value] = [token.slice(0, 2), token.slice(2)];
    }

    const option = byLong.get(flag) ?? byShort.get(flag);
    if (!option) {
      const suggestion = closest(flag, [...byLong.keys()]);
      throw new CliError("usage", `unknown option ${flag}${suggestion ? `; did you mean ${suggestion}?` : ""}`);
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new CliError("usage", `option ${flagName(option)} requires a value ${option.value}`);
    }
    if (raw[option.name] !== undefined) throw new CliError("usage", `option ${flagName(option)} was given more than once`);
    raw[option.name] = value;
  }

  if (positionals.length > command.args.length) {
    throw new CliError("usage", `unexpected argument '${positionals[command.args.length]}'`);
  }
  command.args.forEach((arg, i) => {
    if (positionals[i] !== undefined) raw[arg.name] = positionals[i];
  });

  const stdinOption = command.options.find((o) => o.stdin && raw[o.name] === "-");
  if (stdinOption) {
    // A trailing newline comes from the pipe, not from the content
    raw[stdinOption.name] = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  }

  return { help: false, input: validate(command, raw, "cli") };
}
