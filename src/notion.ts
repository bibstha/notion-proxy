import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CliError } from "./errors.ts";

const NOTION_BASE = "https://www.notion.so";
const API_BASE = `${NOTION_BASE}/api/v3`;
const PACKAGE_ROOT = resolve(import.meta.dir, "..");

// --- Cookies -------------------------------------------------------------

function firefoxProfilesDir(): string | null {
  if (process.platform === "win32") {
    return process.env.APPDATA ? join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles") : null;
  }
  const home = process.env.HOME;
  if (!home) return null;
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Firefox", "Profiles");
  return join(home, ".mozilla", "firefox");
}

function findFirefoxProfile(base: string): string | null {
  if (!existsSync(base)) return null;
  const profiles = readdirSync(base);
  // Prefer default-release, then default, then any
  const pref = profiles.find((p) => p.endsWith(".default-release"))
    ?? profiles.find((p) => p.endsWith(".default"))
    ?? profiles[0];
  return pref ? join(base, pref) : null;
}

/** Reads Notion cookies from a copy of Firefox's cookies.sqlite, since Firefox keeps the original locked. */
function loadCookiesFromFirefox(cookiesDb: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "notion-proxy-"));
  const tmp = join(dir, "cookies.sqlite");
  try {
    copyFileSync(cookiesDb, tmp);
    // Recent writes may still live in the WAL file
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(cookiesDb + suffix)) copyFileSync(cookiesDb + suffix, tmp + suffix);
    }
    const db = new Database(tmp, { readonly: true });
    try {
      const rows = db
        .query<{ name: string; value: string }, []>("SELECT name, value FROM moz_cookies WHERE host LIKE '%notion.so'")
        .all();
      return rows.length ? rows.map((r) => `${r.name}=${r.value}`).join("; ") : null;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cookieFromEnvFile(path: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^NOTION_COOKIE=(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

let cookieCache: { value: string; at: number } | null = null;
/** The MCP server is long-lived; re-read Firefox at most this often so session renewals are picked up. */
const COOKIE_TTL_MS = 60_000;

/** Sources, in order: NOTION_COOKIE env var, Firefox cookie store, NOTION_COOKIE in ./.env or the package's .env. */
function loadCookie(): string {
  const now = Date.now();
  if (cookieCache && now - cookieCache.at < COOKIE_TTL_MS) return cookieCache.value;

  const checked: string[] = [];
  const found = (value: string) => {
    cookieCache = { value, at: now };
    return value;
  };

  const fromEnv = process.env.NOTION_COOKIE?.trim();
  if (fromEnv) return found(fromEnv);
  checked.push("NOTION_COOKIE environment variable (not set)");

  const profilesDir = firefoxProfilesDir();
  const profile = profilesDir ? findFirefoxProfile(profilesDir) : null;
  if (profile) {
    const db = join(profile, "cookies.sqlite");
    try {
      const cookie = existsSync(db) ? loadCookiesFromFirefox(db) : null;
      if (cookie?.includes("token_v2=")) return found(cookie);
      checked.push(`${db} (${existsSync(db) ? "no notion.so token_v2 cookie" : "missing"})`);
    } catch (e) {
      checked.push(`${db} (unreadable: ${e instanceof Error ? e.message : e})`);
    }
  } else {
    checked.push(`Firefox profiles in ${profilesDir ?? "(unknown location)"} (none found)`);
  }

  for (const dir of new Set([process.cwd(), PACKAGE_ROOT])) {
    const envPath = join(dir, ".env");
    const cookie = cookieFromEnvFile(envPath);
    if (cookie) return found(cookie);
    checked.push(`${envPath} (${existsSync(envPath) ? "no NOTION_COOKIE line" : "missing"})`);
  }

  throw new CliError(
    "auth",
    `no Notion session found. Checked:\n${checked.map((c) => `  - ${c}`).join("\n")}`,
    "Log in to notion.so in Firefox, or set NOTION_COOKIE to the Cookie header of a logged-in notion.so request (browser devtools > Network).",
  );
}

function userIdFromCookie(cookie: string): string | null {
  return cookie.match(/notion_user_id=([^;]+)/)?.[1]?.trim() ?? null;
}

// --- HTTP ----------------------------------------------------------------

function headers(spaceId?: string): Record<string, string> {
  const cookie = loadCookie();
  const userId = userIdFromCookie(cookie);
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
    "Notion-Audit-Log-Platform": "web",
  };
  if (userId) h["x-notion-active-user-header"] = userId;
  if (spaceId) h["x-notion-space-id"] = spaceId;
  return h;
}

async function errorFromResponse(what: string, res: Response): Promise<CliError> {
  const body = await res.text();
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) detail = parsed.message;
  } catch {}
  detail = detail.length > 300 ? `${detail.slice(0, 300)}...` : detail;
  const message = `${what} failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`;
  if (res.status === 401) {
    return new CliError("auth", message, "The Notion session has expired. Log in to notion.so in Firefox again, or refresh NOTION_COOKIE.");
  }
  if (res.status === 403) {
    return new CliError("auth", message, "Your Notion account cannot do this on this page. Check that you can do it in the browser.");
  }
  return new CliError("notion", message);
}

async function request(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new CliError("network", `${what} failed: ${e instanceof Error ? e.message : e}`, "Check your network connection.");
  }
  if (!res.ok) throw await errorFromResponse(what, res);
  return res;
}

async function api<T>(endpoint: string, body: unknown, spaceId?: string): Promise<T> {
  const res = await request(
    `${API_BASE}/${endpoint}`,
    { method: "POST", headers: headers(spaceId), body: JSON.stringify(body) },
    endpoint,
  );
  return (await res.json()) as T;
}

interface Operation {
  pointer: { table: string; id: string; spaceId: string };
  path: string[];
  command: "set" | "update" | "listAfter" | "listRemove";
  args: unknown;
}

async function saveTransactions(spaceId: string, operations: Operation[]): Promise<void> {
  await api(
    "saveTransactions",
    { requestId: crypto.randomUUID(), transactions: [{ id: crypto.randomUUID(), spaceId, operations }] },
    spaceId,
  );
}

// --- Records -------------------------------------------------------------

type RichText = [string, ...unknown[]][];

interface Block {
  id: string;
  type: string;
  parent_id?: string;
  space_id?: string;
  content?: string[];
  properties?: Record<string, RichText>;
  format?: { table_block_column_order?: string[] };
}

/** Notion wraps records as { value: { value: record } } in newer responses and { value: record } in older ones. */
interface RecordEntry<T> {
  spaceId?: string;
  value?: { value?: T } & Partial<T>;
}

type RecordMap = Partial<Record<"block" | "discussion" | "comment" | "notion_user", Record<string, RecordEntry<any>>>>;

function unwrap<T>(entry: RecordEntry<T> | undefined): T | undefined {
  return (entry?.value?.value ?? entry?.value) as T | undefined;
}

function plainText(rich: RichText | undefined): string {
  return rich ? rich.map((seg) => seg[0]).join("") : "";
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accepts a Notion URL, a 32-character hex ID, a UUID, or "block:<uuid>" as printed by read-page. */
export function parseId(input: string, what = "page"): string {
  const trimmed = input.trim();
  const uuid = trimmed.match(UUID_RE)?.[0];
  const hex = uuid?.replace(/-/g, "") ?? trimmed.replace(/[?#].*$/, "").match(/([0-9a-f]{32})$/i)?.[1];
  if (!hex) {
    throw new CliError(
      "usage",
      `invalid ${what} ID: ${input}`,
      `Pass a Notion URL (https://www.notion.so/Title-<32 hex chars>), a 32-character hex ID, or a UUID.`,
    );
  }
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function syncBlocks(ids: string[]): Promise<RecordMap> {
  const data = await api<{ recordMap?: RecordMap }>("syncRecordValues", {
    requests: ids.map((id) => ({ pointer: { table: "block", id }, version: -1 })),
  });
  return data.recordMap ?? {};
}

function notAccessible(id: string): CliError {
  return new CliError(
    "notion",
    `block ${id} was not found or is not accessible`,
    "Check the ID, and that your Notion account can open the page in the browser.",
  );
}

async function getBlock(id: string): Promise<Block & { space_id: string }> {
  const recordMap = await syncBlocks([id]);
  const entry = recordMap.block?.[id];
  const block = unwrap<Block>(entry);
  const spaceId = entry?.spaceId ?? block?.space_id;
  if (!block || !spaceId) throw notAccessible(id);
  return { ...block, space_id: spaceId };
}

async function getSpaceId(id: string): Promise<string> {
  return (await getBlock(id)).space_id;
}

async function loadPageBlocks(pageId: string): Promise<Record<string, Block>> {
  const blocks: Record<string, Block> = {};
  let pending = [pageId];
  while (pending.length) {
    const recordMap = await syncBlocks(pending);
    const next: string[] = [];
    for (const [id, entry] of Object.entries(recordMap.block ?? {})) {
      const block = unwrap<Block>(entry);
      if (!block) continue;
      blocks[id] = block;
      for (const childId of block.content ?? []) {
        if (!blocks[childId]) next.push(childId);
      }
    }
    pending = next;
  }
  return blocks;
}

// --- Rendering -----------------------------------------------------------

/** Notion expects canonical language names on code blocks (e.g. "JavaScript", "Plain Text"). */
const LANGUAGE_NAMES: Record<string, string> = {
  "plain text": "Plain Text", plaintext: "Plain Text", text: "Plain Text",
  javascript: "JavaScript", js: "JavaScript", typescript: "TypeScript", ts: "TypeScript",
  html: "HTML", css: "CSS", json: "JSON", yaml: "YAML", sql: "SQL", xml: "XML",
  graphql: "GraphQL", php: "PHP", cpp: "C++", "c++": "C++", csharp: "C#", "c#": "C#",
  "objective-c": "Objective-C", shell: "Shell", bash: "Shell", sh: "Shell", zsh: "Shell",
};

function normalizeLanguage(lang: string | undefined): string {
  if (!lang) return "Plain Text";
  const key = lang.trim().toLowerCase();
  return LANGUAGE_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

const LIST_TYPES: Record<string, true> = { bulleted_list: true, numbered_list: true, to_do: true };

/** Renders a block and its children as Markdown in document order, tagging each line with [block:<id>]. */
function renderBlock(block: Block, blocks: Record<string, Block>, depth = 0): string[] {
  const lines: string[] = [];
  const text = plainText(block.properties?.title);
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
    case "code": {
      const lang = block.properties?.language?.[0]?.[0];
      lines.push(`\`\`\`${lang ? lang.toLowerCase().replace(/ /g, "") : ""}${bid}\n${text}\n\`\`\``);
      break;
    }
    case "quote":
    case "callout":
      lines.push(`> ${text}${bid}`);
      break;
    case "divider":
      lines.push(`---${bid}`);
      break;
    case "table": {
      const cols = block.format?.table_block_column_order ?? [];
      lines.push(`${indent}<table columns: ${cols.join(", ")}>${bid}`);
      break;
    }
    case "table_row": {
      const parent = block.parent_id ? blocks[block.parent_id] : undefined;
      const cols = parent?.format?.table_block_column_order ?? Object.keys(block.properties ?? {});
      const cells = cols.map((c) => plainText(block.properties?.[c]));
      lines.push(`${indent}| ${cells.join(" | ")} |${bid}`);
      break;
    }
    case "column_list":
    case "column":
      break; // just recurse into children
    default:
      if (text) lines.push(`${indent}${text}${bid}`);
      break;
  }

  const childDepth = LIST_TYPES[block.type] ? depth + 1 : depth;
  for (const childId of block.content ?? []) {
    const child = blocks[childId];
    if (child) lines.push(...renderBlock(child, blocks, childDepth));
  }
  return lines;
}

// --- Commands ------------------------------------------------------------

export async function readPage(page: string): Promise<{ page_id: string; markdown: string }> {
  const pageId = parseId(page);
  const blocks = await loadPageBlocks(pageId);
  const root = blocks[pageId];
  if (!root) throw notAccessible(pageId);
  return { page_id: pageId, markdown: renderBlock(root, blocks).join("\n") };
}

export interface Comment {
  id: string;
  author: string;
  created_time: string;
  text: string;
}

export interface Discussion {
  id: string;
  parent_block_id: string;
  context: string;
  resolved: boolean;
  comments: Comment[];
}

async function loadAllPageChunks(pageId: string): Promise<RecordMap> {
  const merged: Required<RecordMap> = { block: {}, discussion: {}, comment: {}, notion_user: {} };
  let cursor: { stack: unknown[] } = { stack: [] };
  // Safety limit: 20 chunks of 100 blocks
  for (let chunk = 0; chunk <= 20; chunk++) {
    const data = await api<{ recordMap?: RecordMap; cursor?: { stack?: unknown[] } }>("loadPageChunk", {
      pageId,
      limit: 100,
      cursor,
      chunkNumber: chunk,
      verticalColumns: false,
    });
    for (const table of ["block", "discussion", "comment", "notion_user"] as const) {
      Object.assign(merged[table], data.recordMap?.[table] ?? {});
    }
    if (!data.cursor?.stack?.length) break;
    cursor = { stack: data.cursor.stack };
  }
  return merged;
}

export async function readComments(page: string): Promise<{ page_id: string; discussions: Discussion[] }> {
  const pageId = parseId(page);
  const recordMap = await loadAllPageChunks(pageId);

  const discussions: Discussion[] = [];
  for (const entry of Object.values(recordMap.discussion ?? {})) {
    const disc = unwrap<{ id: string; parent_id: string; context?: RichText; resolved?: boolean; comments?: string[] }>(entry);
    if (!disc) continue;
    const comments: Comment[] = [];
    for (const commentId of disc.comments ?? []) {
      const c = unwrap<{ id: string; created_by_id?: string; created_time: number; text?: RichText }>(
        recordMap.comment?.[commentId],
      );
      if (!c) continue;
      const author = c.created_by_id
        ? unwrap<{ name?: string }>(recordMap.notion_user?.[c.created_by_id])?.name ?? c.created_by_id
        : "Unknown";
      comments.push({
        id: c.id,
        author,
        created_time: new Date(c.created_time).toISOString(),
        text: plainText(c.text),
      });
    }
    discussions.push({
      id: disc.id,
      parent_block_id: disc.parent_id,
      context: plainText(disc.context),
      resolved: Boolean(disc.resolved),
      comments,
    });
  }
  return { page_id: pageId, discussions };
}

export function formatDiscussions(discussions: Discussion[]): string {
  if (!discussions.length) return "No discussions found.";
  return discussions
    .map((d) => {
      const lines = [`--- Discussion ${d.id}${d.resolved ? " (resolved)" : ""} ---`, `Parent block: ${d.parent_block_id}`];
      if (d.context) lines.push(`Context: "${d.context}"`);
      for (const c of d.comments) lines.push(`  [${c.created_time}] ${c.author}: ${c.text}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function addComment(
  page: string,
  text: string,
  discussionId?: string,
): Promise<{ discussion_id: string; comment_id: string }> {
  const pageId = parseId(page);
  const spaceId = await getSpaceId(pageId);
  const userId = userIdFromCookie(loadCookie());
  const commentId = crypto.randomUUID();
  const discId = discussionId ? parseId(discussionId, "discussion") : crypto.randomUUID();
  const now = Date.now();

  const operations: Operation[] = [];
  if (!discussionId) {
    // New page-level discussion
    operations.push(
      {
        pointer: { table: "discussion", id: discId, spaceId },
        path: [],
        command: "set",
        args: { id: discId, version: 1, parent_id: pageId, parent_table: "block", resolved: false, space_id: spaceId },
      },
      {
        pointer: { table: "block", id: pageId, spaceId },
        path: ["discussions"],
        command: "listAfter",
        args: { id: discId },
      },
    );
  }
  operations.push(
    {
      pointer: { table: "comment", id: commentId, spaceId },
      path: [],
      command: "set",
      args: {
        id: commentId,
        version: 1,
        parent_id: discId,
        parent_table: "discussion",
        text: [[text]],
        space_id: spaceId,
        alive: true,
        created_by_id: userId,
        created_by_table: "notion_user",
        created_time: now,
        last_edited_time: now,
      },
    },
    {
      pointer: { table: "discussion", id: discId, spaceId },
      path: ["comments"],
      command: "listAfter",
      args: { id: commentId },
    },
  );
  await saveTransactions(spaceId, operations);
  return { discussion_id: discId, comment_id: commentId };
}

export const BLOCK_TYPES = [
  "text", "header", "sub_header", "sub_sub_header", "bulleted_list", "numbered_list", "to_do", "quote", "code",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Creates a block under parentId and links it into the parent's content, after `after` or at the end. */
async function insertBlock(
  parentId: string,
  spaceId: string,
  record: { type: string; properties: Record<string, unknown>; format?: Record<string, unknown> },
  after?: string,
  id: string = crypto.randomUUID(),
): Promise<string> {
  await saveTransactions(spaceId, [
    {
      pointer: { table: "block", id, spaceId },
      path: [],
      command: "set",
      args: { ...record, id, version: 1, parent_id: parentId, parent_table: "block", alive: true, space_id: spaceId },
    },
    {
      pointer: { table: "block", id: parentId, spaceId },
      path: ["content"],
      command: "listAfter",
      args: after ? { id, after: parseId(after, "block") } : { id },
    },
  ]);
  return id;
}

export async function addBlock(opts: {
  page: string;
  text: string;
  type: BlockType;
  language?: string;
  after?: string;
}): Promise<{ block_id: string }> {
  const pageId = parseId(opts.page);
  const spaceId = await getSpaceId(pageId);
  const properties: Record<string, unknown> = { title: [[opts.text]] };
  let format: Record<string, unknown> | undefined;
  if (opts.type === "code") {
    const lang = normalizeLanguage(opts.language);
    properties.language = [[lang]];
    // Mermaid blocks default to split view; show the rendered diagram instead
    if (lang === "Mermaid") format = { code_preview_format: "preview" };
  }
  const blockId = await insertBlock(pageId, spaceId, { type: opts.type, properties, format }, opts.after);
  return { block_id: blockId };
}

export async function editBlock(opts: { block: string; text: string; property?: string }): Promise<{ block_id: string }> {
  const blockId = parseId(opts.block, "block");
  const spaceId = await getSpaceId(blockId);
  await saveTransactions(spaceId, [
    {
      pointer: { table: "block", id: blockId, spaceId },
      path: ["properties", opts.property ?? "title"],
      command: "set",
      args: [[opts.text]],
    },
  ]);
  return { block_id: blockId };
}

export async function deleteBlock(block: string): Promise<{ block_id: string }> {
  const blockId = parseId(block, "block");
  const { parent_id: parentId, space_id: spaceId } = await getBlock(blockId);
  if (!parentId) throw notAccessible(blockId);
  await saveTransactions(spaceId, [
    { pointer: { table: "block", id: blockId, spaceId }, path: [], command: "update", args: { alive: false } },
    { pointer: { table: "block", id: parentId, spaceId }, path: ["content"], command: "listRemove", args: { id: blockId } },
  ]);
  return { block_id: blockId };
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
};

/** Uploads a local file to Notion's storage and returns the URL to use as the image source. */
async function uploadFile(filePath: string, blockId: string, spaceId: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new CliError("usage", `file not found: ${filePath}`, "Pass an http(s) URL or the path of an existing image file.");
  }
  const contentType = IMAGE_MIME[extname(filePath).toLowerCase().slice(1)] ?? "application/octet-stream";
  const { url, signedPutUrl, fields } = await api<{ url: string; signedPutUrl: string; fields?: Record<string, string> }>(
    "getUploadFileUrl",
    {
      bucket: "secure",
      name: basename(filePath),
      contentType,
      contentLength: file.size,
      record: { table: "block", id: blockId, spaceId },
      supportExtraHeaders: true,
    },
    spaceId,
  );
  await request(signedPutUrl, { method: "PUT", headers: { "Content-Type": contentType, ...fields }, body: file }, "file upload");
  return url;
}

export async function addImage(opts: { page: string; source: string; after?: string }): Promise<{ block_id: string; source: string }> {
  const pageId = parseId(opts.page);
  const spaceId = await getSpaceId(pageId);
  // The upload is attached to the block before the block exists, so the ID is chosen up front
  const id = crypto.randomUUID();
  const source = /^https?:\/\//i.test(opts.source) ? opts.source : await uploadFile(resolve(opts.source), id, spaceId);
  await insertBlock(
    pageId,
    spaceId,
    { type: "image", properties: { source: [[source]] }, format: { display_source: source } },
    opts.after,
    id,
  );
  return { block_id: id, source };
}

export async function createPage(opts: { parent: string; title: string; after?: string }): Promise<{ page_id: string; url: string }> {
  const parentId = parseId(opts.parent);
  const spaceId = await getSpaceId(parentId);
  const pageId = await insertBlock(parentId, spaceId, { type: "page", properties: { title: [[opts.title]] } }, opts.after);
  return { page_id: pageId, url: `${NOTION_BASE}/${pageId.replace(/-/g, "")}` };
}
