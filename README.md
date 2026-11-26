# notion-proxy

Read and edit Notion pages as a **guest**, using your browser session. A non-interactive CLI, plus a stdio MCP server for AI clients.

The official Notion API and Notion MCP integration only work in workspaces where you can install an integration. notion-proxy calls Notion's internal API with your logged-in browser cookies instead, so it can do anything you can do in the browser, including on pages in someone else's workspace.

## Usage

Requires [Bun](https://bun.sh). Nothing to install; run it straight from GitHub:

```bash
bunx github:kdm1jkm/notion-proxy help
bunx github:kdm1jkm/notion-proxy read-page https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef
```

`help` prints everything needed to use the tool: commands, arguments, authentication, output, and exit status. It is written to be enough on its own, for a person or for an AI agent given only the command `bunx github:kdm1jkm/notion-proxy help`.

| Command | Does |
|---|---|
| `read-page <page>` | Print a page as Markdown, each block tagged with `[block:<id>]` |
| `read-comments <page>` | Print discussions and comments |
| `add-comment <page> --text <text> [--discussion-id <id>]` | Start a discussion, or reply to one |
| `add-block <page> --text <text> [--type <type>] [--language <lang>] [--after <block>]` | Add a block |
| `edit-block <block> --text <text> [--property <key>]` | Replace a block's text, or a table cell |
| `delete-block <block>` | Delete a block |
| `add-image <page> <source> [--after <block>]` | Add an image from a URL or a local file |
| `create-page <parent> --title <title> [--after <block>]` | Create a child page |
| `mcp` | Run as a stdio MCP server |

Conventions:

- Every command does one thing and exits. Nothing is asked interactively.
- `--json` prints results, and errors, as JSON.
- `--text -` reads the text from standard input.
- Results go to standard output, errors to standard error.
- Exit status: `0` success, `1` Notion, authentication, or network error, `2` usage error.

Run `help <command>` for a command's options, output, and examples.

### Pinning a version

`bunx github:kdm1jkm/notion-proxy` runs the default branch. Pin a tag or commit with `bunx github:kdm1jkm/notion-proxy#<tag>`.

## Authentication

Cookies are read from Firefox's cookie store, so being logged in to notion.so in Firefox is enough. The store is re-read at most once a minute, so session renewals are picked up.

| OS | Firefox profiles |
|----|------|
| macOS | `~/Library/Application Support/Firefox/Profiles/` |
| Linux | `~/.mozilla/firefox/` |
| Windows | `%APPDATA%\Mozilla\Firefox\Profiles\` |

Without Firefox, set `NOTION_COOKIE` to the `Cookie` header of a logged-in notion.so request (browser devtools > Network). Put it in the environment, or in a `.env` file in the current directory (see `.env.example`).

Write access is whatever your Notion account has: a read-only guest can only read.

## MCP server

`mcp` serves every command as an MCP tool with the same name. Tool arguments use the argument and option names in snake_case, for example `page`, `block_id`, `discussion_id`.

Add it to an MCP client, for example in `~/.claude.json`:

```json
{
  "mcpServers": {
    "notion-proxy": {
      "type": "stdio",
      "command": "bunx",
      "args": ["github:kdm1jkm/notion-proxy", "mcp"]
    }
  }
}
```

## Development

```bash
bun install          # type-checking tools only; there are no runtime dependencies
bun run check        # tsc --noEmit
bun bin/notion-proxy.ts help
```

Commands are defined once in `src/commands.ts`. The CLI parser (`src/args.ts`), help text (`src/help.ts`), and MCP tool list (`src/mcp.ts`) are all generated from that definition. Notion API access lives in `src/notion.ts`.
