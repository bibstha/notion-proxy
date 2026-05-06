import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, copyFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join, basename, extname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTION_BASE = "https://www.notion.so";
const API_BASE = `${NOTION_BASE}/api/v3`;

// --- Cookie loading ---

// Find Firefox default profile
function findFirefoxProfile() {
  const base = join(process.env.HOME, "Library/Application Support/Firefox/Profiles");
  if (!existsSync(base)) return null;
  const profiles = readdirSync(base);
  // Prefer default-release, then default, then any
  const pref = profiles.find((p) => p.endsWith(".default-release"))
    || profiles.find((p) => p.endsWith(".default"))
    || profiles[0];
  return pref ? join(base, pref) : null;
}

// Read Notion cookies from Firefox's cookies.sqlite (copied to avoid lock)
function loadCookiesFromFirefox() {
  const profile = findFirefoxProfile();
  if (!profile) return null;
  const src = join(profile, "cookies.sqlite");
  if (!existsSync(src)) return null;

  const tmp = "/tmp/notion_proxy_ff_cookies.sqlite";
  copyFileSync(src, tmp);
  // Also copy WAL/SHM if present (for consistency)
  try { copyFileSync(src + "-wal", tmp + "-wal"); } catch {}
  try { copyFileSync(src + "-shm", tmp + "-shm"); } catch {}

  const db = new Database(tmp, { readonly: true });
  const rows = db.prepare(
    "SELECT name, value FROM moz_cookies WHERE host LIKE '%notion.so' OR host LIKE '%notion.so'"
  ).all();
  db.close();

  if (!rows.length) return null;
  return rows.map((r) => `${r.name}=${r.value}`).join("; ");
}

// Load cookie: try Firefox first, then .env fallback
let _cookieCache = null;
let _cookieCacheTime = 0;
const COOKIE_TTL = 60_000; // re-read Firefox DB at most every 60s

function loadCookie() {
  const now = Date.now();
  if (_cookieCache && now - _cookieCacheTime < COOKIE_TTL) return _cookieCache;

  // Try Firefox
  try {
    const ffCookie = loadCookiesFromFirefox();
    if (ffCookie && ffCookie.includes("token_v2=")) {
      _cookieCache = ffCookie;
      _cookieCacheTime = now;
      return ffCookie;
    }
  } catch (e) {
    // Firefox read failed, fall through
  }

  // Fallback to .env
  try {
    const envPath = resolve(__dirname, ".env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^NOTION_COOKIE=(.+)$/);
      if (match) {
        _cookieCache = match[1].trim();
        _cookieCacheTime = now;
        return _cookieCache;
      }
    }
  } catch {}

  if (process.env.NOTION_COOKIE) return process.env.NOTION_COOKIE;
  throw new Error("No cookies found. Ensure Firefox has an active Notion session, or set NOTION_COOKIE in .env");
}

// Extract notion_user_id from cookie string
function extractUserId(cookie) {
  const match = cookie.match(/notion_user_id=([^;]+)/);
  return match ? match[1].trim() : null;
}

// Common headers for Notion internal API — re-reads cookies each call
function headers(spaceId) {
  const cookie = loadCookie();
  const userId = extractUserId(cookie);
  const h = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
    "Notion-Audit-Log-Platform": "web",
  };
  if (userId) h["x-notion-active-user-header"] = userId;
  if (spaceId) h["x-notion-space-id"] = spaceId;
  return h;
}

// Get spaceId for a block
async function getSpaceId(blockId) {
  const res = await fetch(`${API_BASE}/syncRecordValues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      requests: [{ pointer: { table: "block", id: blockId }, version: -1 }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.recordMap?.block?.[blockId]?.spaceId || data.recordMap?.block?.[blockId]?.value?.value?.space_id || null;
}

// Parse a Notion URL or raw ID into a UUID
function parsePageId(input) {
  // Extract the hex part from URL or raw input
  const match = input.match(/([a-f0-9]{32})$/i) || input.match(/([a-f0-9-]{36})/i);
  if (!match) throw new Error(`Cannot parse page ID from: ${input}`);
  const hex = match[1].replace(/-/g, "");
  // Format as UUID
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Fetch blocks via syncRecordValues
async function syncBlocks(blockIds) {
  const res = await fetch(`${API_BASE}/syncRecordValues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      requests: blockIds.map((id) => ({
        pointer: { table: "block", id },
        version: -1,
      })),
    }),
  });
  if (!res.ok) throw new Error(`syncRecordValues failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Recursively load a page and all its child blocks
async function loadPage(pageId) {
  const blocks = {};

  async function loadBlocks(ids) {
    if (!ids.length) return;
    const data = await syncBlocks(ids);
    const newChildIds = [];
    for (const [id, entry] of Object.entries(data.recordMap?.block || {})) {
      const block = entry?.value?.value;
      if (!block) continue;
      blocks[id] = block;
      if (block.content) {
        for (const childId of block.content) {
          if (!blocks[childId]) newChildIds.push(childId);
        }
      }
    }
    if (newChildIds.length) await loadBlocks(newChildIds);
  }

  await loadBlocks([pageId]);
  return blocks;
}

// Render a block and its children as markdown, preserving document order
function renderBlock(block, blocks, depth = 0) {
  const lines = [];
  const title = block.properties?.title;
  const text = title ? title.map((seg) => seg[0]).join("") : "";
  const indent = "  ".repeat(depth);
  const bid = block.id ? ` [block:${block.id}]` : "";

  switch (block.type) {
    case "page":
      if (text) lines.push(`# ${text}${bid}`);
      break;
    case "header":
      lines.push(`# ${text}${bid}`);
      break;
    case "sub_header":
      lines.push(`## ${text}${bid}`);
      break;
    case "sub_sub_header":
      lines.push(`### ${text}${bid}`);
      break;
    case "bulleted_list":
      lines.push(`${indent}- ${text}${bid}`);
      break;
    case "numbered_list":
      lines.push(`${indent}1. ${text}${bid}`);
      break;
    case "to_do": {
      const checked = block.properties?.checked?.[0]?.[0] === "Yes";
      lines.push(`${indent}- [${checked ? "x" : " "}] ${text}${bid}`);
      break;
    }
    case "toggle":
      lines.push(`${indent}<toggle> ${text}${bid}`);
      break;
    case "code":
      lines.push(`\`\`\`${bid}\n${text}\n\`\`\``);
      break;
    case "quote":
      lines.push(`> ${text}${bid}`);
      break;
    case "divider":
      lines.push(`---${bid}`);
      break;
    case "callout":
      lines.push(`> ${text}${bid}`);
      break;
    case "column_list":
    case "column":
      break; // just recurse into children
    default:
      if (text) lines.push(`${indent}${text}${bid}`);
      break;
  }

  // Recurse into children in order
  if (block.content) {
    for (const childId of block.content) {
      const child = blocks[childId];
      if (child) {
        const childDepth = ["bulleted_list", "numbered_list", "to_do"].includes(block.type) ? depth + 1 : depth;
        lines.push(...renderBlock(child, blocks, childDepth));
      }
    }
  }
  return lines;
}

function extractText(blocks, pageId) {
  const root = blocks[pageId];
  if (!root) return "(could not load page)";
  return renderBlock(root, blocks).join("\n");
}

// Fetch all page chunks (paginates through cursor to get all discussions/comments)
async function loadAllPageChunks(pageId) {
  let cursor = { stack: [] };
  let chunk = 0;
  let merged = { block: {}, discussion: {}, comment: {}, notion_user: {} };

  while (true) {
    const res = await fetch(`${API_BASE}/loadPageChunk`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        pageId,
        limit: 100,
        cursor,
        chunkNumber: chunk,
        verticalColumns: false,
      }),
    });
    if (!res.ok) throw new Error(`loadPageChunk failed: ${res.status} ${await res.text()}`);
    const data = await res.json();

    for (const table of ["block", "discussion", "comment", "notion_user"]) {
      Object.assign(merged[table], data.recordMap?.[table] || {});
    }

    if (!data.cursor?.stack?.length) break;
    cursor = data.cursor;
    chunk++;
    if (chunk > 20) break; // safety limit
  }

  return { recordMap: merged };
}

// Format discussions into readable text
function formatDiscussions(recordMap) {
  const discussions = recordMap?.discussion || {};
  const users = recordMap?.notion_user || {};
  const comments = recordMap?.comment || {};

  function userName(userId) {
    const user = users[userId]?.value?.value || users[userId]?.value;
    return user?.name || userId || "Unknown";
  }

  const lines = [];
  for (const [discId, discEntry] of Object.entries(discussions)) {
    const disc = discEntry?.value?.value || discEntry?.value;
    if (!disc) continue;

    const context = disc.context ? disc.context.map((seg) => seg[0]).join("") : "";
    lines.push(`\n--- Discussion ${disc.id} ---`);
    if (context) lines.push(`Context: "${context}"`);
    if (disc.resolved) lines.push("(RESOLVED)");
    lines.push(`Parent block: ${disc.parent_id}`);

    for (const commentId of disc.comments || []) {
      const commentEntry = comments[commentId];
      const comment = commentEntry?.value?.value || commentEntry?.value;
      if (!comment) continue;
      const author = userName(comment.created_by_id);
      const date = new Date(comment.created_time).toISOString();
      const text = (comment.text || []).map((seg) => seg[0]).join("");
      lines.push(`  [${date}] ${author}: ${text}`);
    }
  }
  return lines.length ? lines.join("\n") : "No discussions found.";
}

// Add a comment via saveTransactions
async function addComment(pageId, text, discussionId) {
  const spaceId = await getSpaceId(pageId);
  if (!spaceId) throw new Error("Could not determine spaceId for page");

  const userId = extractUserId(loadCookie());
  const commentId = crypto.randomUUID();

  if (!discussionId) {
    // Create new page-level discussion + comment
    const newDiscId = crypto.randomUUID();
    const res = await fetch(`${API_BASE}/saveTransactions`, {
      method: "POST",
      headers: headers(spaceId),
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        transactions: [{
          id: crypto.randomUUID(),
          spaceId,
          operations: [
            {
              pointer: { table: "discussion", id: newDiscId, spaceId },
              path: [],
              command: "set",
              args: {
                id: newDiscId,
                version: 1,
                parent_id: pageId,
                parent_table: "block",
                resolved: false,
                space_id: spaceId,
              },
            },
            {
              pointer: { table: "comment", id: commentId, spaceId },
              path: [],
              command: "set",
              args: {
                id: commentId,
                version: 1,
                parent_id: newDiscId,
                parent_table: "discussion",
                text: [[text]],
                space_id: spaceId,
                alive: true,
                created_by_id: userId,
                created_by_table: "notion_user",
                created_time: Date.now(),
                last_edited_time: Date.now(),
              },
            },
            {
              pointer: { table: "discussion", id: newDiscId, spaceId },
              path: ["comments"],
              command: "listAfter",
              args: { id: commentId },
            },
            {
              pointer: { table: "block", id: pageId, spaceId },
              path: ["discussions"],
              command: "listAfter",
              args: { id: newDiscId },
            },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
    return { discussionId: newDiscId, commentId };
  } else {
    // Reply to existing discussion
    const res = await fetch(`${API_BASE}/saveTransactions`, {
      method: "POST",
      headers: headers(spaceId),
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        transactions: [{
          id: crypto.randomUUID(),
          spaceId,
          operations: [
            {
              pointer: { table: "comment", id: commentId, spaceId },
              path: [],
              command: "set",
              args: {
                id: commentId,
                version: 1,
                parent_id: discussionId,
                parent_table: "discussion",
                text: [[text]],
                space_id: spaceId,
                alive: true,
                created_by_id: userId,
                created_by_table: "notion_user",
                created_time: Date.now(),
                last_edited_time: Date.now(),
              },
            },
            {
              pointer: { table: "discussion", id: discussionId, spaceId },
              path: ["comments"],
              command: "listAfter",
              args: { id: commentId },
            },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
    return { discussionId, commentId };
  }
}

// Upload a local file to Notion's S3 via getUploadFileUrl. Returns the URL to use as image source.
async function uploadFile(filePath, parentBlockId, spaceId) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stats = statSync(filePath);
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase().slice(1);
  const mimeMap = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";

  const initRes = await fetch(`${API_BASE}/getUploadFileUrl`, {
    method: "POST",
    headers: headers(spaceId),
    body: JSON.stringify({
      bucket: "secure",
      name,
      contentType,
      contentLength: stats.size,
      record: { table: "block", id: parentBlockId, spaceId },
      supportExtraHeaders: true,
    }),
  });
  if (!initRes.ok) throw new Error(`getUploadFileUrl failed: ${initRes.status} ${await initRes.text()}`);
  const { url, signedPutUrl, signedGetUrl, fields } = await initRes.json();

  const fileBuf = readFileSync(filePath);
  const putRes = await fetch(signedPutUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, ...(fields || {}) },
    body: fileBuf,
  });
  if (!putRes.ok) throw new Error(`S3 PUT failed: ${putRes.status} ${await putRes.text()}`);

  return { url, signedGetUrl: signedGetUrl || url };
}

// --- MCP Server ---

const server = new McpServer({
  name: "notion-proxy",
  version: "1.0.0",
});

server.tool(
  "read-page",
  "Read the content of a Notion page. Returns markdown-like text.",
  { page: z.string().describe("Notion page URL or ID") },
  async ({ page }) => {
    try {
      const pageId = parsePageId(page);
      const blocks = await loadPage(pageId);
      const text = extractText(blocks, pageId);
      return { content: [{ type: "text", text: text || "(empty page)" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "read-comments",
  "Read all discussions/comments on a Notion page.",
  { page: z.string().describe("Notion page URL or ID") },
  async ({ page }) => {
    try {
      const pageId = parsePageId(page);
      const data = await loadAllPageChunks(pageId);
      const text = formatDiscussions(data.recordMap);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "add-comment",
  "Add a comment to a Notion page. Creates a new discussion or replies to an existing one.",
  {
    page: z.string().describe("Notion page URL or ID"),
    text: z.string().describe("Comment text"),
    discussion_id: z
      .string()
      .optional()
      .describe("Discussion ID to reply to. Omit to create a new discussion."),
  },
  async ({ page, text, discussion_id }) => {
    try {
      const pageId = parsePageId(page);
      const result = await addComment(pageId, text, discussion_id);
      return {
        content: [{ type: "text", text: `Comment added successfully.\n${JSON.stringify(result, null, 2)}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "edit-block",
  "Edit a text block on a Notion page. Updates the block's text content.",
  {
    block_id: z.string().describe("Block ID (UUID) to edit"),
    text: z.string().describe("New text content for the block"),
  },
  async ({ block_id, text }) => {
    try {
      const blockId = parsePageId(block_id);
      const spaceId = await getSpaceId(blockId);
      if (!spaceId) throw new Error("Could not determine spaceId for block");
      const res = await fetch(`${API_BASE}/saveTransactions`, {
        method: "POST",
        headers: headers(spaceId),
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          transactions: [
            {
              id: crypto.randomUUID(),
              spaceId,
              operations: [
                {
                  pointer: { table: "block", id: blockId, spaceId },
                  path: ["properties", "title"],
                  command: "set",
                  args: [[text]],
                },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
      return { content: [{ type: "text", text: "Block updated successfully." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "add-block",
  "Add a new text block to a Notion page. Appends to the bottom by default, or inserts after a specific block.",
  {
    page: z.string().describe("Notion page URL or ID"),
    text: z.string().describe("Text content for the new block"),
    type: z.enum(["text", "header", "sub_header", "sub_sub_header", "bulleted_list", "numbered_list", "to_do", "quote", "code"])
      .default("text")
      .describe("Block type (default: text)"),
    after: z.string().optional().describe("Block ID to insert after. Omit to append at the bottom."),
  },
  async ({ page, text, type, after }) => {
    try {
      const pageId = parsePageId(page);
      const spaceId = await getSpaceId(pageId);
      if (!spaceId) throw new Error("Could not determine spaceId for page");
      const newBlockId = crypto.randomUUID();
      const listAfterArgs = { id: newBlockId };
      if (after) listAfterArgs.after = parsePageId(after);
      const res = await fetch(`${API_BASE}/saveTransactions`, {
        method: "POST",
        headers: headers(spaceId),
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          transactions: [{
            id: crypto.randomUUID(),
            spaceId,
            operations: [
              {
                pointer: { table: "block", id: newBlockId, spaceId },
                path: [],
                command: "set",
                args: {
                  type,
                  id: newBlockId,
                  version: 1,
                  parent_id: pageId,
                  parent_table: "block",
                  alive: true,
                  properties: { title: [[text]] },
                  space_id: spaceId,
                },
              },
              {
                pointer: { table: "block", id: pageId, spaceId },
                path: ["content"],
                command: "listAfter",
                args: listAfterArgs,
              },
            ],
          }],
        }),
      });
      if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
      return { content: [{ type: "text", text: `Block added successfully. Block ID: ${newBlockId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "delete-block",
  "Delete a block from a Notion page.",
  {
    block_id: z.string().describe("Block ID (UUID) to delete"),
  },
  async ({ block_id }) => {
    try {
      const blockId = parsePageId(block_id);
      const sync = await syncBlocks([blockId]);
      const blockVal = sync.recordMap?.block?.[blockId]?.value?.value;
      if (!blockVal) throw new Error("Block not found");
      const parentId = blockVal.parent_id;
      const spaceId = blockVal.space_id;
      if (!spaceId || !parentId) throw new Error("Could not determine parent/space for block");
      const res = await fetch(`${API_BASE}/saveTransactions`, {
        method: "POST",
        headers: headers(spaceId),
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          transactions: [{
            id: crypto.randomUUID(),
            spaceId,
            operations: [
              {
                pointer: { table: "block", id: blockId, spaceId },
                path: [],
                command: "update",
                args: { alive: false },
              },
              {
                pointer: { table: "block", id: parentId, spaceId },
                path: ["content"],
                command: "listRemove",
                args: { id: blockId },
              },
            ],
          }],
        }),
      });
      if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
      return { content: [{ type: "text", text: "Block deleted successfully." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "add-image",
  "Add an image block to a Notion page. Source can be an external URL (http/https) or a local file path (uploaded to Notion's storage).",
  {
    page: z.string().describe("Notion page URL or ID"),
    source: z.string().describe("Image URL (http/https) or absolute local file path"),
    after: z.string().optional().describe("Block ID to insert after. Omit to append at the bottom."),
  },
  async ({ page, source, after }) => {
    try {
      const pageId = parsePageId(page);
      const spaceId = await getSpaceId(pageId);
      if (!spaceId) throw new Error("Could not determine spaceId for page");
      const newBlockId = crypto.randomUUID();

      let displaySource;
      if (/^https?:\/\//i.test(source)) {
        displaySource = source;
      } else {
        const { url } = await uploadFile(source, newBlockId, spaceId);
        displaySource = url;
      }

      const listAfterArgs = { id: newBlockId };
      if (after) listAfterArgs.after = parsePageId(after);

      const res = await fetch(`${API_BASE}/saveTransactions`, {
        method: "POST",
        headers: headers(spaceId),
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          transactions: [{
            id: crypto.randomUUID(),
            spaceId,
            operations: [
              {
                pointer: { table: "block", id: newBlockId, spaceId },
                path: [],
                command: "set",
                args: {
                  type: "image",
                  id: newBlockId,
                  version: 1,
                  parent_id: pageId,
                  parent_table: "block",
                  alive: true,
                  properties: { source: [[displaySource]] },
                  format: { display_source: displaySource },
                  space_id: spaceId,
                },
              },
              {
                pointer: { table: "block", id: pageId, spaceId },
                path: ["content"],
                command: "listAfter",
                args: listAfterArgs,
              },
            ],
          }],
        }),
      });
      if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
      return { content: [{ type: "text", text: `Image added successfully. Block ID: ${newBlockId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "create-page",
  "Create a new child page under a Notion page.",
  {
    parent: z.string().describe("Parent Notion page URL or ID"),
    title: z.string().describe("Title of the new page"),
    after: z.string().optional().describe("Block ID to insert after. Omit to append at the bottom."),
  },
  async ({ parent, title, after }) => {
    try {
      const parentId = parsePageId(parent);
      const spaceId = await getSpaceId(parentId);
      if (!spaceId) throw new Error("Could not determine spaceId for parent page");
      const newPageId = crypto.randomUUID();
      const listAfterArgs = { id: newPageId };
      if (after) listAfterArgs.after = parsePageId(after);

      const res = await fetch(`${API_BASE}/saveTransactions`, {
        method: "POST",
        headers: headers(spaceId),
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          transactions: [{
            id: crypto.randomUUID(),
            spaceId,
            operations: [
              {
                pointer: { table: "block", id: newPageId, spaceId },
                path: [],
                command: "set",
                args: {
                  type: "page",
                  id: newPageId,
                  version: 1,
                  parent_id: parentId,
                  parent_table: "block",
                  alive: true,
                  properties: { title: [[title]] },
                  space_id: spaceId,
                },
              },
              {
                pointer: { table: "block", id: parentId, spaceId },
                path: ["content"],
                command: "listAfter",
                args: listAfterArgs,
              },
            ],
          }],
        }),
      });
      if (!res.ok) throw new Error(`saveTransactions failed: ${res.status} ${await res.text()}`);
      return { content: [{ type: "text", text: `Page created successfully. Page ID: ${newPageId}\nURL: ${NOTION_BASE}/${newPageId.replace(/-/g, "")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
