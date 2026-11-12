import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** One top-level piece of a markdown document (a heading, a paragraph, a list, a table…), by where its source sits. */
export interface Block {
  start: number;
  end: number;
}

/** Where each top-level block of a markdown text starts and ends, in order. */
export function splitBlocks(text: string): Block[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const blocks: Block[] = [];
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    blocks.push({ start, end });
  }
  return blocks;
}

/**
 * The text with one block's source replaced. Everything outside the block stays byte for byte as
 * it was. An empty replacement removes the block and the blank lines that set it apart.
 */
export function replaceBlock(text: string, block: Block, next: string): string {
  const body = next.replace(/\s+$/, "");
  if (body) return text.slice(0, block.start) + body + text.slice(block.end);
  const before = text.slice(0, block.start).replace(/\n+$/, "");
  const after = text.slice(block.end).replace(/^\n+/, "");
  return before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
}

/** The text with a new block added at the end. */
export function appendBlock(text: string, next: string): string {
  const body = next.trim();
  if (!body) return text;
  const head = text.replace(/\s+$/, "");
  return head ? `${head}\n\n${body}\n` : `${body}\n`;
}
