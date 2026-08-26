/**
 * A deliberately small markdown renderer — just enough for the documentation
 * authored in `content.ts`, with no dependencies beyond React itself (this
 * package ships react and react-dom only, matching the App Hub's discipline).
 *
 * Supported blocks: `##`/`###` headings (with stable slug ids for deep links),
 * paragraphs, fenced code blocks, pipe tables (with `\|` escapes inside
 * cells), unordered and ordered lists, and `>` blockquotes.
 * Supported inline marks: `code`, **bold**, *emphasis*, and [links](…).
 *
 * Everything renders to React elements — no HTML strings, nothing injected.
 */

import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith('[')) {
      const close = token.indexOf(']');
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      const external = /^https?:/i.test(href);
      nodes.push(
        <a
          key={key}
          href={href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        >
          {renderInline(label, key)}
        </a>,
      );
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    cursor = start + token.length;
    index += 1;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

type Block =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string };

/** Splits a table line on unescaped pipes, then unescapes `\|`. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\' && line[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  /* Leading and trailing pipes produce empty edge cells — drop them. */
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    /* Fenced code — indented fences are honoured too. */
    if (line.trimStart().startsWith('```')) {
      const indent = line.length - line.trimStart().length;
      const language = line.trimStart().slice(3).trim();
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        buffer.push(lines[index].slice(indent));
        index += 1;
      }
      index += 1; /* closing fence */
      blocks.push({ kind: 'code', language, code: buffer.join('\n') });
      continue;
    }

    /* Headings. `##` and `###` only — sections own the `#` level. */
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length === 2 ? 2 : 3,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    /* Tables: a `|` line followed by a separator line. */
    if (line.trimStart().startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trimStart().startsWith('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    /* Lists. An item continues over indented follow-on lines. */
    const listMatch = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (itemMatch) {
          items.push(itemMatch[3]);
          index += 1;
          /* Continuation lines: indented, not themselves list items. */
          while (
            index < lines.length &&
            /^\s{2,}\S/.test(lines[index]) &&
            !/^(\s*)([-*]|\d+\.)\s+/.test(lines[index]) &&
            !lines[index].trimStart().startsWith('```')
          ) {
            items[items.length - 1] += ` ${lines[index].trim()}`;
            index += 1;
          }
          /* A fenced block indented under a list item: fold it in verbatim
             as a code block after the list — simplest honest rendering. */
          if (index < lines.length && lines[index].trimStart().startsWith('```')) {
            break;
          }
        } else if (lines[index].trim() === '') {
          /* A blank line ends the list unless another item follows. */
          const next = lines[index + 1];
          if (next !== undefined && /^(\s*)([-*]|\d+\.)\s+/.test(next)) {
            index += 1;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    /* Blockquote. */
    if (line.trimStart().startsWith('>')) {
      const buffer: string[] = [];
      while (index < lines.length && lines[index].trimStart().startsWith('>')) {
        buffer.push(lines[index].trimStart().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: buffer.join(' ') });
      continue;
    }

    /* Paragraph: consecutive plain lines. */
    const buffer: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !lines[index].trimStart().startsWith('```') &&
      !/^(#{2,3})\s+/.test(lines[index]) &&
      !lines[index].trimStart().startsWith('|') &&
      !lines[index].trimStart().startsWith('>') &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[index])
    ) {
      buffer.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: buffer.join(' ') });
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/* Heading slugs and outline                                           */
/* ------------------------------------------------------------------ */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export interface OutlineEntry {
  slug: string;
  text: string;
}

/** The `##` headings of a markdown body, for the section sub-navigation. */
export function outlineOf(markdown: string): OutlineEntry[] {
  return parseBlocks(markdown)
    .filter(
      (block): block is Extract<Block, { kind: 'heading' }> =>
        block.kind === 'heading' && block.level === 2,
    )
    .map((block) => ({ slug: slugify(block.text), text: block.text }));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface MarkdownProps {
  markdown: string;
  /** Prefixed onto heading ids so two sections can share heading names. */
  idPrefix: string;
}

export function Markdown({ markdown, idPrefix }: MarkdownProps) {
  const blocks = parseBlocks(markdown);
  return (
    <>
      {blocks.map((block, blockIndex) => {
        const key = `${idPrefix}-b${blockIndex}`;
        switch (block.kind) {
          case 'heading': {
            const id = `${idPrefix}--${slugify(block.text)}`;
            return block.level === 2 ? (
              <h2 key={key} id={id}>
                {renderInline(block.text, key)}
              </h2>
            ) : (
              <h3 key={key} id={id}>
                {renderInline(block.text, key)}
              </h3>
            );
          }
          case 'paragraph':
            return <p key={key}>{renderInline(block.text, key)}</p>;
          case 'code':
            return (
              <div key={key} className="docs-codeblock">
                <pre>
                  <code data-language={block.language || undefined}>{block.code}</code>
                </pre>
              </div>
            );
          case 'table':
            return (
              <div key={key} className="docs-tablewrap">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={`${key}-h${cellIndex}`}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r${rowIndex}c${cellIndex}`}>
                            {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list':
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-i${itemIndex}`}>{renderInline(item, `${key}-i${itemIndex}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-i${itemIndex}`}>{renderInline(item, `${key}-i${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case 'quote':
            return (
              <blockquote key={key}>
                <p>{renderInline(block.text, key)}</p>
              </blockquote>
            );
        }
      })}
    </>
  );
}
