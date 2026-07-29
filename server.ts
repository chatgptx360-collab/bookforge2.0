/**
 * BookForge server — Express application with every API route and all
 * document conversion logic.
 *
 * The same module powers three environments:
 *   • `tsx server.ts`      — development, Vite runs in middleware mode
 *   • `node dist/server.cjs` — production, serves the built client from /dist
 *   • Vercel                — `api/index.mjs` imports the exported `app`
 */
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

import AdmZip from 'adm-zip';
import { GoogleGenAI, Type } from '@google/genai';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import mammoth from 'mammoth';
import multer from 'multer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const app = express();
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ---------------------------------------------------------------------------
// Generative AI plumbing
// ---------------------------------------------------------------------------

const GEMINI_MODELS = (process.env.GEMINI_MODELS ?? 'gemini-2.5-flash,gemini-flash-latest,gemini-2.5-flash-lite,gemini-2.0-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'imagen-4.0-generate-001';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';

let activeModelIndex = 0;

const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

class AiUnavailableError extends Error {
  constructor() {
    super('No AI provider configured. Set GEMINI_API_KEY (or OPENROUTER_API_KEY) in the environment.');
    this.name = 'AiUnavailableError';
  }
}

/** Minimal OpenRouter fallback so text endpoints still work without a Gemini key. */
async function generateWithOpenRouter(params: { contents: string; config?: { responseMimeType?: string } }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new AiUnavailableError();

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'BookForge',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: params.contents }],
      ...(params.config?.responseMimeType === 'application/json'
        ? { response_format: { type: 'json_object' } }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed (HTTP ${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return { text: payload.choices?.[0]?.message?.content ?? '' };
}

/**
 * Calls Gemini with model rotation and exponential backoff. Quota errors rotate
 * to the next model in the list; transient errors back off and retry.
 */
export async function generateContentWithRetry(
  params: Record<string, unknown>,
  retries = 6,
  baseDelay = 2000,
): Promise<{ text?: string }> {
  if (!geminiClient) return generateWithOpenRouter(params as { contents: string });

  // With both providers configured, OpenRouter becomes the safety net for when
  // Gemini is exhausted or down. Multimodal calls pass `contents` as an array
  // and have no OpenRouter equivalent here, so they are excluded.
  const canFallBack = typeof params.contents === 'string' && Boolean(process.env.OPENROUTER_API_KEY);
  const fallBack = async (reason: string) => {
    console.warn(`[Gemini] ${reason}; falling back to OpenRouter (${OPENROUTER_MODEL})`);
    return generateWithOpenRouter(params as { contents: string; config?: { responseMimeType?: string } });
  };

  let rotations = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    const currentModel = (params.model as string) ?? GEMINI_MODELS[activeModelIndex % GEMINI_MODELS.length];
    try {
      return await geminiClient.models.generateContent({ ...params, model: currentModel } as never);
    } catch (error) {
      lastError = error;
      const errorMsg =
        (error as { message?: string })?.message ?? (typeof error === 'object' ? JSON.stringify(error) : String(error));
      console.warn(`[Gemini] attempt ${attempt + 1}/${retries} on ${currentModel}: ${errorMsg.slice(0, 240)}`);

      const isRateLimited = /429|RESOURCE_EXHAUSTED|quota/i.test(errorMsg);
      const isTransient = /50[023]|Service Unavailable|Overloaded|ECONNRESET|fetch failed/i.test(errorMsg);

      if (isRateLimited && rotations < GEMINI_MODELS.length) {
        rotations++;
        activeModelIndex++;
        delete params.model;
        console.log(`[Gemini] rotating to ${GEMINI_MODELS[activeModelIndex % GEMINI_MODELS.length]}`);
        await sleep(1200);
        continue;
      }

      if ((isRateLimited || isTransient) && attempt < retries - 1) {
        const retryAfter = errorMsg.match(/retry in\s+([0-9.]+)\s*s/i) ?? errorMsg.match(/"retryDelay"\s*:\s*"(\d+)s?"/i);
        const waitMs = retryAfter
          ? Number.parseFloat(retryAfter[1]) * 1000 + 1000
          : baseDelay * Math.pow(1.8, attempt) + Math.random() * 800;
        await sleep(Math.min(waitMs, 30_000));
        continue;
      }
      if (canFallBack) return fallBack(`request failed (${errorMsg.slice(0, 120)})`);
      throw error;
    }
  }
  if (canFallBack) return fallBack('all model rotations exhausted');
  throw lastError instanceof Error ? lastError : new Error('Gemini request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// JSON self-healing
// ---------------------------------------------------------------------------

/** Closes unbalanced braces/brackets/strings left behind by a truncated response. */
function repairTruncatedJson(jsonStr: string): unknown {
  const startIdx = jsonStr.indexOf('{');
  if (startIdx === -1) throw new Error('No JSON object found in response');

  const balance = (input: string): string => {
    const stack: string[] = [];
    let insideString = false;
    let escaped = false;
    let out = '';
    for (const char of input) {
      if (escaped) {
        out += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        out += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        insideString = !insideString;
        out += char;
        continue;
      }
      if (insideString) {
        out += char;
        continue;
      }
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' && stack.at(-1) === '}') stack.pop();
      else if (char === ']' && stack.at(-1) === ']') stack.pop();
      out += char;
    }
    if (insideString) out += '"';
    while (stack.length > 0) out += stack.pop();
    return out;
  };

  const body = jsonStr.slice(startIdx);
  try {
    return JSON.parse(balance(body));
  } catch {
    // Walk backwards, dropping the trailing partial token until it parses.
    for (let end = body.length - 1; end > 1; end--) {
      try {
        return JSON.parse(balance(body.slice(0, end)));
      } catch {
        /* keep shrinking */
      }
    }
    throw new Error('Unable to repair truncated JSON');
  }
}

/** Last resort: pull the prose out of a mangled chapter response. */
function salvageCorruptedResponse(text: string): Record<string, unknown> {
  const match = text.match(/"chapterText"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
  let chapterText = match?.[1]
    ? match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
    : text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  chapterText = chapterText.trim();

  return {
    chapterText,
    actualWordCount: chapterText.split(/\s+/).filter(Boolean).length,
    statusIntermission: {
      progressSummary: 'Chapter recovered from a partial model response.',
      narrativeSummary: 'Draft text was salvaged; review it before publishing.',
      nextUpTeaser: 'Continue with the next chapter in the outline.',
    },
  };
}

export function robustJsonParse(text: string): Record<string, unknown> {
  if (!text) return {};
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    /* fall through */
  }

  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx !== -1 && endIdx > startIdx) {
    try {
      return JSON.parse(cleaned.slice(startIdx, endIdx + 1)) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }

  try {
    return repairTruncatedJson(cleaned) as Record<string, unknown>;
  } catch (error) {
    console.error('[JSON repair] failed:', (error as Error).message);
  }

  return salvageCorruptedResponse(text);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ldquo: '\u201C',
  rdquo: '\u201D',
  lsquo: '\u2018',
  rsquo: '\u2019',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  apos: "'",
  eacute: '\u00E9',
  egrave: '\u00E8',
  uuml: '\u00FC',
  ouml: '\u00F6',
  auml: '\u00E4',
  szlig: '\u00DF',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  deg: '\u00B0',
  laquo: '\u00AB',
  raquo: '\u00BB',
  bull: '\u2022',
};

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    // XML 1.0 forbids most control characters outright.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// ---------------------------------------------------------------------------
// Rich block model — the intermediate every converter reads and writes, so
// emphasis and heading levels survive a conversion instead of being flattened.
// ---------------------------------------------------------------------------

export interface RichRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type RichBlockType = 'heading' | 'paragraph' | 'quote' | 'listItem' | 'scene';

export interface RichBlock {
  type: RichBlockType;
  /** 1-6 for headings. */
  level?: number;
  runs: RichRun[];
}

const BLOCK_MARK = '\u0010';
const BOLD_ON = '\u0011';
const BOLD_OFF = '\u0012';
const ITALIC_ON = '\u0013';
const ITALIC_OFF = '\u0014';

export function blockText(block: RichBlock): string {
  return block.runs.map((run) => run.text).join('');
}

function makeBlock(type: RichBlockType, runs: RichRun[], level?: number): RichBlock {
  return level === undefined ? { type, runs } : { type, level, runs };
}

/** Parses inline bold/italic markers into styled runs. */
function markersToRuns(input: string): RichRun[] {
  const runs: RichRun[] = [];
  let bold = 0;
  let italic = 0;
  let buffer = '';

  const push = () => {
    if (!buffer) return;
    const run: RichRun = { text: buffer };
    if (bold > 0) run.bold = true;
    if (italic > 0) run.italic = true;
    runs.push(run);
    buffer = '';
  };

  for (const char of input) {
    switch (char) {
      case BOLD_ON:
        push();
        bold++;
        break;
      case BOLD_OFF:
        push();
        bold = Math.max(0, bold - 1);
        break;
      case ITALIC_ON:
        push();
        italic++;
        break;
      case ITALIC_OFF:
        push();
        italic = Math.max(0, italic - 1);
        break;
      default:
        buffer += char;
    }
  }
  push();

  // Merge neighbours that ended up with identical styling.
  return runs.reduce<RichRun[]>((acc, run) => {
    const last = acc.at(-1);
    if (last && Boolean(last.bold) === Boolean(run.bold) && Boolean(last.italic) === Boolean(run.italic)) {
      last.text += run.text;
      return acc;
    }
    acc.push(run);
    return acc;
  }, []);
}

/** Converts an (X)HTML fragment into styled blocks. */
export function htmlToBlocks(html: string): RichBlock[] {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let text = bodyMatch ? bodyMatch[1] : html;

  text = text
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(strong|b)\b[^>]*>/gi, BOLD_ON)
    .replace(/<\/(strong|b)>/gi, BOLD_OFF)
    .replace(/<(em|i|cite)\b[^>]*>/gi, ITALIC_ON)
    .replace(/<\/(em|i|cite)>/gi, ITALIC_OFF)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*\/?>/gi, `${BLOCK_MARK}scene${BLOCK_MARK}${BLOCK_MARK}/${BLOCK_MARK}`)
    .replace(/<(h[1-6]|p|li|blockquote)\b[^>]*>/gi, (_, tag: string) => `${BLOCK_MARK}${tag.toLowerCase()}${BLOCK_MARK}`)
    .replace(/<\/(h[1-6]|p|li|blockquote)>/gi, `${BLOCK_MARK}/${BLOCK_MARK}`)
    .replace(/<[^>]+>/g, '');

  const blocks: RichBlock[] = [];
  const tokens = text.split(BLOCK_MARK);
  let pending: RichBlockType | null = null;
  let level: number | undefined;

  const flush = (content: string) => {
    const cleaned = decodeHtmlEntities(content).replace(/[ \t ]+/g, ' ').trim();
    if (!pending) {
      // Loose text outside any block element still counts as a paragraph.
      if (cleaned) blocks.push(makeBlock('paragraph', markersToRuns(cleaned)));
      return;
    }
    if (pending === 'scene') {
      blocks.push(makeBlock('scene', []));
    } else if (cleaned) {
      blocks.push(makeBlock(pending, markersToRuns(cleaned), level));
    }
    pending = null;
    level = undefined;
  };

  for (const token of tokens) {
    const tag = token.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      pending = 'heading';
      level = Number(tag[1]);
    } else if (tag === 'p') {
      pending = 'paragraph';
    } else if (tag === 'li') {
      pending = 'listItem';
    } else if (tag === 'blockquote') {
      pending = 'quote';
    } else if (tag === 'scene') {
      pending = 'scene';
    } else if (tag === '/') {
      if (pending === 'scene') flush('');
    } else {
      flush(token);
    }
  }

  return blocks.filter((block) => block.type === 'scene' || blockText(block).trim());
}

const TEXT_SCENE_BREAK = /^(\*\s*\*\s*\*|\*{3,}|-{3,}|—{3,}|❦)$/;

/** Builds blocks from plain text, recognising headings and scene breaks. */
export function textToBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (TEXT_SCENE_BREAK.test(line)) {
      blocks.push(makeBlock('scene', []));
      continue;
    }
    const heading = headingInfo(line);
    if (heading) {
      blocks.push(makeBlock('heading', [{ text: heading.title }], 1));
      continue;
    }
    blocks.push(makeBlock('paragraph', [{ text: line }]));
  }
  return blocks;
}

export function blocksToPlainText(blocks: RichBlock[]): string {
  return blocks
    .map((block) => (block.type === 'scene' ? '***' : block.type === 'listItem' ? `• ${blockText(block)}` : blockText(block)))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Converts an (X)HTML fragment into readable plain text with paragraph breaks. */
function htmlToPlainText(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let text = bodyMatch ? bodyMatch[1] : html;

  text = text
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|section|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** RTF → plain text. Handles \'hh hex escapes, \uN unicode and common groups. */
export function parseRtfToText(rtf: string): string {
  let text = rtf;

  // Drop metadata groups entirely (including their contents).
  text = text
    .replace(/\{\\fonttbl[\s\S]*?\}\}/g, '')
    .replace(/\{\\fonttbl[\s\S]*?\}/g, '')
    .replace(/\{\\colortbl[\s\S]*?\}/g, '')
    .replace(/\{\\stylesheet[\s\S]*?\}\}/g, '')
    .replace(/\{\\\*\\expandedcolortbl[\s\S]*?\}/g, '')
    .replace(/\{\\\*\\generator[\s\S]*?\}/g, '')
    .replace(/\{\\info[\s\S]*?\}\}/g, '')
    .replace(/\{\\info[\s\S]*?\}/g, '')
    .replace(/\{\\\*\\[a-z]+[\s\S]*?\}/g, '');

  // \uN<fallback> unicode escapes.
  text = text.replace(/\\u(-?\d+)\s?\??/g, (_, code: string) => {
    const value = Number.parseInt(code, 10);
    return safeCodePoint(value < 0 ? value + 65536 : value);
  });

  // \'hh single-byte escapes (cp1252-ish; Latin-1 is a close enough mapping).
  text = text.replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

  // Control words: paragraph-ish ones become newlines, the rest disappear.
  text = text.replace(/\\([a-z]{1,32})(-?\d+)? ?/gi, (_, word: string) => {
    const control = word.toLowerCase();
    if (control === 'par' || control === 'line' || control === 'row' || control === 'sect') return '\n';
    if (control === 'tab') return '\t';
    return '';
  });

  return text
    .replace(/\\([{}\\])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Document text extraction
// ---------------------------------------------------------------------------

export type SourceFormat = 'docx' | 'pdf' | 'epub' | 'txt' | 'rtf';

function formatFromName(fileName: string): SourceFormat | null {
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  return ext === 'docx' || ext === 'pdf' || ext === 'epub' || ext === 'txt' || ext === 'rtf' ? ext : null;
}

const MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_COMPRESSION_RATIO = 250;

/**
 * Guards against zip bombs before anything is decompressed: a hostile 20 kB
 * EPUB can otherwise expand to gigabytes and take the function down.
 */
function assertSafeZip(zip: AdmZip): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Archive rejected: ${entries.length} entries exceeds the ${MAX_ZIP_ENTRIES} limit.`);
  }
  let uncompressed = 0;
  let compressed = 0;
  for (const entry of entries) {
    uncompressed += entry.header.size;
    compressed += entry.header.compressedSize;
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Archive rejected: uncompressed contents exceed the size limit.');
    }
  }
  if (compressed > 4096 && uncompressed / Math.max(1, compressed) > MAX_COMPRESSION_RATIO) {
    throw new Error('Archive rejected: suspicious compression ratio.');
  }
}

/**
 * Identifies a file by its leading bytes. Extensions are attacker-controlled,
 * so the sniffed type is what the converters actually act on.
 */
export function sniffFormat(buffer: Buffer): SourceFormat | 'zip' | null {
  if (buffer.length < 4) return 'txt';
  const head = buffer.subarray(0, 5).toString('latin1');

  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    // Both DOCX and EPUB are ZIP containers — look inside to tell them apart.
    try {
      const zip = new AdmZip(buffer);
      assertSafeZip(zip);
      const names = zip.getEntries().map((entry) => entry.entryName);
      if (names.some((name) => name === 'mimetype' || name.toLowerCase().endsWith('.opf'))) return 'epub';
      if (names.some((name) => name.startsWith('word/') || name === '[Content_Types].xml')) return 'docx';
    } catch {
      return 'zip';
    }
    return 'zip';
  }
  // Anything that decodes as text is treated as plain text.
  return buffer.includes(0) ? null : 'txt';
}

/** Reconciles the declared extension with the real bytes. */
function resolveSourceFormat(buffer: Buffer, fileName: string): SourceFormat {
  const declared = formatFromName(fileName);
  const sniffed = sniffFormat(buffer);

  if (!declared) throw new Error(`Unsupported file type: ${path.extname(fileName) || fileName}`);
  if (sniffed === null || sniffed === 'zip') {
    throw new Error(`This file is not a readable ${declared.toUpperCase()} document.`);
  }
  if (sniffed !== declared) {
    // Trust the bytes, but only when the real type is one we can convert.
    console.warn(`[upload] ${fileName} declared ${declared} but looks like ${sniffed}; using ${sniffed}.`);
  }
  return sniffed;
}

const PAGE_MARKER = /^\s*-{2,}\s*\d+\s*of\s*\d+\s*-{2,}\s*$/i;
const SENTENCE_END = /[.!?…"'”’»)\]]$|[:;,—–-]$/;

/**
 * PDF text arrives broken at the printed line, with page furniture mixed in.
 * This rebuilds paragraphs: drop page markers and repeated running heads,
 * de-hyphenate across line breaks, and join lines that continue a sentence.
 */
export function reflowPdfText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  // Split on the page markers pdf-parse injects so running heads can be spotted.
  const pages: string[][] = [[]];
  for (const line of lines) {
    if (PAGE_MARKER.test(line)) pages.push([]);
    else pages.at(-1)?.push(line);
  }

  // A line repeated at the top or bottom of most pages is a header/footer.
  const edgeCounts = new Map<string, number>();
  for (const page of pages) {
    const meaningful = page.filter((line) => line.trim());
    for (const candidate of [meaningful[0], meaningful.at(-1)]) {
      const key = candidate?.trim().replace(/\d+/g, '#');
      if (key && key.length > 2 && key.length < 90) edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  const running = new Set([...edgeCounts.entries()].filter(([, n]) => n >= threshold).map(([key]) => key));

  const cleaned: string[] = [];
  for (const page of pages) {
    const filled = page.map((line, index) => ({ line, index })).filter((entry) => entry.line.trim());
    const edgeIndices = new Set(
      [filled[0], filled[1], filled.at(-2), filled.at(-1)].filter(Boolean).map((entry) => entry!.index),
    );
    page.forEach((line, index) => {
      if (edgeIndices.has(index)) {
        const normalized = line.trim().replace(/\d+/g, '#');
        if (running.has(normalized)) return;
        // A bare page number on its own line is furniture too.
        if (/^\s*\d{1,4}\s*$/.test(line)) return;
      }
      cleaned.push(line);
    });
    cleaned.push('');
  }

  // Rejoin wrapped lines into paragraphs.
  const out: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) out.push(buffer.trim());
    buffer = '';
  };

  for (const rawLine of cleaned) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (headingInfo(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (!buffer) {
      buffer = line;
      continue;
    }
    if (/[-‐‑‒­]$/.test(buffer) && /^[a-z]/.test(line)) {
      // Word split across a line break: "consider-\nation" → "consideration".
      buffer = `${buffer.replace(/[-‐‑‒­]$/, '')}${line}`;
    } else if (SENTENCE_END.test(buffer) && !/^[a-z,;]/.test(line)) {
      flush();
      buffer = line;
    } else {
      buffer = `${buffer} ${line}`;
    }
  }
  flush();

  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return reflowPdfText(result.text ?? '');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Reads an EPUB in spine order and returns its prose as plain text. */
/** Returns each EPUB content document, in spine order, as raw XHTML. */
function epubDocuments(buffer: Buffer): string[] {
  const zip = new AdmZip(buffer);
  assertSafeZip(zip);
  const readEntry = (entryPath: string): string | null => {
    const normalized = entryPath.replace(/^\/+/, '');
    const entry = zip.getEntry(normalized) ?? zip.getEntry(decodeURIComponent(normalized));
    return entry ? entry.getData().toString('utf8') : null;
  };

  const container = readEntry('META-INF/container.xml');
  const opfPath =
    container?.match(/full-path="([^"]+)"/i)?.[1] ??
    zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.opf'))?.entryName;

  if (!opfPath) throw new Error('Invalid EPUB: no OPF package document found.');

  const opf = readEntry(opfPath);
  if (!opf) throw new Error('Invalid EPUB: the OPF package document could not be read.');

  const opfDir = path.posix.dirname(opfPath);
  const resolve = (href: string) =>
    (opfDir === '.' ? href : path.posix.join(opfDir, href)).replace(/^\/+/, '');

  const manifest = new Map<string, string>();
  for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = item.match(/\bid="([^"]+)"/i)?.[1];
    const href = item.match(/\bhref="([^"]+)"/i)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }

  const spineIds = [...(opf.match(/<itemref\b[^>]*>/gi) ?? [])]
    .filter((ref) => !/linear="no"/i.test(ref))
    .map((ref) => ref.match(/idref="([^"]+)"/i)?.[1])
    .filter((id): id is string => Boolean(id));

  const documents = spineIds.length > 0
    ? spineIds.map((id) => manifest.get(id)).filter((href): href is string => Boolean(href))
    : zip
        .getEntries()
        .filter((e) => /\.x?html?$/i.test(e.entryName))
        .map((e) => e.entryName);

  const parts: string[] = [];
  for (const href of documents) {
    const raw = readEntry(spineIds.length > 0 ? resolve(href) : href);
    if (raw) parts.push(raw);
  }
  return parts;
}

export function extractEpubText(buffer: Buffer): string {
  const parts = epubDocuments(buffer)
    .map((doc) => htmlToPlainText(doc))
    .filter(Boolean);
  if (parts.length === 0) throw new Error('This EPUB contains no readable text content.');
  return parts.join('\n\n');
}

/** Reads an EPUB in spine order and returns styled blocks. */
export function extractEpubBlocks(buffer: Buffer): RichBlock[] {
  return epubDocuments(buffer).flatMap((doc) => htmlToBlocks(doc));
}

/**
 * Extracts a document as styled blocks. DOCX and EPUB keep their emphasis and
 * heading levels; the plain-text formats are promoted to blocks by detecting
 * headings and scene breaks.
 */
export async function extractBlocksFromFile(buffer: Buffer, fileName: string): Promise<RichBlock[]> {
  const format = resolveSourceFormat(buffer, fileName);

  switch (format) {
    case 'docx': {
      const { value } = await mammoth.convertToHtml({ buffer });
      const blocks = htmlToBlocks(value);
      return blocks.length > 0 ? blocks : textToBlocks((await mammoth.extractRawText({ buffer })).value);
    }
    case 'epub': {
      const blocks = extractEpubBlocks(buffer);
      if (blocks.length === 0) throw new Error('This EPUB contains no readable text content.');
      return blocks;
    }
    case 'pdf':
      return textToBlocks(await extractPdfText(buffer));
    case 'rtf':
      return textToBlocks(parseRtfToText(buffer.toString('utf8')));
    case 'txt':
    default:
      return textToBlocks(buffer.toString('utf8'));
  }
}

export async function extractTextFromFile(buffer: Buffer, fileName: string): Promise<string> {
  return blocksToPlainText(await extractBlocksFromFile(buffer, fileName));
}

// ---------------------------------------------------------------------------
// Manuscript structure parsing
// ---------------------------------------------------------------------------

export type SectionType = 'title' | 'copyright' | 'toc' | 'chapter';

export interface ParsedSection {
  type: SectionType;
  title: string;
  content: string;
  chapterNumber?: number;
}

export interface ParsedDocument {
  title: string;
  author: string;
  sections: ParsedSection[];
}

const ROMAN = /^[ivxlcdm]+$/i;
const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
];

const NAMED_SECTIONS = /^(prologue|epilogue|introduction|foreword|preface|afterword|conclusion|epigraph)\b/i;
const NUMBERED_HEADING = /^(?:#{1,3}\s*)?(chapter|part|book|section)\s+([0-9]+|[ivxlcdm]+|[a-z-]+)\b\s*[:.\u2013\u2014-]?\s*(.*)$/i;
const MARKDOWN_HEADING = /^#{1,3}\s+(.{1,120})$/;
const TOC_ENTRY = /\.{3,}\s*\d*\s*$|\t+\d+\s*$/;
const COPYRIGHT_KEYWORDS = /copyright|all rights reserved|\bisbn\b|published by|library of congress|no part of this/i;

function romanToInt(value: string): number {
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const chars = value.toLowerCase().split('');
  let total = 0;
  for (let i = 0; i < chars.length; i++) {
    const current = map[chars[i]] ?? 0;
    const next = map[chars[i + 1]] ?? 0;
    total += current < next ? -current : current;
  }
  return total;
}

function headingInfo(line: string): { title: string; chapterNumber?: number } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return null;
  if (TOC_ENTRY.test(trimmed)) return null;

  const numbered = trimmed.match(NUMBERED_HEADING);
  if (numbered) {
    const [, keyword, rawNumber, rest] = numbered;
    let chapterNumber: number | undefined;
    if (/^\d+$/.test(rawNumber)) chapterNumber = Number.parseInt(rawNumber, 10);
    else if (ROMAN.test(rawNumber)) chapterNumber = romanToInt(rawNumber) || undefined;
    else {
      const wordIndex = NUMBER_WORDS.indexOf(rawNumber.toLowerCase());
      if (wordIndex >= 0) chapterNumber = wordIndex + 1;
    }
    if (chapterNumber === undefined) return null;
    const label = `${keyword.charAt(0).toUpperCase()}${keyword.slice(1).toLowerCase()} ${chapterNumber}`;
    return { title: rest.trim() ? `${label}: ${rest.trim()}` : label, chapterNumber };
  }

  if (NAMED_SECTIONS.test(trimmed.replace(/^#{1,3}\s*/, ''))) {
    return { title: trimmed.replace(/^#{1,3}\s*/, '').replace(/\s*[:.]\s*$/, '') };
  }

  const markdown = trimmed.match(MARKDOWN_HEADING);
  if (markdown) return { title: markdown[1].trim() };

  return null;
}

/**
 * Splits raw manuscript text into a title page, copyright page, table of
 * contents and chapter sections.
 */
export function parseDocumentStructure(text: string): ParsedDocument {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const headings: { index: number; title: string; chapterNumber?: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const info = headingInfo(lines[i]);
    if (info) headings.push({ index: i, ...info });
  }

  const firstHeadingIndex = headings.length > 0 ? headings[0].index : lines.length;
  const frontMatterLimit = Math.min(firstHeadingIndex, 250);

  // --- copyright page ---
  let copyrightStart = -1;
  let copyrightEnd = -1;
  for (let i = 0; i < frontMatterLimit; i++) {
    if (COPYRIGHT_KEYWORDS.test(lines[i])) {
      if (copyrightStart === -1) copyrightStart = i;
      copyrightEnd = i;
    }
  }
  if (copyrightStart >= 0) {
    // Absorb up to four trailing lines (imprint, edition, printing history) but
    // stop at a blank line or anything that starts a new block.
    for (let i = copyrightEnd + 1; i < Math.min(copyrightEnd + 5, frontMatterLimit); i++) {
      const line = lines[i].trim();
      if (!line || headingInfo(line) || TOC_ENTRY.test(line) || /^(table of )?contents$/i.test(line)) break;
      copyrightEnd = i;
    }
  }

  // --- table of contents ---
  let tocStart = -1;
  let tocEnd = -1;
  for (let i = 0; i < frontMatterLimit; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^(table of )?contents$/i.test(line)) {
      tocStart = i;
      break;
    }
    if (TOC_ENTRY.test(line)) {
      if (tocStart === -1) tocStart = i;
      tocEnd = i;
    }
  }
  if (tocStart >= 0) {
    let blankRun = 0;
    for (let i = tocStart + 1; i < frontMatterLimit; i++) {
      const line = lines[i].trim();
      if (!line) {
        blankRun++;
        if (blankRun >= 3 && tocEnd > tocStart) break;
        continue;
      }
      blankRun = 0;
      if (TOC_ENTRY.test(line) || headingInfo(line) || /^\s*\d+\s*$/.test(line)) tocEnd = i;
      else if (tocEnd > tocStart) break;
    }
    if (tocEnd <= tocStart) tocStart = -1;
  }

  // The two front-matter blocks must not overlap.
  if (tocStart >= 0 && copyrightStart >= 0 && tocStart <= copyrightEnd) {
    copyrightEnd = tocStart - 1;
    if (copyrightEnd < copyrightStart) copyrightStart = -1;
  }

  const sections: ParsedSection[] = [];

  // --- title page ---
  const titleBoundary = Math.min(
    ...[copyrightStart, tocStart, firstHeadingIndex].filter((value) => value >= 0),
    60,
  );
  const titleLines: string[] = [];
  for (let i = 0; i < titleBoundary && i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) titleLines.push(line);
  }

  let title = 'Untitled Manuscript';
  let author = '';
  if (titleLines.length > 0) {
    title = titleLines[0].replace(/^#+\s*/, '').slice(0, 120);
    const byLine = titleLines.find((line) => /^(by|written by|author)[:\s]/i.test(line));
    if (byLine) author = byLine.replace(/^(by|written by|author)[:\s]+/i, '').trim();
    sections.push({ type: 'title', title, content: titleLines.slice(0, 12).join('\n') });
  }

  if (copyrightStart >= 0) {
    const content = lines.slice(copyrightStart, copyrightEnd + 1).map((l) => l.trim()).filter(Boolean).join('\n');
    if (content) sections.push({ type: 'copyright', title: 'Copyright', content });
    if (!author) {
      const owner = content.match(/copyright\s*(?:©|\(c\))?\s*\d{0,4}\s*(?:by)?\s*([^\n.]+)/i)?.[1];
      if (owner) author = owner.trim();
    }
  }

  if (tocStart >= 0) {
    const content = lines.slice(tocStart, tocEnd + 1).map((l) => l.trim()).filter(Boolean).join('\n');
    if (content) sections.push({ type: 'toc', title: 'Table of Contents', content });
  }

  // --- chapters ---
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const endIndex = i + 1 < headings.length ? headings[i + 1].index : lines.length;
    const body = lines
      .slice(heading.index + 1, endIndex)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!body) continue;
    sections.push({
      type: 'chapter',
      title: heading.title,
      content: body,
      chapterNumber: heading.chapterNumber ?? undefined,
    });
  }

  // Nothing recognisable: treat the whole document as a single chapter.
  if (!sections.some((s) => s.type === 'chapter')) {
    const body = text.trim();
    if (body) sections.push({ type: 'chapter', title: title || 'Chapter 1', content: body, chapterNumber: 1 });
  }

  return { title, author, sections };
}

// ---------------------------------------------------------------------------
// ZIP writer (EPUB needs a stored, first-entry mimetype — hence no adm-zip here)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  /** `true` writes the entry uncompressed (required for the EPUB mimetype). */
  store?: boolean;
}

/** Builds a ZIP archive with deterministic timestamps. */
export function createZipArchive(entries: ZipEntry[]): Buffer {
  // 1980-01-01 00:00:00 in MS-DOS date/time form — deterministic output.
  const dosTime = 0;
  const dosDate = (1 << 5) | 1;

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const compressed = entry.store ? entry.data : zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

// ---------------------------------------------------------------------------
// Format converters
// ---------------------------------------------------------------------------

const EPUB_STYLESHEET = `@charset "UTF-8";
body { font-family: Georgia, "Times New Roman", serif; margin: 1em; line-height: 1.6; color: #1a1a1a; }
h1 { text-align: center; font-size: 1.6em; margin: 2em 0 1.5em; }
h2 { font-size: 1.25em; margin: 1.5em 0 0.8em; }
p { text-indent: 1.5em; margin: 0 0 0.8em 0; text-align: justify; }
p.first { text-indent: 0; }
hr.scene { border: 0; text-align: center; margin: 1.5em 0; }
.title-page { text-align: center; padding-top: 25%; }
.title-page h1 { font-size: 2.1em; margin-bottom: 0.5em; }
.title-page .author { font-size: 1em; color: #555; margin-top: 2em; }
nav ol { list-style: none; padding-left: 0; line-height: 2; }
`;

interface EpubChapter {
  title: string;
  blocks: RichBlock[];
}

/** Splits a block stream into chapters at top-level headings. */
function groupBlocksIntoChapters(blocks: RichBlock[], fallbackTitle: string): EpubChapter[] {
  const chapters: EpubChapter[] = [];
  let current: EpubChapter | null = null;

  // Split at the top heading level present: h1 when the document has them,
  // otherwise h2. Anything deeper stays inside the chapter as a sub-heading.
  const splitLevel = blocks.some((block) => block.type === 'heading' && (block.level ?? 1) === 1) ? 1 : 2;

  for (const block of blocks) {
    if (block.type === 'heading' && (block.level ?? 1) <= splitLevel) {
      current = { title: blockText(block) || fallbackTitle, blocks: [] };
      chapters.push(current);
      continue;
    }
    if (!current) {
      current = { title: fallbackTitle, blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(block);
  }

  const withContent = chapters.filter((chapter) => chapter.blocks.length > 0);
  return withContent.length > 0 ? withContent : [{ title: fallbackTitle, blocks }];
}

function runsToXhtml(runs: RichRun[]): string {
  return runs
    .map((run) => {
      let html = escapeXml(run.text);
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join('');
}

export interface EpubCover {
  data: Buffer;
  mimeType: string;
}

export interface EpubOptions {
  author?: string;
  language?: string;
  publisher?: string;
  description?: string;
  isbn?: string;
  series?: string;
  cover?: EpubCover;
}

const COVER_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Builds a valid EPUB 3.0 package: no NCX, a proper `nav.xhtml` carrying
 * `epub:type="toc"`, a stylesheet, and an uncompressed leading mimetype entry.
 * Inline emphasis and heading levels from the source survive into the output.
 */
export function blocksToEpub(
  blocks: RichBlock[],
  title = 'Converted Book',
  authorOrOptions: string | EpubOptions = 'BookForge',
): Buffer {
  const options: EpubOptions = typeof authorOrOptions === 'string' ? { author: authorOrOptions } : authorOrOptions;
  const author = options.author?.trim() || 'BookForge';
  const language = options.language?.trim() || 'en';

  const chapters = groupBlocksIntoChapters(blocks, title);
  const bookId = options.isbn?.trim() ? `urn:isbn:${options.isbn.trim()}` : `urn:uuid:${crypto.randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const manifest: string[] = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="stylesheet.css" media-type="text/css"/>',
    '    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>',
  ];
  const spine: string[] = [];
  const navItems: string[] = [];
  const documents: ZipEntry[] = [];
  const metadataExtras: string[] = [];

  // --- cover -----------------------------------------------------------
  if (options.cover) {
    const extension = COVER_EXTENSIONS[options.cover.mimeType] ?? 'jpg';
    const imageHref = `cover.${extension}`;
    documents.push({ name: `OEBPS/${imageHref}`, data: options.cover.data });
    manifest.push(
      `    <item id="cover-image" href="${imageHref}" media-type="${options.cover.mimeType}" properties="cover-image"/>`,
      '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    );
    metadataExtras.push('    <meta name="cover" content="cover-image"/>');
    spine.push('    <itemref idref="cover"/>');

    const coverPage = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>Cover</title>
    <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
  </head>
  <body>
    <section epub:type="cover" class="cover">
      <img src="${imageHref}" alt="Cover of ${escapeXml(title)}"/>
    </section>
  </body>
</html>`;
    documents.push({ name: 'OEBPS/cover.xhtml', data: Buffer.from(coverPage, 'utf8') });
  }

  spine.push('    <itemref idref="titlepage"/>');

  if (options.publisher?.trim()) {
    metadataExtras.push(`    <dc:publisher>${escapeXml(options.publisher.trim())}</dc:publisher>`);
  }
  if (options.description?.trim()) {
    metadataExtras.push(`    <dc:description>${escapeXml(options.description.trim())}</dc:description>`);
  }
  if (options.series?.trim()) {
    metadataExtras.push(
      `    <meta property="belongs-to-collection" id="series">${escapeXml(options.series.trim())}</meta>`,
      '    <meta refines="#series" property="collection-type">series</meta>',
    );
  }

  const titlePage = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
  </head>
  <body>
    <section class="title-page" epub:type="titlepage">
      <h1>${escapeXml(title)}</h1>
      <p class="author">${escapeXml(author)}</p>
    </section>
  </body>
</html>`;
  documents.push({ name: 'OEBPS/titlepage.xhtml', data: Buffer.from(titlePage, 'utf8') });

  chapters.forEach((chapter, index) => {
    const id = `ch${index + 1}`;
    const fileName = `chapter${index + 1}.xhtml`;

    const lines: string[] = [];
    let listOpen = false;
    let firstParagraph = true;

    for (const block of chapter.blocks) {
      if (block.type !== 'listItem' && listOpen) {
        lines.push('    </ul>');
        listOpen = false;
      }
      if (block.type === 'scene') {
        lines.push('    <hr class="scene"/>');
        firstParagraph = true;
      } else if (block.type === 'heading') {
        const level = Math.min(6, Math.max(2, block.level ?? 2));
        lines.push(`    <h${level}>${runsToXhtml(block.runs)}</h${level}>`);
        firstParagraph = true;
      } else if (block.type === 'quote') {
        lines.push(`    <blockquote><p>${runsToXhtml(block.runs)}</p></blockquote>`);
        firstParagraph = true;
      } else if (block.type === 'listItem') {
        if (!listOpen) {
          lines.push('    <ul>');
          listOpen = true;
        }
        lines.push(`      <li>${runsToXhtml(block.runs)}</li>`);
      } else {
        lines.push(`    <p${firstParagraph ? ' class="first"' : ''}>${runsToXhtml(block.runs)}</p>`);
        firstParagraph = false;
      }
    }
    if (listOpen) lines.push('    </ul>');

    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>${escapeXml(chapter.title)}</title>
    <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
  </head>
  <body>
    <h1>${escapeXml(chapter.title)}</h1>
${lines.join('\n')}
  </body>
</html>`;

    documents.push({ name: `OEBPS/${fileName}`, data: Buffer.from(xhtml, 'utf8') });
    manifest.push(`    <item id="${id}" href="${fileName}" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="${id}"/>`);
    navItems.push(`        <li><a href="${fileName}">${escapeXml(chapter.title)}</a></li>`);
  });

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>Table of Contents</title>
    <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
  </head>
  <body>
    <nav epub:type="toc" id="toc" role="doc-toc">
      <h1>Table of Contents</h1>
      <ol>
${navItems.join('\n')}
      </ol>
    </nav>
    <nav epub:type="landmarks" id="landmarks" hidden="hidden">
      <h2>Guide</h2>
      <ol>
${options.cover ? '        <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>\n' : ''}        <li><a epub:type="titlepage" href="titlepage.xhtml">Title Page</a></li>
        <li><a epub:type="bodymatter" href="chapter1.xhtml">Begin Reading</a></li>
      </ol>
    </nav>
  </body>
</html>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookID" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookID">${bookId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(language)}</dc:language>
    <dc:creator id="author">${escapeXml(author)}</dc:creator>
    <dc:date>${modified}</dc:date>
    <meta property="dcterms:modified">${modified}</meta>
    <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
${metadataExtras.join('\n')}${metadataExtras.length > 0 ? '\n' : ''}  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine>
${spine.join('\n')}
  </spine>
</package>`;

  return createZipArchive([
    // The mimetype entry must be first and stored uncompressed.
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), store: true },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
        'utf8',
      ),
    },
    { name: 'OEBPS/content.opf', data: Buffer.from(contentOpf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav, 'utf8') },
    { name: 'OEBPS/stylesheet.css', data: Buffer.from(EPUB_STYLESHEET, 'utf8') },
    ...documents,
  ]);
}

export function convertTextToEpub(text: string, title = 'Converted Book', author = 'BookForge'): Buffer {
  return blocksToEpub(textToBlocks(text), title, author);
}

export interface EpubValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Structural check mirroring the rules EPUBCheck fails most often. Not a
 * replacement for EPUBCheck, but it catches a broken package before a user
 * uploads it to a store.
 */
export function validateEpubStructure(buffer: Buffer): EpubValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // The mimetype entry must be first, stored, and exact.
    if (buffer.subarray(30, 38).toString('ascii') !== 'mimetype') {
      errors.push('The mimetype entry is missing or is not the first file in the archive.');
    } else {
      if (buffer.readUInt16LE(8) !== 0) errors.push('The mimetype entry must be stored uncompressed.');
      if (buffer.subarray(38, 58).toString('ascii') !== 'application/epub+zip') {
        errors.push('The mimetype entry does not contain "application/epub+zip".');
      }
    }

    const zip = new AdmZip(buffer);
    const names = new Set(zip.getEntries().map((entry) => entry.entryName));
    const read = (name: string) => zip.getEntry(name)?.getData().toString('utf8') ?? null;

    const container = read('META-INF/container.xml');
    if (!container) {
      errors.push('META-INF/container.xml is missing.');
      return { valid: false, errors, warnings };
    }

    const opfPath = container.match(/full-path="([^"]+)"/i)?.[1];
    if (!opfPath || !names.has(opfPath)) {
      errors.push('container.xml does not point at an existing package document.');
      return { valid: false, errors, warnings };
    }

    const opf = read(opfPath) ?? '';
    const opfDir = path.posix.dirname(opfPath);
    const resolveHref = (href: string) => (opfDir === '.' ? href : path.posix.join(opfDir, href));

    if (!/version="3\.\d+"/.test(opf)) errors.push('The package is not declared as EPUB 3.');
    if (!/<dc:title>/.test(opf)) errors.push('dc:title is missing from the metadata.');
    if (!/<dc:language>/.test(opf)) errors.push('dc:language is missing from the metadata.');
    if (!/<dc:identifier/.test(opf)) errors.push('dc:identifier is missing from the metadata.');
    if (!/dcterms:modified/.test(opf)) errors.push('The dcterms:modified timestamp is missing.');

    const uniqueId = opf.match(/unique-identifier="([^"]+)"/i)?.[1];
    if (uniqueId && !new RegExp(`<dc:identifier[^>]*id="${uniqueId}"`).test(opf)) {
      errors.push('unique-identifier does not resolve to a dc:identifier element.');
    }

    const manifestEntries = new Map<string, string>();
    let navHref: string | null = null;
    for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
      const id = item.match(/\bid="([^"]+)"/i)?.[1];
      const href = item.match(/\bhref="([^"]+)"/i)?.[1];
      if (!id || !href) continue;
      manifestEntries.set(id, href);
      if (/properties="[^"]*\bnav\b[^"]*"/i.test(item)) navHref = href;
      const resolved = resolveHref(decodeURIComponent(href));
      if (!names.has(resolved) && !/^https?:/i.test(href)) {
        errors.push(`The manifest lists "${href}" but the file is not in the archive.`);
      }
    }

    if (!navHref) errors.push('No navigation document is declared with properties="nav".');
    else {
      const nav = read(resolveHref(navHref));
      if (!nav) errors.push('The navigation document is missing from the archive.');
      else if (!/epub:type="toc"/.test(nav)) errors.push('The navigation document has no epub:type="toc" nav element.');
    }

    const spineIds = [...(opf.match(/<itemref\b[^>]*>/gi) ?? [])]
      .map((ref) => ref.match(/idref="([^"]+)"/i)?.[1])
      .filter((id): id is string => Boolean(id));
    if (spineIds.length === 0) errors.push('The spine is empty.');
    for (const id of spineIds) {
      if (!manifestEntries.has(id)) errors.push(`Spine item "${id}" is not present in the manifest.`);
    }

    if ([...names].some((name) => name.toLowerCase().endsWith('.ncx'))) {
      warnings.push('An NCX file is present; EPUB 3 readers do not need one.');
    }
    if (![...manifestEntries.values()].some((href) => /cover/i.test(href))) {
      warnings.push('No cover image is declared. Most stores expect one.');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'The archive could not be read.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

const WINANSI_SUBSTITUTIONS: Record<string, string> = {
  '\u2018': '\'',
  '\u2019': '\'',
  '\u201A': ',',
  '\u201B': '\'',
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u2013': '-',
  '\u2014': '--',
  '\u2015': '--',
  '\u2212': '-',
  '\u2026': '...',
  '\u2022': '*',
  '\u00A0': ' ',
  '\u202F': ' ',
  '\u2009': ' ',
  '\u2028': ' ',
  '\u2029': ' ',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\u2044': '/',
  '\u00AD': '-',
  '\u2766': '*',
  '\u2767': '*',
  '\u275B': '\'',
  '\u275C': '\'',
  '\u00B7': '.',
  '\u2039': '<',
  '\u203A': '>',
  '\u2032': '\'',
  '\u2033': '"',
};

/**
 * pdf-lib's standard fonts only speak WinAnsi, so map the common typographic
 * characters and drop anything else rather than throwing mid-document.
 *
 * The character classes use escapes deliberately: U+2028 is a JavaScript line
 * terminator, so a literal one inside a regex breaks the parse.
 */
function sanitizeForStandardFont(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u2013\u2014\u2015\u2212\u2026\u2022\u00A0\u202F\u2009\u2028\u2029\uFB01\uFB02\u2044\u00AD\u2766\u2767\u275B\u275C\u00B7\u2039\u203A\u2032\u2033]/g, (char) => WINANSI_SUBSTITUTIONS[char] ?? ' ')
    .replace(/[^\n\t\x20-\x7E\u00A0-\u00FF\u20AC\u201A\u0192\u2020\u2021\u02C6\u2030\u0160\u0152\u017D\u2122\u0161\u0153\u017E\u0178]/g, '');
}

interface StyledWord {
  text: string;
  bold: boolean;
  italic: boolean;
}

function runsToWords(runs: RichRun[]): StyledWord[] {
  const words: StyledWord[] = [];
  for (const run of runs) {
    for (const word of sanitizeForStandardFont(run.text).split(/\s+/)) {
      if (word) words.push({ text: word, bold: Boolean(run.bold), italic: Boolean(run.italic) });
    }
  }
  return words;
}

/** Typesets styled blocks onto A4 pages, preserving inline bold and italics. */
export async function blocksToPdf(blocks: RichBlock[], title = 'Converted Document'): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setProducer('BookForge');

  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.TimesRoman),
    bold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
    italic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
    boldItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic),
  };
  const fontFor = (word: StyledWord) =>
    word.bold && word.italic ? fonts.boldItalic : word.bold ? fonts.bold : word.italic ? fonts.italic : fonts.regular;

  const pageSize: [number, number] = [595.276, 841.89]; // A4
  const margin = 62;
  const bodySize = 11.5;
  const leading = 16.5;
  const maxWidth = pageSize[0] - margin * 2;

  let page = pdfDoc.addPage(pageSize);
  let y = pageSize[1] - margin;
  let pageNumber = 1;

  const stampFooter = () => {
    const label = String(pageNumber);
    const width = fonts.regular.widthOfTextAtSize(label, 9);
    page.drawText(label, {
      x: (pageSize[0] - width) / 2,
      y: margin / 2,
      size: 9,
      font: fonts.regular,
      color: rgb(0.45, 0.45, 0.45),
    });
  };

  const newPage = () => {
    stampFooter();
    page = pdfDoc.addPage(pageSize);
    pageNumber++;
    y = pageSize[1] - margin;
  };

  /** Greedy word wrap that measures every word in its own font. */
  const layout = (words: StyledWord[], size: number, indentFirst: number): StyledWord[][] => {
    const lines: StyledWord[][] = [];
    let line: StyledWord[] = [];
    let width = indentFirst;
    const spaceWidth = fonts.regular.widthOfTextAtSize(' ', size);

    for (const word of words) {
      const wordWidth = fontFor(word).widthOfTextAtSize(word.text, size);
      const needed = line.length === 0 ? width + wordWidth : width + spaceWidth + wordWidth;
      if (needed > maxWidth && line.length > 0) {
        lines.push(line);
        line = [word];
        width = wordWidth;
      } else {
        line.push(word);
        width = needed;
      }
    }
    if (line.length > 0) lines.push(line);
    return lines;
  };

  const drawLine = (words: StyledWord[], size: number, startX: number, align: 'left' | 'center') => {
    if (y < margin + leading) newPage();
    const spaceWidth = fonts.regular.widthOfTextAtSize(' ', size);
    const lineWidth =
      words.reduce((sum, word) => sum + fontFor(word).widthOfTextAtSize(word.text, size), 0) +
      spaceWidth * Math.max(0, words.length - 1);
    let x = align === 'center' ? (pageSize[0] - lineWidth) / 2 : startX;

    for (const word of words) {
      page.drawText(word.text, { x, y, size, font: fontFor(word), color: rgb(0.1, 0.1, 0.1) });
      x += fontFor(word).widthOfTextAtSize(word.text, size) + spaceWidth;
    }
    y -= size >= 14 ? size + 8 : leading;
  };

  for (const line of layout([{ text: sanitizeForStandardFont(title), bold: true, italic: false }], 18, 0)) {
    drawLine(line, 18, margin, 'center');
  }
  y -= 18;

  let firstParagraph = true;
  for (const block of blocks) {
    if (block.type === 'scene') {
      y -= 10;
      drawLine([{ text: '* * *', bold: false, italic: false }], bodySize, margin, 'center');
      y -= 6;
      firstParagraph = true;
    } else if (block.type === 'heading') {
      const size = (block.level ?? 1) <= 1 ? 15 : 13;
      y -= 16;
      if (y < margin + leading * 3) newPage();
      for (const line of layout(runsToWords(block.runs).map((word) => ({ ...word, bold: true })), size, 0)) {
        drawLine(line, size, margin, 'center');
      }
      y -= 8;
      firstParagraph = true;
    } else if (block.type === 'quote') {
      const words = runsToWords(block.runs).map((word) => ({ ...word, italic: true }));
      for (const line of layout(words, bodySize, 24)) drawLine(line, bodySize, margin + 24, 'left');
      y -= 6;
      firstParagraph = true;
    } else if (block.type === 'listItem') {
      const words: StyledWord[] = [{ text: '*', bold: false, italic: false }, ...runsToWords(block.runs)];
      for (const line of layout(words, bodySize, 18)) drawLine(line, bodySize, margin + 18, 'left');
      firstParagraph = true;
    } else {
      const words = runsToWords(block.runs);
      if (words.length === 0) continue;
      const indent = firstParagraph ? 0 : 22;
      const lines = layout(words, bodySize, indent);
      lines.forEach((line, index) => drawLine(line, bodySize, margin + (index === 0 ? indent : 0), 'left'));
      y -= 4;
      firstParagraph = false;
    }
  }
  stampFooter();

  return Buffer.from(await pdfDoc.save());
}

export async function convertTextToPdf(text: string, title = 'Converted Document'): Promise<Buffer> {
  return blocksToPdf(textToBlocks(text), title);
}

function runsToTextRuns(runs: RichRun[], size: number, extra: { color?: string; italics?: boolean } = {}) {
  return runs.map(
    (run) =>
      new TextRun({
        text: run.text,
        font: 'Georgia',
        size,
        bold: run.bold,
        italics: run.italic || extra.italics,
        color: extra.color,
      }),
  );
}

/** Builds a DOCX from styled blocks, keeping emphasis and heading levels. */
export async function blocksToDocx(blocks: RichBlock[], title = 'Converted Document'): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun({ text: title, font: 'Georgia', size: 36, bold: true })],
    }),
  ];

  let firstParagraph = true;
  for (const block of blocks) {
    if (block.type === 'scene') {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 240 },
          children: [new TextRun({ text: '❦', font: 'Georgia', size: 24, color: '888888' })],
        }),
      );
      firstParagraph = true;
    } else if (block.type === 'heading') {
      const level = block.level ?? 1;
      children.push(
        new Paragraph({
          alignment: level <= 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
          pageBreakBefore: level <= 1,
          spacing: { before: level <= 1 ? 240 : 300, after: level <= 1 ? 360 : 160 },
          heading:
            level <= 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: runsToTextRuns(
            block.runs.map((run) => ({ ...run, bold: true })),
            level <= 1 ? 30 : 24,
          ),
        }),
      );
      firstParagraph = true;
    } else if (block.type === 'quote') {
      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: { left: 720, right: 720 },
          spacing: { line: 360, after: 180 },
          children: runsToTextRuns(block.runs, 22, { italics: true, color: '444444' }),
        }),
      );
      firstParagraph = true;
    } else if (block.type === 'listItem') {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { line: 320, after: 80 },
          children: runsToTextRuns(block.runs, 22),
        }),
      );
      firstParagraph = true;
    } else {
      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: { firstLine: firstParagraph ? 0 : 360 },
          spacing: { line: 360, after: 120 },
          children: runsToTextRuns(block.runs, 22),
        }),
      );
      firstParagraph = false;
    }
  }

  const doc = new Document({
    title,
    creator: 'BookForge',
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

export async function convertTextToDocx(text: string, title = 'Converted Document'): Promise<Buffer> {
  return blocksToDocx(textToBlocks(text), title);
}

function escapeRtf(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    // Escape non-ASCII as \uN? so readers do not mangle typographic characters.
    .replace(/[-￿]/g, (char) => `\\u${char.charCodeAt(0)}?`);
}

function runsToRtf(runs: RichRun[]): string {
  return runs
    .map((run) => {
      const open = `${run.bold ? '\\b ' : ''}${run.italic ? '\\i ' : ''}`;
      const close = `${run.italic ? '\\i0 ' : ''}${run.bold ? '\\b0 ' : ''}`;
      return `${open}${escapeRtf(run.text)}${close}`;
    })
    .join('');
}

export function blocksToRtf(blocks: RichBlock[], title = 'Converted Document'): string {
  const body = blocks.map((block) => {
    if (block.type === 'scene') return '\\pard\\sa240\\sb240\\qc\\fs22 * * *\\par';
    if (block.type === 'heading') {
      const size = (block.level ?? 1) <= 1 ? 30 : 26;
      return `\\pard\\sa240\\sb240\\qc\\b\\fs${size} ${escapeRtf(blockText(block))}\\b0\\par`;
    }
    if (block.type === 'quote') {
      return `\\pard\\li720\\ri720\\sa200\\qj\\i\\fs22 ${escapeRtf(blockText(block))}\\i0\\par`;
    }
    if (block.type === 'listItem') {
      return `\\pard\\li360\\sa120\\fs22 \\u8226? ${runsToRtf(block.runs)}\\par`;
    }
    return `\\pard\\sa200\\sl276\\slmult1\\fi360\\qj\\fs22 ${runsToRtf(block.runs)}\\par`;
  });

  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman\\fcharset0 Georgia;}}',
    '\\viewkind4\\uc1',
    `\\pard\\sa240\\qc\\b\\fs36 ${escapeRtf(title)}\\b0\\par`,
    ...body,
    '}',
  ].join('\n');
}

export function convertTextToRtf(text: string, title = 'Converted Document'): string {
  return blocksToRtf(textToBlocks(text), title);
}

/** Builds a DOCX from already-structured chapters (Reader & Editor export). */
async function buildManuscriptDocx(input: {
  title: string;
  subtitle?: string;
  author?: string;
  chapters: { title: string; text: string; sectionType?: string }[];
}): Promise<Buffer> {
  const { title, subtitle, author, chapters } = input;
  const children: Paragraph[] = [];

  const blank = (count = 1) => {
    for (let i = 0; i < count; i++) children.push(new Paragraph({ text: '' }));
  };

  blank(6);
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: title.toUpperCase(), font: 'Georgia', size: 52, bold: true })],
    }),
  );
  if (subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 480 },
        children: [new TextRun({ text: subtitle, font: 'Georgia', size: 26, italics: true, color: '444444' })],
      }),
    );
  }
  if (author) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: author, font: 'Georgia', size: 28 })],
      }),
    );
  }

  chapters.forEach((chapter) => {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        pageBreakBefore: true,
        spacing: { before: 240, after: 480 },
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: chapter.title || 'Untitled Section', font: 'Georgia', size: 32, bold: true })],
      }),
    );

    const isCentered = chapter.sectionType === 'copyright' || chapter.sectionType === 'toc';
    let firstParagraph = true;
    for (const rawLine of (chapter.text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      children.push(
        new Paragraph({
          alignment: isCentered ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
          indent: isCentered || firstParagraph ? undefined : { firstLine: 360 },
          spacing: { line: 360, after: 140 },
          children: [new TextRun({ text: line, font: 'Georgia', size: isCentered ? 20 : 22 })],
        }),
      );
      firstParagraph = false;
    }
  });

  const doc = new Document({
    title,
    creator: author || 'BookForge',
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  txt: 'text/plain; charset=utf-8',
  rtf: 'application/rtf',
};

function handleError(res: Response, error: unknown, message: string) {
  if (error instanceof AiUnavailableError) {
    res.status(503).json({ error: error.message });
    return;
  }
  const details = error instanceof Error ? error.message : String(error);
  console.error(`${message}:`, error);
  res.status(500).json({ error: `${message} (${details})`, details });
}

function sendDocument(res: Response, buffer: Buffer, fileName: string, format: string) {
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  res.setHeader('Content-Type', MIME_TYPES[format] ?? 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

function requireFile(req: Request, res: Response): Express.Multer.File | null {
  if (!req.file) {
    res.status(400).json({ error: 'No file was uploaded. Attach a file under the "file" field.' });
    return null;
  }
  return req.file;
}

function baseNameOf(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function deriveTitle(text: string, fileName: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine && firstLine.length <= 120) return firstLine.replace(/^#+\s*/, '');
  return baseNameOf(fileName);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
  return ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Per-IP fixed-window limiter. The AI routes spend real money on someone's API
 * key, so they are capped separately and more tightly than conversion.
 *
 * NOTE: state is per serverless instance, so the effective ceiling on Vercel is
 * this limit multiplied by the number of warm instances. It stops casual abuse,
 * not a distributed attack — put a WAF or gateway limiter in front for that.
 */
function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (max <= 0) {
      next();
      return;
    }
    const key = `${name}:${clientKey(req)}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    } else if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: `Rate limit reached for this endpoint. Try again in ${retryAfter}s.`,
        retryAfter,
      });
      return;
    } else {
      bucket.count++;
    }

    // Opportunistic cleanup so the map cannot grow without bound.
    if (rateBuckets.size > 5000) {
      for (const [entryKey, entry] of rateBuckets) {
        if (entry.resetAt <= now) rateBuckets.delete(entryKey);
      }
    }
    next();
  };
}

const AI_ROUTES = [
  '/api/book/analyze-discovery',
  '/api/book/generate-outline',
  '/api/book/generate-chapter',
  '/api/book/translate-chunk',
  '/api/book/enhance-draft',
  '/api/book/lookup',
  '/api/book/generate-cover',
  '/api/author-empire/generate-titles',
  '/api/author-empire/generate-blurb',
  '/api/author-empire/analyze-cover',
  '/api/translate/brief',
  '/api/translate/segment',
  '/api/translate/polish',
];

app.use(AI_ROUTES, rateLimit('ai', Number(process.env.AI_RATE_LIMIT ?? 40), 60 * 60 * 1000));
app.use(
  ['/api/translate/segment', '/api/translate/polish'],
  rateLimit('translate', Number(process.env.TRANSLATE_RATE_LIMIT ?? 1200), 60 * 60 * 1000),
);
app.use(
  ['/api/book/convert', '/api/book/parse-file', '/api/translate/prepare', '/api/translate/export'],
  rateLimit('convert', Number(process.env.CONVERT_RATE_LIMIT ?? 120), 60 * 60 * 1000),
);
// The image model is the most expensive call in the app.
app.use('/api/book/generate-cover', rateLimit('cover', Number(process.env.COVER_RATE_LIMIT ?? 10), 60 * 60 * 1000));

// ---------------------------------------------------------------------------
// API — health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    node: process.version,
    ai: geminiClient ? 'gemini' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'disabled',
    // Non-null when a second provider is configured to take over on failure.
    fallback: geminiClient && process.env.OPENROUTER_API_KEY ? 'openrouter' : null,
    imageGeneration: geminiClient ? 'available' : 'requires GEMINI_API_KEY',
  });
});

// ---------------------------------------------------------------------------
// API — document parsing & conversion
// ---------------------------------------------------------------------------

app.post('/api/book/parse-file', upload.single('file'), async (req, res) => {
  const file = requireFile(req, res);
  if (!file) return;
  try {
    const text = await extractTextFromFile(file.buffer, file.originalname);
    if (!text.trim()) {
      res.status(422).json({ error: 'No extractable text was found in this file.' });
      return;
    }
    const structure = parseDocumentStructure(text);
    res.json({
      ...structure,
      title: structure.title || baseNameOf(file.originalname),
      sourceFormat: formatFromName(file.originalname),
      wordCount: text.split(/\s+/).filter(Boolean).length,
    });
  } catch (error) {
    handleError(res, error, 'Failed to parse the uploaded manuscript');
  }
});

const convertUpload = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 },
]);

app.post('/api/book/convert', convertUpload, async (req, res) => {
  const uploaded = req.files as Record<string, Express.Multer.File[]> | undefined;
  const file = req.file ?? uploaded?.file?.[0];
  if (!file) {
    res.status(400).json({ error: 'No file was uploaded. Attach a file under the "file" field.' });
    return;
  }
  const coverFile = uploaded?.coverImage?.[0];

  const targetFormat = String(req.body?.targetFormat ?? '').toLowerCase();
  if (!Object.keys(MIME_TYPES).includes(targetFormat)) {
    res.status(400).json({ error: `Unsupported target format "${targetFormat}". Use docx, pdf, epub, txt or rtf.` });
    return;
  }
  const sourceFormat = formatFromName(file.originalname);
  if (!sourceFormat) {
    res.status(400).json({ error: `Unsupported source file type: ${path.extname(file.originalname)}` });
    return;
  }
  if (sourceFormat === targetFormat) {
    res.status(400).json({ error: 'Source and target formats are identical — pick a different target.' });
    return;
  }

  try {
    // Conversion runs on the styled block model, so bold, italics and heading
    // levels from a DOCX or EPUB survive into whatever comes out.
    const blocks = await extractBlocksFromFile(file.buffer, file.originalname);
    const text = blocksToPlainText(blocks);
    if (!text.trim()) {
      res.status(422).json({ error: 'No extractable text was found in this file.' });
      return;
    }

    const title = deriveTitle(text, file.originalname);
    const author = String(req.body?.author ?? '').trim() || 'BookForge';
    const fileName = `${baseNameOf(file.originalname)}.${targetFormat}`;

    switch (targetFormat) {
      case 'docx':
        sendDocument(res, await blocksToDocx(blocks, title), fileName, targetFormat);
        return;
      case 'pdf':
        sendDocument(res, await blocksToPdf(blocks, title), fileName, targetFormat);
        return;
      case 'epub': {
        const cover =
          coverFile && /^image\/(png|jpeg|webp|gif)$/.test(coverFile.mimetype)
            ? { data: coverFile.buffer, mimeType: coverFile.mimetype }
            : undefined;
        const epub = blocksToEpub(blocks, title, {
          author,
          language: String(req.body?.language ?? '').trim() || 'en',
          publisher: String(req.body?.publisher ?? '').trim() || undefined,
          description: String(req.body?.description ?? '').trim() || undefined,
          isbn: String(req.body?.isbn ?? '').trim() || undefined,
          series: String(req.body?.series ?? '').trim() || undefined,
          cover,
        });
        const check = validateEpubStructure(epub);
        // Surfaced in the UI as a validation badge on the download card.
        res.setHeader('X-Epub-Valid', String(check.valid));
        if (check.warnings.length > 0) res.setHeader('X-Epub-Warnings', String(check.warnings.length));
        res.setHeader('Access-Control-Expose-Headers', 'X-Epub-Valid, X-Epub-Warnings');
        sendDocument(res, epub, fileName, targetFormat);
        return;
      }
      case 'rtf':
        sendDocument(res, Buffer.from(blocksToRtf(blocks, title), 'utf8'), fileName, targetFormat);
        return;
      case 'txt':
      default:
        sendDocument(res, Buffer.from(text, 'utf8'), fileName, 'txt');
    }
  } catch (error) {
    handleError(res, error, 'Failed to convert the uploaded file');
  }
});

app.post('/api/book/validate-epub', upload.single('file'), async (req, res) => {
  const file = requireFile(req, res);
  if (!file) return;
  try {
    if (sniffFormat(file.buffer) !== 'epub') {
      res.status(400).json({ error: 'That file is not an EPUB package.' });
      return;
    }
    res.json({ fileName: file.originalname, ...validateEpubStructure(file.buffer) });
  } catch (error) {
    handleError(res, error, 'Failed to validate the EPUB');
  }
});

app.post('/api/book/export-custom-docx', async (req, res) => {
  try {
    const { title, subtitle, author, chapters } = req.body ?? {};
    if (!Array.isArray(chapters) || chapters.length === 0) {
      res.status(400).json({ error: 'At least one chapter is required.' });
      return;
    }
    const buffer = await buildManuscriptDocx({
      title: String(title || 'Untitled Manuscript'),
      subtitle: subtitle ? String(subtitle) : undefined,
      author: author ? String(author) : undefined,
      chapters: chapters.map((chapter: { title?: string; text?: string; sectionType?: string }) => ({
        title: String(chapter.title ?? 'Untitled Section'),
        text: String(chapter.text ?? ''),
        sectionType: chapter.sectionType,
      })),
    });
    const fileName = `${String(title || 'manuscript').trim().replace(/\s+/g, '_')}.docx`;
    sendDocument(res, buffer, fileName, 'docx');
  } catch (error) {
    handleError(res, error, 'Failed to compile the DOCX document');
  }
});

// ---------------------------------------------------------------------------
// API — AI writing tools
// ---------------------------------------------------------------------------

app.post('/api/book/analyze-discovery', async (req, res) => {
  try {
    const { title, genre, audience, tone, premise, pacing, answers } = req.body ?? {};
    const prompt = `You are a premium literary development consultant preparing a book for publication.

Book title: ${title || 'Untitled'}
Genre: ${genre || 'unspecified'}
Target audience: ${audience || 'general readers'}
Tone: ${tone || 'unspecified'}
Pacing: ${pacing || 'balanced'}
Premise: ${premise || 'not provided'}

Author's discovery answers:
${JSON.stringify(answers ?? {}, null, 2)}

Return a rigorous development analysis. Be concrete and specific to this premise — no generic advice.`;

    const response = await generateContentWithRetry({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            audienceStrategy: { type: Type.STRING },
            structuralStyle: { type: Type.STRING },
            thematicThreads: { type: Type.STRING },
            milestones: { type: Type.ARRAY, items: { type: Type.STRING } },
            architectAdvice: { type: Type.STRING },
          },
          required: ['audienceStrategy', 'structuralStyle', 'thematicThreads', 'milestones', 'architectAdvice'],
        },
      },
    });
    res.json(robustJsonParse(response.text ?? ''));
  } catch (error) {
    handleError(res, error, 'Failed to analyze the book concept');
  }
});

app.post('/api/book/generate-outline', async (req, res) => {
  try {
    const {
      title,
      subtitle,
      genre,
      audience,
      tone,
      premise,
      pacing,
      authorPersona,
      targetChapterCount,
      targetWordCount,
      discoveryAnalysis,
      customChaptersInput,
    } = req.body ?? {};

    const chapterCount = Number(targetChapterCount) > 0 ? Number(targetChapterCount) : 12;
    const prompt = `You are a bestselling book architect. Produce a chapter-by-chapter blueprint.

Title: ${title || 'Untitled'}${subtitle ? ` — ${subtitle}` : ''}
Genre: ${genre || 'unspecified'} | Audience: ${audience || 'general'} | Tone: ${tone || 'unspecified'} | Pacing: ${pacing || 'balanced'}
Author voice: ${authorPersona || 'versatile professional'}
Premise: ${premise || 'not provided'}
Target: ${chapterCount} chapters, roughly ${Number(targetWordCount) || 50000} words total.
${discoveryAnalysis ? `Development analysis: ${JSON.stringify(discoveryAnalysis)}` : ''}
${customChaptersInput ? `The author insists on these chapter ideas: ${customChaptersInput}` : ''}

Rules:
- Exactly ${chapterCount} chapters, numbered from 1.
- Each chapter needs a distinct dramatic or instructional function; no repetition.
- estimatedWordCount values should sum to roughly the target word count.`;

    const response = await generateContentWithRetry({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestedBookTitle: { type: Type.STRING },
            suggestedSubTitle: { type: Type.STRING },
            chaptersSettingFocus: { type: Type.STRING },
            chapters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  chapterNumber: { type: Type.INTEGER },
                  title: { type: Type.STRING },
                  focus: { type: Type.STRING },
                  subsections: { type: Type.ARRAY, items: { type: Type.STRING } },
                  emotionalArcOrKeyLesson: { type: Type.STRING },
                  estimatedWordCount: { type: Type.INTEGER },
                },
                required: ['chapterNumber', 'title', 'focus', 'subsections', 'emotionalArcOrKeyLesson', 'estimatedWordCount'],
              },
            },
          },
          required: ['suggestedBookTitle', 'suggestedSubTitle', 'chaptersSettingFocus', 'chapters'],
        },
      },
    });
    res.json(robustJsonParse(response.text ?? ''));
  } catch (error) {
    handleError(res, error, 'Failed to generate the outline');
  }
});

app.post('/api/book/generate-chapter', async (req, res) => {
  try {
    const { bookTitle, genre, tone, authorPersona, chapterOutline, previousSummary, targetWordCount } = req.body ?? {};
    if (!chapterOutline) {
      res.status(400).json({ error: 'chapterOutline is required.' });
      return;
    }

    const words = Number(targetWordCount) || Number(chapterOutline?.estimatedWordCount) || 2500;
    const prompt = `Write chapter ${chapterOutline.chapterNumber} of "${bookTitle || 'Untitled'}".

Genre: ${genre || 'unspecified'} | Tone: ${tone || 'unspecified'}
Author voice to emulate: ${authorPersona || 'clear, confident professional prose'}
Chapter title: ${chapterOutline.title}
Focus: ${chapterOutline.focus}
Sub-beats: ${(chapterOutline.subsections ?? []).join(' | ')}
Emotional arc / key lesson: ${chapterOutline.emotionalArcOrKeyLesson}
${previousSummary ? `What happened previously: ${previousSummary}` : ''}

Requirements:
- Approximately ${words} words of finished prose.
- Do not restate the chapter number or title as a heading; start with the prose itself.
- Use "***" on its own line for scene breaks.
- No meta-commentary, no placeholders, no bullet summaries.`;

    const response = await generateContentWithRetry({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chapterText: { type: Type.STRING },
            actualWordCount: { type: Type.INTEGER },
            statusIntermission: {
              type: Type.OBJECT,
              properties: {
                progressSummary: { type: Type.STRING },
                narrativeSummary: { type: Type.STRING },
                nextUpTeaser: { type: Type.STRING },
              },
              required: ['progressSummary', 'narrativeSummary', 'nextUpTeaser'],
            },
          },
          required: ['chapterText', 'actualWordCount', 'statusIntermission'],
        },
      },
    });

    const parsed = robustJsonParse(response.text ?? '');
    const chapterText = String(parsed.chapterText ?? '');
    res.json({
      ...parsed,
      chapterText,
      actualWordCount: chapterText.split(/\s+/).filter(Boolean).length,
    });
  } catch (error) {
    handleError(res, error, 'Failed to generate the chapter');
  }
});

app.post('/api/book/translate-chunk', async (req, res) => {
  try {
    const { text, targetLanguage, sourceLanguage, preserveFormatting = true } = req.body ?? {};
    if (!text || !targetLanguage) {
      res.status(400).json({ error: 'Both "text" and "targetLanguage" are required.' });
      return;
    }

    const prompt = `Translate the following book passage into ${targetLanguage}${
      sourceLanguage ? ` from ${sourceLanguage}` : ''
    }.

Rules:
- Preserve the literary register, rhythm and voice of the original.
- ${preserveFormatting ? 'Keep paragraph breaks, scene breaks ("***") and headings exactly as they appear.' : 'Return clean prose.'}
- Translate idioms into their natural equivalent rather than word-for-word.
- Output ONLY the translated text, with no preamble or commentary.

PASSAGE:
${text}`;

    const response = await generateContentWithRetry({ contents: prompt });
    const translatedText = (response.text ?? '').trim();
    res.json({ translatedText, targetLanguage, characterCount: translatedText.length });
  } catch (error) {
    handleError(res, error, 'Failed to translate the passage');
  }
});

app.post('/api/book/enhance-draft', async (req, res) => {
  try {
    const { text, instruction, tone, intensity = 'balanced' } = req.body ?? {};
    if (!text) {
      res.status(400).json({ error: '"text" is required.' });
      return;
    }

    const prompt = `You are a senior line editor polishing a book draft.

Editing intensity: ${intensity} (light = fix mechanics only; balanced = tighten prose; heavy = rewrite for impact)
${tone ? `Target tone: ${tone}` : ''}
${instruction ? `Author's instruction: ${instruction}` : ''}

Rules:
- Preserve the author's meaning, facts, names and structure.
- Keep paragraph breaks and scene breaks intact.
- Remove filler, fix rhythm, strengthen verbs, cut clichés.
- Output ONLY the edited prose.

DRAFT:
${text}`;

    const response = await generateContentWithRetry({ contents: prompt });
    const enhancedText = (response.text ?? '').trim();
    res.json({
      enhancedText,
      originalWordCount: String(text).split(/\s+/).filter(Boolean).length,
      enhancedWordCount: enhancedText.split(/\s+/).filter(Boolean).length,
    });
  } catch (error) {
    handleError(res, error, 'Failed to enhance the draft');
  }
});

/** In-reader dictionary: define, explain or translate a selected passage. */
app.post('/api/book/lookup', async (req, res) => {
  try {
    const { text, context, bookTitle, targetLanguage } = req.body ?? {};
    if (!text || !String(text).trim()) {
      res.status(400).json({ error: '"text" is required.' });
      return;
    }

    const selection = String(text).slice(0, 400);
    const isPhrase = selection.trim().split(/\s+/).length > 3;
    const prompt = targetLanguage
      ? `Translate this passage into ${targetLanguage}, then add one short line on any idiom or cultural reference a reader might miss.\n\nPASSAGE: "${selection}"\n${context ? `\nSURROUNDING TEXT: ${context}` : ''}`
      : `A reader selected ${isPhrase ? 'this passage' : 'this word'} while reading${
          bookTitle ? ` "${bookTitle}"` : ''
        } and wants to understand it.

SELECTION: "${selection}"
${context ? `SURROUNDING TEXT: ${context}` : ''}

Reply in at most 70 words, plain prose, no headings or bullet points:
${
  isPhrase
    ? '- Explain what the passage means in this context, including any allusion or idiom.'
    : '- Give the part of speech and a concise definition, then the sense being used here.'
}
Do not restate the selection or add commentary about the book as a whole.`;

    const response = await generateContentWithRetry({ contents: prompt });
    res.json({ term: selection, explanation: (response.text ?? '').trim() });
  } catch (error) {
    handleError(res, error, 'Failed to look up the selection');
  }
});

app.post('/api/book/export-translated-docx', async (req, res) => {
  try {
    const { title, author, language, chapters } = req.body ?? {};
    if (!Array.isArray(chapters) || chapters.length === 0) {
      res.status(400).json({ error: 'At least one translated chapter is required.' });
      return;
    }
    const docTitle = String(title || 'Translated Manuscript');
    const buffer = await buildManuscriptDocx({
      title: docTitle,
      subtitle: language ? `${language} edition` : undefined,
      author: author ? String(author) : undefined,
      chapters: chapters.map((chapter: { title?: string; translatedText?: string; text?: string }) => ({
        title: String(chapter.title ?? 'Untitled Section'),
        text: String(chapter.translatedText ?? chapter.text ?? ''),
      })),
    });
    const suffix = language ? `_${String(language).replace(/\s+/g, '_')}` : '_translated';
    sendDocument(res, buffer, `${docTitle.trim().replace(/\s+/g, '_')}${suffix}.docx`, 'docx');
  } catch (error) {
    handleError(res, error, 'Failed to export the translated DOCX');
  }
});

app.post('/api/book/export-docx', async (req, res) => {
  try {
    const project = req.body ?? {};
    const outline = project.outline;
    const title = String(outline?.suggestedBookTitle || project.title || 'Untitled Manuscript');
    const subtitle = String(outline?.suggestedSubTitle || project.subtitle || '');
    const penName = String(project.penName || project.author || 'Unknown Author');
    const year = new Date().getFullYear();

    const outlineChapters: { chapterNumber: number; title: string }[] = Array.isArray(outline?.chapters)
      ? outline.chapters
      : Array.isArray(project.chapters)
        ? project.chapters.map((c: { chapterNumber?: number; title?: string }, i: number) => ({
            chapterNumber: c.chapterNumber ?? i + 1,
            title: c.title ?? `Chapter ${i + 1}`,
          }))
        : [];

    if (outlineChapters.length === 0) {
      res.status(400).json({ error: 'The project has no chapters to export.' });
      return;
    }

    const drafts: { chapterNumber?: number; text?: string }[] = Array.isArray(project.chapters) ? project.chapters : [];

    const frontMatter: { title: string; text: string; sectionType?: string }[] = [
      {
        title: 'Copyright',
        sectionType: 'copyright',
        text: [
          title,
          subtitle,
          `Copyright © ${year} by ${penName}`,
          'All rights reserved. No part of this book may be reproduced or used in any manner without written permission of the copyright owner.',
          'ISBN-13: [Placeholder for KDP registration ISBN]',
          `First edition: ${year}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
    if (project.dedicationText) {
      frontMatter.push({ title: 'Dedication', sectionType: 'copyright', text: String(project.dedicationText) });
    }
    frontMatter.push({
      title: 'Table of Contents',
      sectionType: 'toc',
      text: outlineChapters
        .map((chapter) => `Chapter ${chapter.chapterNumber}: ${chapter.title.replace(/^Chapter\s+\d+:\s*/i, '')}`)
        .join('\n'),
    });

    const bodyChapters = outlineChapters.map((chapter) => {
      const draft = drafts.find((d) => d.chapterNumber === chapter.chapterNumber);
      return {
        title: `Chapter ${chapter.chapterNumber}: ${chapter.title.replace(/^Chapter\s+\d+:\s*/i, '')}`,
        text: String(draft?.text ?? '').trim() || 'Chapter content pending.',
      };
    });

    const backMatter: { title: string; text: string }[] = [];
    if (project.acknowledgementsText) {
      backMatter.push({ title: 'Acknowledgements', text: String(project.acknowledgementsText) });
    }
    if (project.aboutAuthorText) {
      backMatter.push({ title: 'About the Author', text: String(project.aboutAuthorText) });
    }

    const buffer = await buildManuscriptDocx({
      title,
      subtitle,
      author: penName,
      chapters: [...frontMatter, ...bodyChapters, ...backMatter],
    });
    sendDocument(res, buffer, `${title.replace(/[^a-zA-Z0-9]+/g, '_')}_KDP_Edition.docx`, 'docx');
  } catch (error) {
    handleError(res, error, 'Failed to export the KDP DOCX');
  }
});

app.post('/api/book/generate-cover', async (req, res) => {
  try {
    const { title, subtitle, genre, mood, styleHint, author, aspectRatio = '3:4' } = req.body ?? {};
    if (!geminiClient) throw new AiUnavailableError();

    const prompt = `Design a professional, commercially viable book cover illustration.

Title: ${title || 'Untitled'}${subtitle ? ` — ${subtitle}` : ''}
Author: ${author || 'unknown'}
Genre: ${genre || 'general fiction'}
Mood: ${mood || 'evocative and premium'}
Art direction: ${styleHint || 'modern trade-paperback aesthetic, strong focal subject, high contrast, cinematic lighting'}

Composition: leave clean negative space in the upper third for the title treatment and the lower fifth for the author name. No text, no lettering, no watermarks in the image.`;

    const response = await geminiClient.models.generateImages({
      model: IMAGE_MODEL,
      prompt,
      config: { numberOfImages: 1, aspectRatio, outputMimeType: 'image/png' },
    });

    const image = response.generatedImages?.[0]?.image;
    if (!image?.imageBytes) {
      res.status(502).json({ error: 'The image model returned no cover. Try a different prompt or mood.' });
      return;
    }
    const mimeType = image.mimeType ?? 'image/png';
    res.json({ mimeType, imageUrl: `data:${mimeType};base64,${image.imageBytes}`, prompt });
  } catch (error) {
    handleError(res, error, 'Failed to generate the cover');
  }
});

// ---------------------------------------------------------------------------
// Manuscript translation
//
// Book-length translation fails in predictable ways: voice drifts between
// chunks, character and place names change spelling halfway through, emphasis
// and structure are flattened, and the prose reads like a translation. The
// pipeline below is built around those four failures.
// ---------------------------------------------------------------------------

export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
  /** Proper nouns and invented terms that must survive untranslated. */
  keepAsIs?: boolean;
}

export interface TranslationBrief {
  detectedSourceLanguage: string;
  genre: string;
  narrativeVoice: string;
  register: string;
  tense: string;
  formality: string;
  rhythmNotes: string;
  culturalNotes: string;
  translatorGuidance: string;
  glossary: GlossaryEntry[];
}

export interface TranslationSegment {
  index: number;
  label: string;
  startBlock: number;
  endBlock: number;
  words: number;
}

/** Typographic conventions a published book in each language is expected to follow. */
const TYPOGRAPHY_RULES: Record<string, string> = {
  spanish:
    'Use « » or em dashes for dialogue as the target market expects (Latin American editions normally use em dashes), open questions and exclamations with ¿ and ¡, and never carry over English quotation marks.',
  french:
    'Use guillemets « » for dialogue with a non-breaking space inside them, em dashes for turns of speech, and a narrow non-breaking space before ; : ! and ?.',
  german:
    'Use „low-high" quotation marks, capitalise all nouns, and respect German compound formation rather than splitting into English-style noun phrases.',
  italian:
    'Use « » or em dashes for dialogue as the edition requires, and avoid the English habit of possessive apostrophes.',
  portuguese: 'Use em dashes to open lines of dialogue and « » where the edition calls for quotation.',
  japanese:
    'Use 「」 for speech, no spaces between words, 、and 。for punctuation, and choose a consistent politeness level per speaker.',
  korean: 'Use “ ” or 「」 as the edition requires and keep speech levels consistent per character relationship.',
  chinese: 'Use “ ” and full-width punctuation throughout, with no spaces between characters.',
  arabic:
    'Use Arabic punctuation (، ؛ ؟), right-to-left ordering, and choose a consistent register between Modern Standard and the target dialect.',
  russian: 'Use « » for quotation and em dashes to open dialogue, following Russian punctuation rules.',
  polish: 'Use „low-high" quotation marks and em dashes for dialogue.',
  dutch: 'Use ‘ ’ or “ ” per house style and avoid English compound spacing.',
  hindi: 'Use Devanagari punctuation conventions, including the danda where appropriate.',
  swahili: 'Prefer natural Swahili idiom over calques from English, and keep noun-class agreement consistent.',
  yoruba: 'Use correct tone marks and diacritics throughout; they are not optional for a published book.',
};

function typographyFor(language: string): string {
  const key = Object.keys(TYPOGRAPHY_RULES).find((name) => language.toLowerCase().includes(name));
  return key
    ? TYPOGRAPHY_RULES[key]
    : 'Follow the punctuation and quotation conventions a published book in this language uses, not the source language conventions.';
}

const RUN_OPEN_BOLD = '<b>';
const RUN_CLOSE_BOLD = '</b>';
const RUN_OPEN_ITALIC = '<i>';
const RUN_CLOSE_ITALIC = '</i>';

/**
 * Serialises blocks into numbered, tagged lines. The model only ever returns
 * text for these lines, so block types, ordering and document structure come
 * from our side and cannot be hallucinated away.
 */
export function serializeBlocksForTranslation(blocks: RichBlock[], startIndex = 0): string {
  return blocks
    .map((block, offset) => {
      const id = startIndex + offset + 1;
      if (block.type === 'scene') return `[${id}|scene]`;
      const body = block.runs
        .map((run) => {
          let text = run.text;
          if (run.italic) text = `${RUN_OPEN_ITALIC}${text}${RUN_CLOSE_ITALIC}`;
          if (run.bold) text = `${RUN_OPEN_BOLD}${text}${RUN_CLOSE_BOLD}`;
          return text;
        })
        .join('');
      const kind = block.type === 'heading' ? `h${block.level ?? 1}` : block.type === 'quote' ? 'quote' : block.type === 'listItem' ? 'li' : 'p';
      return `[${id}|${kind}] ${body}`;
    })
    .join('\n');
}

function parseTaggedRuns(text: string): RichRun[] {
  // Models are inconsistent about emphasis: <b>, <B>, < b >, or markdown.
  // Normalise everything to lowercase tags before parsing so nothing is lost.
  let normalized = text
    .replace(/<\s*(b|strong)\s*>/gi, '<b>')
    .replace(/<\s*\/\s*(b|strong)\s*>/gi, '</b>')
    .replace(/<\s*(i|em)\s*>/gi, '<i>')
    .replace(/<\s*\/\s*(i|em)\s*>/gi, '</i>');

  if (!/<[bi]>/.test(normalized)) {
    normalized = normalized
      .replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  }

  // Drop an unmatched trailing opener rather than swallowing the rest of the line.
  for (const tag of ['b', 'i'] as const) {
    const opens = (normalized.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
    const closes = (normalized.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (opens > closes) normalized += `</${tag}>`.repeat(opens - closes);
    if (closes > opens) normalized = normalized.replace(new RegExp(`</${tag}>`), '');
  }

  const runs: RichRun[] = [];
  const pattern = /<(b|i)>([\s\S]*?)<\/\1>|([^<]+)|(<[^>]*>)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized)) !== null) {
    if (match[4] !== undefined) continue; // stray tag we do not understand
    if (match[3] !== undefined) {
      if (match[3]) runs.push({ text: match[3] });
      continue;
    }
    const inner = match[2] ?? '';
    if (!inner) continue;
    const nested = /<[bi]>/.test(inner);
    runs.push({
      text: inner.replace(/<\/?[bi]>/g, ''),
      bold: match[1] === 'b' || nested,
      italic: match[1] === 'i' || nested,
    });
  }

  return runs.length > 0 ? runs : [{ text: normalized.replace(/<\/?[bi]>/g, '') }];
}

export interface ParsedTranslation {
  blocks: RichBlock[];
  /** Blocks the model dropped; the source text is kept so nothing is silently lost. */
  missing: number[];
}

/**
 * Rebuilds blocks from the model's numbered lines. Block type and order are
 * taken from the originals, so a malformed response degrades to "this
 * paragraph was not translated" rather than a corrupted manuscript.
 */
export function parseTranslatedBlocks(response: string, originals: RichBlock[], startIndex = 0): ParsedTranslation {
  const byId = new Map<number, string>();
  const linePattern = /^\s*\[(\d+)\|[^\]]*\]\s?([\s\S]*?)$/;

  for (const rawLine of response.replace(/\r\n?/g, '\n').split('\n')) {
    const match = rawLine.match(linePattern);
    if (!match) continue;
    const id = Number.parseInt(match[1], 10);
    const existing = byId.get(id);
    byId.set(id, existing ? `${existing} ${match[2].trim()}` : match[2].trim());
  }

  const missing: number[] = [];
  const blocks = originals.map((original, offset) => {
    const id = startIndex + offset + 1;
    if (original.type === 'scene') return original;

    const translated = byId.get(id);
    if (translated === undefined || translated === '') {
      missing.push(id);
      return original;
    }
    return original.level === undefined
      ? { type: original.type, runs: parseTaggedRuns(translated) }
      : { type: original.type, level: original.level, runs: parseTaggedRuns(translated) };
  });

  return { blocks, missing };
}

/**
 * Groups blocks into translation segments that never split a paragraph and
 * prefer to break at chapter headings, so each request carries a coherent
 * piece of prose rather than an arbitrary window.
 */
export function planTranslationSegments(blocks: RichBlock[], targetWords = 800): TranslationSegment[] {
  const segments: TranslationSegment[] = [];
  let start = 0;
  let words = 0;
  let label = 'Opening';

  const push = (end: number) => {
    if (end < start) return;
    segments.push({ index: segments.length, label, startBlock: start, endBlock: end, words });
    start = end + 1;
    words = 0;
  };

  blocks.forEach((block, index) => {
    const isChapterStart = block.type === 'heading' && (block.level ?? 1) <= 1;
    if (isChapterStart && index > start) {
      push(index - 1);
      label = blockText(block).slice(0, 60) || `Section ${segments.length + 1}`;
    } else if (isChapterStart) {
      label = blockText(block).slice(0, 60) || label;
    }

    words += blockText(block).split(/\s+/).filter(Boolean).length;

    if (words >= targetWords && index >= start) {
      push(index);
      label = `${label} (cont.)`;
    }
  });

  if (start < blocks.length) push(blocks.length - 1);
  return segments.filter((segment) => segment.endBlock >= segment.startBlock);
}

function glossaryTable(glossary: GlossaryEntry[]): string {
  if (!glossary || glossary.length === 0) return 'None supplied.';
  return glossary
    .slice(0, 400)
    .map((entry) =>
      entry.keepAsIs
        ? `- "${entry.source}" → keep exactly as "${entry.source}" (do not translate)${entry.note ? ` — ${entry.note}` : ''}`
        : `- "${entry.source}" → always "${entry.target}"${entry.note ? ` — ${entry.note}` : ''}`,
    )
    .join('\n');
}

function briefSummary(brief: Partial<TranslationBrief> | undefined): string {
  if (!brief) return 'No brief supplied — infer the voice from the passage itself.';
  return [
    brief.genre ? `Genre: ${brief.genre}` : '',
    brief.narrativeVoice ? `Narrative voice: ${brief.narrativeVoice}` : '',
    brief.register ? `Register: ${brief.register}` : '',
    brief.tense ? `Tense and person: ${brief.tense}` : '',
    brief.formality ? `Formality to use with the reader and between characters: ${brief.formality}` : '',
    brief.rhythmNotes ? `Rhythm and sentence shape: ${brief.rhythmNotes}` : '',
    brief.culturalNotes ? `Cultural handling: ${brief.culturalNotes}` : '',
    brief.translatorGuidance ? `Author-specific guidance: ${brief.translatorGuidance}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// --- routes ----------------------------------------------------------------

/** Reads a manuscript and returns the structure a translation job runs on. */
app.post('/api/translate/prepare', upload.single('file'), async (req, res) => {
  const file = requireFile(req, res);
  if (!file) return;
  try {
    const blocks = await extractBlocksFromFile(file.buffer, file.originalname);
    if (blocks.length === 0) {
      res.status(422).json({ error: 'No readable text was found in this file.' });
      return;
    }
    const segments = planTranslationSegments(blocks, Number(req.body?.segmentWords) || 800);
    const text = blocksToPlainText(blocks);
    const structure = parseDocumentStructure(text);

    res.json({
      title:
        structure.title && structure.title !== 'Untitled Manuscript'
          ? structure.title
          : baseNameOf(file.originalname),
      author: structure.author || '',
      blocks,
      segments,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      sourceFormat: formatFromName(file.originalname),
    });
  } catch (error) {
    handleError(res, error, 'Failed to prepare the manuscript for translation');
  }
});

/**
 * Reads samples from across the book and produces the brief every later
 * request is bound by: voice, register, formality, and the glossary that stops
 * names and invented terms drifting between chapters.
 */
app.post('/api/translate/brief', async (req, res) => {
  try {
    const { blocks, targetLanguage, title, author, authorNotes } = req.body ?? {};
    if (!Array.isArray(blocks) || blocks.length === 0 || !targetLanguage) {
      res.status(400).json({ error: '"blocks" and "targetLanguage" are required.' });
      return;
    }

    // Sample the opening, three points through the body, and the closing, so
    // the brief reflects the whole book rather than only its first pages.
    const typed = blocks as RichBlock[];
    const picks = [0, 0.2, 0.45, 0.7, 0.92].map((ratio) => Math.floor(typed.length * ratio));
    const sample = picks
      .map((at) => typed.slice(at, at + 14).map((block) => blockText(block)).filter(Boolean).join('\n\n'))
      .filter(Boolean)
      .join('\n\n[...]\n\n')
      .slice(0, 14000);

    const prompt = `You are a senior literary translator preparing to translate an entire book into ${targetLanguage}. Before translating a word, you write a translation brief.

BOOK: ${title || 'Untitled'}${author ? ` by ${author}` : ''}
${authorNotes ? `AUTHOR'S INSTRUCTIONS: ${authorNotes}` : ''}

SAMPLES FROM THROUGHOUT THE MANUSCRIPT:
${sample}

Produce the brief. Requirements:
- Identify the source language, the genre, and the narrative voice precisely enough that another translator could match it.
- State the register (how formal, how contemporary, how ornate) and the tense/person.
- Decide the formality convention to use in ${targetLanguage} — for example tú vs usted, tu vs vous, plain vs polite forms — and say when each applies between characters. Be decisive; the whole book will follow this.
- Describe the rhythm: sentence length variation, paragraph shape, how dialogue sounds.
- Say how to handle culturally specific material: measurements, foods, songs, institutions, jokes, wordplay. Prefer solutions a reader in the target culture understands without footnotes.
- Build a glossary of every proper noun, invented term, honorific and repeated distinctive phrase you can see, with the exact form to use in ${targetLanguage} every time it appears. Mark keepAsIs true for names that must not be translated. This glossary is what keeps a 300-page translation consistent, so be thorough.
- translatorGuidance: the two or three things a translator of this specific book most needs to get right.

Write the brief in English. Glossary targets must be in ${targetLanguage}.`;

    const response = await generateContentWithRetry({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedSourceLanguage: { type: Type.STRING },
            genre: { type: Type.STRING },
            narrativeVoice: { type: Type.STRING },
            register: { type: Type.STRING },
            tense: { type: Type.STRING },
            formality: { type: Type.STRING },
            rhythmNotes: { type: Type.STRING },
            culturalNotes: { type: Type.STRING },
            translatorGuidance: { type: Type.STRING },
            glossary: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  source: { type: Type.STRING },
                  target: { type: Type.STRING },
                  note: { type: Type.STRING },
                  keepAsIs: { type: Type.BOOLEAN },
                },
                required: ['source', 'target'],
              },
            },
          },
          required: [
            'detectedSourceLanguage',
            'genre',
            'narrativeVoice',
            'register',
            'tense',
            'formality',
            'rhythmNotes',
            'culturalNotes',
            'translatorGuidance',
            'glossary',
          ],
        },
      },
    });

    res.json(robustJsonParse(response.text ?? ''));
  } catch (error) {
    handleError(res, error, 'Failed to build the translation brief');
  }
});

/** Translates one segment, bound by the brief, the glossary and its neighbours. */
app.post('/api/translate/segment', async (req, res) => {
  try {
    const { blocks, startIndex = 0, targetLanguage, brief, glossary, context, authorNotes } = req.body ?? {};
    if (!Array.isArray(blocks) || blocks.length === 0 || !targetLanguage) {
      res.status(400).json({ error: '"blocks" and "targetLanguage" are required.' });
      return;
    }

    const typed = blocks as RichBlock[];
    const serialized = serializeBlocksForTranslation(typed, Number(startIndex) || 0);

    const prompt = `You are an award-winning literary translator working into ${targetLanguage}. You are translating a book that will be published and read by people who will never see the original. They must experience the book as literature written for them, not as a translation.

TRANSLATION BRIEF (binding):
${briefSummary(brief)}

GLOSSARY (binding — these renderings must be used exactly, every time):
${glossaryTable(glossary ?? [])}

${authorNotes ? `AUTHOR'S INSTRUCTIONS: ${authorNotes}\n` : ''}
TYPOGRAPHY: ${typographyFor(String(targetLanguage))}

${context?.precedingSource ? `THE PASSAGE IMMEDIATELY BEFORE THIS ONE, IN THE ORIGINAL:\n${String(context.precedingSource).slice(-1200)}\n` : ''}
${context?.precedingTarget ? `YOUR TRANSLATION OF THAT PASSAGE — continue its voice, vocabulary and flow exactly:\n${String(context.precedingTarget).slice(-1200)}\n` : ''}
${context?.followingSource ? `WHAT COMES AFTER THIS PASSAGE, IN THE ORIGINAL (for context only — do not translate it):\n${String(context.followingSource).slice(0, 600)}\n` : ''}

HOW TO TRANSLATE:
- Translate meaning, effect and voice — never word for word. If a literal rendering would sound foreign, rewrite it so a native reader feels what the original reader felt.
- Replace idioms with the idiom a ${targetLanguage} writer would actually use. Never calque an English expression.
- Let the syntax be ${targetLanguage} syntax. Reorder clauses freely; the original's word order carries no authority.
- Dialogue must sound like speech in ${targetLanguage}, with that language's contractions, hesitations and register — not translated English speech.
- Keep the author's rhythm: short sentences stay short, long ones keep their sweep, paragraph breaks stay where they are.
- Preserve deliberate ambiguity, understatement and humour. Do not explain, expand or add footnotes.
- Wordplay: recreate the effect in ${targetLanguage} even if the literal content must change.
- Numbers, units and dates: use the convention of the target readership.

OUTPUT FORMAT — follow exactly:
- Return one line per input line, with the same [number|type] tag at the start.
- Translate only the text after the tag.
- Keep <b> and <i> tags around the words they emphasise; move them if the target word order moves.
- Lines tagged [n|scene] must be returned unchanged as [n|scene].
- Do not merge, split, reorder, add or omit lines. Do not add commentary.

PASSAGE:
${serialized}`;

    const response = await generateContentWithRetry({ contents: prompt });
    const raw = (response.text ?? '').trim();
    const { blocks: translated, missing } = parseTranslatedBlocks(raw, typed, Number(startIndex) || 0);

    res.json({
      blocks: translated,
      missing,
      targetText: blocksToPlainText(translated),
      untranslatedCount: missing.length,
    });
  } catch (error) {
    handleError(res, error, 'Failed to translate the segment');
  }
});

/**
 * Second pass. The editor never sees the source, which is the point: without it
 * there is nothing to stay loyal to, so translationese has nowhere to hide.
 */
app.post('/api/translate/polish', async (req, res) => {
  try {
    const { blocks, targetLanguage, brief, glossary, startIndex = 0 } = req.body ?? {};
    if (!Array.isArray(blocks) || blocks.length === 0 || !targetLanguage) {
      res.status(400).json({ error: '"blocks" and "targetLanguage" are required.' });
      return;
    }

    const typed = blocks as RichBlock[];
    const serialized = serializeBlocksForTranslation(typed, Number(startIndex) || 0);

    const prompt = `You are a ${targetLanguage} literary editor at a serious publishing house. A novel is on your desk. You do not have any other version of it — this is simply a book in ${targetLanguage}, and your job is to make the prose excellent.

WHAT THE BOOK IS MEANT TO BE:
${briefSummary(brief)}

TERMS THAT MUST NOT CHANGE (names and fixed renderings):
${glossaryTable(glossary ?? [])}

TYPOGRAPHY: ${typographyFor(String(targetLanguage))}

EDIT FOR:
- Any sentence that reads as though it were carried over from another language: unnatural word order, borrowed idioms, prepositions that are not how ${targetLanguage} says it.
- Stiffness. Where a ${targetLanguage} writer would use a lighter construction, use it.
- Dialogue that no one would actually speak. Make it sound like a real person of that character's age, class and mood.
- Repetition the language does not need, and connectives that betray a foreign original.
- Punctuation and quotation that do not follow ${targetLanguage} book conventions.

DO NOT:
- Change what happens, who says it, or what it means.
- Add or remove sentences, imagery or information.
- Alter any glossary term, name or place.
- Modernise or sanitise the author's voice.

OUTPUT FORMAT — follow exactly:
- Return one line per input line, with the same [number|type] tag.
- Keep <b> and <i> tags on the words they emphasise.
- Lines tagged [n|scene] return unchanged.
- No commentary.

MANUSCRIPT:
${serialized}`;

    const response = await generateContentWithRetry({ contents: prompt });
    const { blocks: polished, missing } = parseTranslatedBlocks((response.text ?? '').trim(), typed, Number(startIndex) || 0);

    res.json({ blocks: polished, missing, targetText: blocksToPlainText(polished) });
  } catch (error) {
    handleError(res, error, 'Failed to polish the translation');
  }
});

/** Flags glossary terms that went missing, which is how consistency actually breaks. */
app.post('/api/translate/audit', async (req, res) => {
  try {
    const { blocks, sourceBlocks, glossary } = req.body ?? {};
    if (!Array.isArray(blocks)) {
      res.status(400).json({ error: '"blocks" is required.' });
      return;
    }

    const targetText = blocksToPlainText(blocks as RichBlock[]).toLowerCase();
    const sourceText = Array.isArray(sourceBlocks) ? blocksToPlainText(sourceBlocks as RichBlock[]).toLowerCase() : '';

    const issues = (glossary as GlossaryEntry[] | undefined ?? [])
      .filter((entry) => entry.source && sourceText.includes(entry.source.toLowerCase()))
      .filter((entry) => {
        const expected = (entry.keepAsIs ? entry.source : entry.target)?.toLowerCase();
        return expected ? !targetText.includes(expected) : false;
      })
      .map((entry) => ({
        source: entry.source,
        expected: entry.keepAsIs ? entry.source : entry.target,
        message: `"${entry.source}" appears in this passage but "${entry.keepAsIs ? entry.source : entry.target}" is not in the translation.`,
      }));

    res.json({ issues, checked: (glossary as GlossaryEntry[] | undefined ?? []).length });
  } catch (error) {
    handleError(res, error, 'Failed to audit the translation');
  }
});

/** Assembles finished blocks into a publishable file. */
app.post('/api/translate/export', async (req, res) => {
  try {
    const { blocks, format = 'docx', title, author, language } = req.body ?? {};
    if (!Array.isArray(blocks) || blocks.length === 0) {
      res.status(400).json({ error: 'There is nothing to export yet.' });
      return;
    }
    const typed = blocks as RichBlock[];
    const docTitle = String(title || 'Translated Manuscript');
    const safeName = docTitle.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '') || 'translation';

    switch (String(format).toLowerCase()) {
      case 'epub': {
        const epub = blocksToEpub(typed, docTitle, {
          author: author ? String(author) : undefined,
          language: language ? String(language) : undefined,
        });
        res.setHeader('X-Epub-Valid', String(validateEpubStructure(epub).valid));
        sendDocument(res, epub, `${safeName}.epub`, 'epub');
        return;
      }
      case 'pdf':
        sendDocument(res, await blocksToPdf(typed, docTitle), `${safeName}.pdf`, 'pdf');
        return;
      case 'txt':
        sendDocument(res, Buffer.from(blocksToPlainText(typed), 'utf8'), `${safeName}.txt`, 'txt');
        return;
      case 'docx':
      default:
        sendDocument(res, await blocksToDocx(typed, docTitle), `${safeName}.docx`, 'docx');
    }
  } catch (error) {
    handleError(res, error, 'Failed to export the translation');
  }
});

// ---------------------------------------------------------------------------
// API — Author Empire marketing tools
// ---------------------------------------------------------------------------

app.post('/api/author-empire/generate-titles', async (req, res) => {
  try {
    const { premise, genre, audience, tone, keywords, count = 8 } = req.body ?? {};
    const prompt = `You are a bestselling-title strategist for Amazon KDP.

Premise: ${premise || 'not provided'}
Genre: ${genre || 'unspecified'} | Audience: ${audience || 'general readers'} | Tone: ${tone || 'unspecified'}
Keywords to consider: ${Array.isArray(keywords) ? keywords.join(', ') : keywords || 'none'}

Produce ${Number(count) || 8} distinct title candidates. Vary the angles: benefit-driven, curiosity gap,
metaphorical, provocative, and category-classic. Titles must be under 60 characters and readable at thumbnail size.`;

    const response = await generateContentWithRetry({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            titles: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  subtitle: { type: Type.STRING },
                  angle: { type: Type.STRING },
                  rationale: { type: Type.STRING },
                  searchAppeal: { type: Type.INTEGER },
                },
                required: ['title', 'subtitle', 'angle', 'rationale', 'searchAppeal'],
              },
            },
          },
          required: ['titles'],
        },
      },
    });
    res.json(robustJsonParse(response.text ?? ''));
  } catch (error) {
    handleError(res, error, 'Failed to generate titles');
  }
});

app.post('/api/author-empire/generate-blurb', async (req, res) => {
  try {
    const { title, subtitle, premise, genre, audience, tone, comparableTitles } = req.body ?? {};
    const prompt = `You are a direct-response copywriter for book marketing.

Title: ${title || 'Untitled'}${subtitle ? ` — ${subtitle}` : ''}
Genre: ${genre || 'unspecified'} | Audience: ${audience || 'general readers'} | Tone: ${tone || 'unspecified'}
Premise: ${premise || 'not provided'}
Comparable titles: ${Array.isArray(comparableTitles) ? comparableTitles.join(', ') : comparableTitles || 'none supplied'}

Write a complete marketing package. The Amazon description must use short punchy paragraphs,
open with a hook line, and end with a call to action. Keywords must be real search phrases a
reader would type, not abstract themes.`;

    const response = await generateContentWithRetry({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tagline: { type: Type.STRING },
            elevatorPitch: { type: Type.STRING },
            backCoverBlurb: { type: Type.STRING },
            amazonDescription: { type: Type.STRING },
            keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            categories: { type: Type.ARRAY, items: { type: Type.STRING } },
            targetReader: { type: Type.STRING },
          },
          required: ['tagline', 'elevatorPitch', 'backCoverBlurb', 'amazonDescription', 'keywords', 'categories', 'targetReader'],
        },
      },
    });
    res.json(robustJsonParse(response.text ?? ''));
  } catch (error) {
    handleError(res, error, 'Failed to generate the blurb package');
  }
});

app.post('/api/author-empire/analyze-cover', upload.single('image'), async (req, res) => {
  try {
    const inlineBase64: string | undefined = req.file
      ? req.file.buffer.toString('base64')
      : typeof req.body?.imageBase64 === 'string'
        ? req.body.imageBase64.replace(/^data:[^;]+;base64,/, '')
        : undefined;

    if (!inlineBase64) {
      res.status(400).json({ error: 'Upload a cover image under "image" or send "imageBase64" in the body.' });
      return;
    }
    if (!geminiClient) throw new AiUnavailableError();

    const mimeType = req.file?.mimetype ?? String(req.body?.mimeType ?? 'image/png');
    const { title, genre, audience } = req.body ?? {};

    const instruction = `You are a book cover design director auditing a cover for Amazon KDP.

Book: ${title || 'unknown title'} | Genre: ${genre || 'unspecified'} | Audience: ${audience || 'general readers'}

Audit the attached cover for: genre signalling, thumbnail legibility at 160px, typography hierarchy,
colour contrast, focal clarity, and how it compares to category bestsellers. Score each 1-10 and be blunt
about what to change.`;

    const response = await generateContentWithRetry({
      contents: [
        {
          role: 'user',
          parts: [{ text: instruction }, { inlineData: { mimeType, data: inlineBase64 } }],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overallScore: { type: Type.INTEGER },
            genreSignalling: { type: Type.STRING },
            thumbnailLegibility: { type: Type.STRING },
            typography: { type: Type.STRING },
            colourAndContrast: { type: Type.STRING },
            focalClarity: { type: Type.STRING },
            strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
            fixes: { type: Type.ARRAY, items: { type: Type.STRING } },
combinedVerdict: { type: Type.STRING },
          },
          required: ['overallScore', 'genreSignalling', 'thumbnailLegibility', 'typography', 'colourAndContrast', 'focalClarity', 'strengths', 'fixes', 'combinedVerdict'],
        },
      },
    });
    res.json(robustJsonParse(response.text ?? ''));
  } catch (error) {
    handleError(res, error, 'Failed to analyze the cover');
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

app.use('/api', (error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({
      error:
        error.code === 'LIMIT_FILE_SIZE'
          ? `File is too large. The limit is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`
          : `Upload rejected: ${error.message}`,
    });
    return;
  }
  handleError(res, error, 'Unexpected server error');
});

// ---------------------------------------------------------------------------
// Server bootstrap (skipped on Vercel — the platform invokes `app` directly)
// ---------------------------------------------------------------------------

async function initServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BookForge listening on http://localhost:${PORT}`);
  });
}

// Vercel invokes the exported app directly; tests import the module for its
// pure conversion helpers and set BOOKFORGE_NO_LISTEN to keep the port free.
if (!process.env.VERCEL && !process.env.BOOKFORGE_NO_LISTEN) {
  initServer().catch((error) => {
    console.error('Server boot failed:', error);
    process.exitCode = 1;
  });
}
