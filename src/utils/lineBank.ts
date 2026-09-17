/**
 * Planning a bank of short clips.
 *
 * Games and apps that speak need hundreds of small recordings rather than one
 * long read: a line per event, a clip per player, a sentence split either side
 * of a name so the two can be joined. Doing that by hand means running the same
 * loop repeatedly and inventing the same file names each time, so the planning
 * lives here — pure, so it can be tested without a browser or a model.
 *
 * Nothing in this file makes audio. It decides what to say and what to call it.
 */

export type ClipKind = 'line' | 'entry' | 'fragment';

export interface BankClip {
  /** File name without extension. Stable, so a re-run overwrites rather than duplicates. */
  slug: string;
  /** The text handed to the engine. */
  say: string;
  /** What it is called in the index — the value as it appeared in the source. */
  display: string;
  kind: ClipKind;
  /** For fragments: which template it belongs to, and which half. */
  templateId?: string;
  half?: 'pre' | 'post';
}

export interface BankTemplate {
  id: string;
  /** The original text, placeholder included. */
  text: string;
  preSlug: string | null;
  postSlug: string | null;
}

export interface BankPlan {
  clips: BankClip[];
  templates: BankTemplate[];
  /** Source value -> slug, so callers look up what they already have. */
  index: Record<string, string>;
  /** Anything whose spoken form differs from its source value. */
  overridden: Record<string, string>;
}

/** Where an entry goes inside a template. */
export const SLOT = '{}';

/**
 * Surnames, the way a commentator says them.
 *
 * "van der Sar", not "Sar": a trailing particle belongs to the name. A
 * single-word value is left whole, because plenty of people are known by one.
 */
const PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'di', 'da', 'das', 'dos', 'del', 'della',
  'la', 'le', 'el', 'al', 'bin', 'ibn', 'mac', 'mc', 'st', 'ter', 'ten', 'op', 'av',
]);

/** Trailing generation markers: nobody commentates "Junior". */
const SUFFIXES = new Set(['jr', 'jnr', 'sr', 'snr', 'ii', 'iii', 'iv']);

export function lastNameOf(value: string): string {
  // Commas are separators in a written name, not part of it: "Rodriguez, Jr."
  const parts = value.trim().split(/\s+/).map((p) => p.replace(/,+$/, '')).filter(Boolean);
  while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1].toLowerCase().replace(/\.$/, ''))) {
    parts.pop();
  }
  if (parts.length <= 1) return parts[0] ?? value.trim();
  let start = parts.length - 1;
  while (start > 0 && PARTICLES.has(parts[start - 1].toLowerCase().replace(/\.$/, ''))) start--;
  return parts.slice(start).join(' ');
}

/**
 * Folds accents away.
 *
 * The phonemiser runs in English and does better with plain letters; an
 * override is the escape hatch when folding is not enough.
 */
export function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function slugify(value: string): string {
  const flat = fold(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return flat.replace(/^_+|_+$/g, '') || 'clip';
}

/**
 * Parses `Source = Spoken` lines into a lookup.
 *
 * This is how a name that comes out wrong gets fixed without touching code:
 * "Nice = Neece" and the clip is regenerated saying the right thing.
 */
export function parseOverrides(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at === -1) continue;
    const from = line.slice(0, at).trim();
    const to = line.slice(at + 1).trim();
    if (from && to) out[from] = to;
  }
  return out;
}

/** Reads one column out of CSV text, quoted fields included. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // an escaped quote
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const headers = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, '').trim());
  return { headers, rows: rows.filter((r) => r.some((c) => c.trim())) };
}

export function columnValues(csv: string, column: string): string[] {
  const { headers, rows } = parseCsv(csv);
  const at = headers.indexOf(column);
  if (at === -1) return [];
  return rows.map((r) => (r[at] ?? '').trim()).filter(Boolean);
}

export interface PlanOptions {
  /** Values to speak one clip each — names, clubs, anything listed. */
  entries?: string[];
  /** Whole sentences, spoken as given. */
  lines?: string[];
  /** Sentences containing SLOT, split into the halves either side of it. */
  templates?: string[];
  /** Speak the whole entry, or only its last name. */
  mode?: 'whole' | 'surname';
  overrides?: Record<string, string>;
}

/**
 * Works out every clip that needs making, once each.
 *
 * Deduplication is the point: two thousand players share a few hundred
 * surnames, and generating each one repeatedly would cost hours and produce
 * identical files.
 */
export function planBank(options: PlanOptions): BankPlan {
  const { entries = [], lines = [], templates = [], mode = 'whole', overrides = {} } = options;
  const clips = new Map<string, BankClip>();
  const index: Record<string, string> = {};
  const overridden: Record<string, string> = {};

  const add = (clip: BankClip) => {
    if (!clips.has(clip.slug)) clips.set(clip.slug, clip);
    if (clip.say !== clip.display) overridden[clip.display] = clip.say;
    return clip.slug;
  };

  for (const raw of entries) {
    const value = raw.trim();
    if (!value) continue;
    const spokenSource = mode === 'surname' ? lastNameOf(value) : value;
    // An override may be written against either the full value or the part
    // actually spoken, so both are honoured — the full value wins.
    const say = overrides[value] ?? overrides[spokenSource] ?? fold(spokenSource);
    index[value] = add({ slug: slugify(spokenSource), say, display: spokenSource, kind: 'entry' });
  }

  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (!text) return;
    const say = overrides[text] ?? text;
    add({ slug: `line_${String(i + 1).padStart(3, '0')}_${slugify(text).slice(0, 28)}`,
          say, display: text, kind: 'line' });
  });

  const built: BankTemplate[] = [];
  templates.forEach((raw, i) => {
    const text = raw.trim();
    if (!text || !text.includes(SLOT)) return;
    const id = `tpl_${String(i + 1).padStart(2, '0')}`;
    const [pre, post] = [text.slice(0, text.indexOf(SLOT)).trim(), text.slice(text.indexOf(SLOT) + SLOT.length).trim()];
    const half = (side: 'pre' | 'post', value: string) =>
      value ? add({ slug: `${id}_${side}`, say: overrides[value] ?? value, display: value, kind: 'fragment', templateId: id, half: side }) : null;
    built.push({ id, text, preSlug: half('pre', pre), postSlug: half('post', post) });
  });

  return { clips: [...clips.values()], templates: built, index, overridden };
}
