import * as notion from "./notion.ts";

/**
 * The single definition of every Notion command. The CLI parser, help text, and MCP tool list
 * are all generated from this table, so a description written here is shown everywhere.
 */

/** A positional argument. `name` is also the MCP property name. */
export interface Arg {
  name: string;
  /** How the argument appears in CLI usage, without brackets. Defaults to `name`. */
  label?: string;
  description: string;
}

/** A string-valued option. `name` (snake_case) is the MCP property; the CLI flag is its kebab-case form. */
export interface Option {
  name: string;
  short?: string;
  /** Placeholder shown in CLI usage, e.g. "<text>". */
  value: string;
  description: string;
  required?: boolean;
  choices?: readonly string[];
  default?: string;
  /** On the CLI, the value "-" means "read standard input". */
  stdin?: boolean;
}

/** Validated input, keyed by argument and option names. Required names are always present. */
export type Input = Record<string, string>;

export interface Result {
  /** Human-readable output, printed by default and returned to MCP clients. */
  text: string;
  /** Printed with --json. */
  json: unknown;
}

export interface Command {
  /** CLI command name and MCP tool name. */
  name: string;
  /** One line, shown in the command list. */
  summary: string;
  /** Shown in `help <command>` and as the MCP tool description. */
  description: string;
  args: Arg[];
  options: Option[];
  /** What a successful run prints. */
  output: string;
  /** The shape printed with --json. */
  json: string;
  examples: string[];
  run(input: Input): Promise<Result>;
}

const PAGE: Arg = { name: "page", description: "Notion page URL or ID" };
const BLOCK: Arg = { name: "block_id", label: "block", description: "Block ID, as shown by read-page in [block:<id>]" };
const TEXT_OPTION = (description: string): Option => ({
  name: "text",
  short: "t",
  value: "<text>",
  description,
  required: true,
  stdin: true,
});
const AFTER: Option = {
  name: "after",
  value: "<block>",
  description: "Insert after this block instead of at the end of the page",
};

export const COMMANDS: Command[] = [
  {
    name: "read-page",
    summary: "Print a page as Markdown, with block IDs",
    description:
      "Print a page's content as Markdown. Each block is tagged with [block:<id>]; pass that ID to edit-block, " +
      "delete-block, or --after. Tables are shown as <table columns: ...>; edit-block takes one of those column " +
      "IDs as --property to change a cell.",
    args: [PAGE],
    options: [],
    output: "The page as Markdown.",
    json: '{ "page_id": "...", "markdown": "..." }',
    examples: ["notion-proxy read-page https://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef"],
    async run(input) {
      const result = await notion.readPage(input.page!);
      return { text: result.markdown, json: result };
    },
  },
  {
    name: "read-comments",
    summary: "Print a page's discussions and comments",
    description:
      "Print every discussion on a page with its comments, authors, and timestamps. " +
      "Reply to a discussion with add-comment --discussion-id.",
    args: [PAGE],
    options: [],
    output: "One section per discussion, or 'No discussions found.'",
    json:
      '{ "page_id": "...", "discussions": [{ "id", "parent_block_id", "context", "resolved",\n' +
      '  "comments": [{ "id", "author", "created_time", "text" }] }] }',
    examples: ["notion-proxy read-comments <page>"],
    async run(input) {
      const result = await notion.readComments(input.page!);
      return { text: notion.formatDiscussions(result.discussions), json: result };
    },
  },
  {
    name: "add-comment",
    summary: "Start a discussion on a page, or reply to one",
    description: "Start a new page-level discussion, or reply to an existing discussion with --discussion-id.",
    args: [PAGE],
    options: [
      TEXT_OPTION("Comment text"),
      {
        name: "discussion_id",
        value: "<id>",
        description: "Reply to this discussion (IDs are shown by read-comments)",
      },
    ],
    output: "The discussion ID.",
    json: '{ "discussion_id": "...", "comment_id": "..." }',
    examples: [
      'notion-proxy add-comment <page> --text "Looks good to me"',
      'notion-proxy add-comment <page> --discussion-id <id> --text "Fixed"',
    ],
    async run(input) {
      const result = await notion.addComment(input.page!, input.text!, input.discussion_id);
      return { text: result.discussion_id, json: result };
    },
  },
  {
    name: "add-block",
    summary: "Add a block to a page",
    description: "Add a block to a page. The block is appended to the end of the page unless --after is given.",
    args: [PAGE],
    options: [
      TEXT_OPTION("Block text"),
      {
        name: "type",
        value: "<type>",
        description: "Block type",
        choices: notion.BLOCK_TYPES,
        default: "text",
      },
      {
        name: "language",
        value: "<lang>",
        description: "Language of a code block, e.g. python or mermaid (default: Plain Text)",
      },
      AFTER,
    ],
    output: "The new block ID.",
    json: '{ "block_id": "..." }',
    examples: [
      'notion-proxy add-block <page> --text "Ship it" --type to_do',
      "cat flow.mmd | notion-proxy add-block <page> --type code --language mermaid --text -",
    ],
    async run(input) {
      const result = await notion.addBlock({
        page: input.page!,
        text: input.text!,
        type: input.type as notion.BlockType,
        language: input.language,
        after: input.after,
      });
      return { text: result.block_id, json: result };
    },
  },
  {
    name: "edit-block",
    summary: "Replace a block's text",
    description:
      "Replace the text of a block. For a table cell, pass the table row's block ID and the column ID as --property.",
    args: [BLOCK],
    options: [
      TEXT_OPTION("New text; replaces the block's whole text"),
      {
        name: "property",
        value: "<key>",
        description: "Property to set (default: title). For a table cell, a column ID from read-page",
      },
    ],
    output: "'updated <block id>'.",
    json: '{ "block_id": "..." }',
    examples: [
      'notion-proxy edit-block <block> --text "New wording"',
      'notion-proxy edit-block <row block> --property <column id> --text "42"',
    ],
    async run(input) {
      const result = await notion.editBlock({ block: input.block_id!, text: input.text!, property: input.property });
      return { text: `updated ${result.block_id}`, json: result };
    },
  },
  {
    name: "delete-block",
    summary: "Delete a block",
    description: "Delete a block, and everything nested under it, from its page.",
    args: [BLOCK],
    options: [],
    output: "'deleted <block id>'.",
    json: '{ "block_id": "..." }',
    examples: ["notion-proxy delete-block <block>"],
    async run(input) {
      const result = await notion.deleteBlock(input.block_id!);
      return { text: `deleted ${result.block_id}`, json: result };
    },
  },
  {
    name: "add-image",
    summary: "Add an image from a URL or a local file",
    description:
      "Add an image block to a page. An http(s) URL is embedded as is; a local file is uploaded to Notion first. " +
      "The image is appended to the end of the page unless --after is given.",
    args: [PAGE, { name: "source", description: "Image URL (http/https) or local file path" }],
    options: [AFTER],
    output: "The new block ID.",
    json: '{ "block_id": "...", "source": "<image URL>" }',
    examples: [
      "notion-proxy add-image <page> ./diagram.png",
      "notion-proxy add-image <page> https://example.com/chart.png --after <block>",
    ],
    async run(input) {
      const result = await notion.addImage({ page: input.page!, source: input.source!, after: input.after });
      return { text: result.block_id, json: result };
    },
  },
  {
    name: "create-page",
    summary: "Create a child page",
    description: "Create an empty page inside another page. It is added at the end of the parent unless --after is given.",
    args: [{ name: "parent", description: "Parent page URL or ID" }],
    options: [{ name: "title", value: "<title>", description: "Title of the new page", required: true }, AFTER],
    output: "The new page ID and its URL, on separate lines.",
    json: '{ "page_id": "...", "url": "..." }',
    examples: ['notion-proxy create-page <page> --title "Meeting notes"'],
    async run(input) {
      const result = await notion.createPage({ parent: input.parent!, title: input.title!, after: input.after });
      return { text: `${result.page_id}\n${result.url}`, json: result };
    },
  },
];
