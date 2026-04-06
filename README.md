# notion-proxy

An MCP server that proxies Notion's internal API using your browser cookies. This lets Claude Code (or any MCP client) read and write Notion pages where you're a **guest** — something the official Notion API and Notion MCP integration cannot do.

## Why?

The official Notion API only works with pages in workspaces where you have an integration installed. If you're a guest on someone else's workspace, you can't:

- Use the Notion API (no integration access)
- Use the official Notion MCP plugin (requires OAuth to a workspace you don't own)

This proxy solves that by using your browser session cookies directly, giving you the same access you have in the browser.

## Features

- **read-page** — Read page content as markdown (with block IDs for editing)
- **read-comments** — Read all discussions/comments with authors and timestamps
- **add-comment** — Create new discussions or reply to existing ones
- **edit-block** — Update any text block's content
- **add-block** — Append new blocks to a page
- **delete-block** — Remove blocks from a page

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Cookie authentication

The server automatically reads cookies from your **Firefox** browser's cookie store. Just be logged into Notion in Firefox — no manual cookie export needed.

Cookies are cached for 60 seconds and re-read from Firefox's `cookies.sqlite` on each refresh, so session renewals are picked up automatically.

**Fallback:** If Firefox isn't available, create a `.env` file:

```
NOTION_COOKIE=<full cookie header string from browser devtools>
```

### 3. Register as a global MCP server

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "notion-proxy": {
      "command": "node",
      "args": ["/path/to/notion-proxy/server.mjs"],
      "type": "stdio"
    }
  }
}
```

Restart Claude Code. The `notion-proxy` tools will be available in every project.

## Usage

Once configured, ask Claude Code to interact with any Notion page by URL:

```
Read this page: https://www.notion.so/My-Page-abc123...
```

Block IDs are included in `read-page` output (e.g. `[block:uuid]`), so you can reference specific blocks for editing or commenting.

## Limitations

- **macOS + Firefox only** for auto cookie refresh (reads `~/Library/Application Support/Firefox/Profiles/*/cookies.sqlite`)
- Cookies expire when your Firefox session expires — just log in again
- Write access depends on your actual Notion permissions (guest with read-only can only read)
