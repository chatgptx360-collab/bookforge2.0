/**
 * Manuscript audit.
 *
 * A store rejected a generated book with a list of reasons, and most of them
 * are measurable: duplication is exact, a dialogue pattern is countable, a
 * thin chapter is arithmetic. This finds those before an upload does.
 *
 * Deliberately rule-based, with no model behind it. The point of running on
 * every conversion is that the same manuscript always produces the same
 * report — a checker that drifts is worse than none, because it teaches people
 * to ignore it. Nothing here needs a key, costs anything, or leaves the server.
 *
 * The honest limit: "formulaic" and "generic" cannot be decided mechanically.
 * What can be counted are their symptoms, and those are reported with counts
 * and locations rather than dressed up as a verdict on the writing.
 */

export type AuditCategory =
  | 'duplication'
  | 'repetitive-dialogue'
  | 'formulaic'
  | 'thin-content'
  | 'ai-tells';

export interface AuditFinding {
  category: AuditCategory;
  /** One line, stating what was counted. */
  summary: string;
  severity: 'high' | 'medium' | 'low';
  count: number;
  /** Verbatim excerpts, so a claim can always be checked against the text. */
  examples: string[];
  /**
   * Whether "Fix errors" can resolve this without touching prose. Only exact
   * structural repetition qualifies; nothing that would require rewriting.
   */
  fixable: boolean;
}

export interface AuditReport {
  findings: AuditFinding[];
  stats: {
    words: number;
    chapters: number;
    /** Distinct words over total, a rough measure of vocabulary range. */
    vocabularyRatio: number;
    duplicateParagraphs: number;
  };
  fixableCount: number;
}

const normalise = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const words = (value: string) => value.split(/\s+/).filter(Boolean);

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** A contents entry: dot leaders, or a heading-ish line ending in a number. */
export function isTocEntry(line: string): boolean {
  return (
    /\.{3,}\s*\d+\s*$/.test(line) ||
    (/^\s*(chapter|part|section|book|prologue|epilogue|introduction)\b/i.test(line) && /\s\d+\s*$/.test(line))
  );
}

/** Lines that read as a chapter heading rather than prose. */
function isHeading(line: string): boolean {
  if (line.length > 90) return false;
  // A contents entry opens exactly like a heading and must not be counted as
  // one, or a typed contents list becomes a run of empty chapters.
  if (isTocEntry(line)) return false;
  return /^\s*(chapter|part|section|book|prologue|epilogue|introduction|foreword|preface|afterword)\b/i.test(line);
}

/**
 * Phrases that turn up far more often in unedited machine drafts than in
 * edited prose. Presence is not proof of anything; density is the signal, so
 * these are counted rather than flagged individually.
 */
const STOCK_PHRASES = [
  'a testament to', 'in the realm of', 'it is important to note', 'little did',
  'couldn’t help but', "couldn't help but", 'a mixture of', 'a mix of emotions',
  'sent a shiver', 'a chill ran', 'heart pounded', 'heart raced', 'breath caught',
  'little did he know', 'little did she know', 'in that moment', 'at that moment',
  'a wave of', 'washed over', 'the weight of', 'a stark reminder', 'served as a reminder',
  'delve into', 'navigate the complexities', 'tapestry of', 'testament of',
  'unwavering', 'palpable', 'a symphony of', 'echoed through',
];

/** Quoted speech, keeping the quotes off. */
function dialogueLines(text: string): string[] {
  return [...text.matchAll(/[“"]([^”"\n]{2,300})[”"]/g)].map((m) => m[1].trim()).filter(Boolean);
}

function topRepeats(values: string[], minimum: number): { value: string; count: number }[] {
  const tally = new Map<string, { value: string; count: number }>();
  for (const value of values) {
    const key = normalise(value);
    if (!key) continue;
    const entry = tally.get(key);
    if (entry) entry.count++;
    else tally.set(key, { value, count: 1 });
  }
  return [...tally.values()].filter((e) => e.count >= minimum).sort((a, b) => b.count - a.count);
}

function splitChapters(text: string): { title: string; body: string }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of lines) {
    if (isHeading(line.trim()) && line.trim().length < 90) {
      current = { title: line.trim(), body: [] };
      chapters.push(current);
      continue;
    }
    if (!current) {
      current = { title: 'Front matter', body: [] };
      chapters.push(current);
    }
    current.body.push(line);
  }
  return chapters.map((c) => ({ title: c.title, body: c.body.join('\n') }));
}

export function auditManuscript(text: string): AuditReport {
  const findings: AuditFinding[] = [];
  const paras = paragraphs(text);
  const allWords = words(text);
  const chapters = splitChapters(text);

  // --- duplication ---------------------------------------------------------
  // Exact repeats are unambiguous and are what a store notices first.
  const repeatedParas = topRepeats(paras.filter((p) => words(p).length >= 8), 2);
  if (repeatedParas.length > 0) {
    const total = repeatedParas.reduce((sum, entry) => sum + entry.count - 1, 0);
    findings.push({
      category: 'duplication',
      summary: `${total} duplicated paragraph${total === 1 ? ' appears' : 's appear'} more than once, word for word.`,
      severity: total > 3 ? 'high' : 'medium',
      count: total,
      examples: repeatedParas.slice(0, 3).map((e) => `${e.count}× “${e.value.slice(0, 110)}…”`),
      fixable: true,
    });
  }

  const headings = paras.filter((p) => isHeading(p) && p.split('\n').length === 1);
  const repeatedHeadings = topRepeats(headings, 2);
  if (repeatedHeadings.length > 0) {
    findings.push({
      category: 'duplication',
      summary: `${repeatedHeadings.length} chapter heading${repeatedHeadings.length === 1 ? ' appears' : 's appear'} more than once.`,
      severity: 'high',
      count: repeatedHeadings.length,
      examples: repeatedHeadings.slice(0, 4).map((e) => `${e.count}× “${e.value}”`),
      fixable: true,
    });
  }

  const tocLines = paras.flatMap((p) => p.split('\n')).filter((line) => isTocEntry(line.trim()));
  if (tocLines.length >= 2) {
    findings.push({
      category: 'duplication',
      summary: `A typed table of contents (${tocLines.length} entries) is inside the text. An EPUB carries its own, and printed page numbers mean nothing in a reflowable book.`,
      severity: 'high',
      count: tocLines.length,
      examples: tocLines.slice(0, 3).map((line) => line.trim()),
      fixable: true,
    });
  }

  // --- repetitive dialogue -------------------------------------------------
  const spoken = dialogueLines(text);
  const repeatedSpeech = topRepeats(spoken, 3);
  if (repeatedSpeech.length > 0) {
    const worst = repeatedSpeech[0];
    findings.push({
      category: 'repetitive-dialogue',
      summary: `The same line of dialogue is spoken ${worst.count} times, and ${repeatedSpeech.length} line${repeatedSpeech.length === 1 ? ' repeats' : 's repeat'} at least three times.`,
      severity: worst.count >= 6 ? 'high' : 'medium',
      count: repeatedSpeech.length,
      examples: repeatedSpeech.slice(0, 4).map((e) => `${e.count}× “${e.value.slice(0, 80)}”`),
      fixable: false,
    });
  }

  // Openings are where a pattern shows: every reply starting the same way.
  const openers = spoken.map((line) => words(line).slice(0, 2).join(' ')).filter((o) => o.length > 2);
  const repeatedOpeners = topRepeats(openers, Math.max(4, Math.ceil(spoken.length * 0.12)));
  if (spoken.length >= 12 && repeatedOpeners.length > 0) {
    findings.push({
      category: 'repetitive-dialogue',
      summary: `Dialogue keeps opening the same way — “${repeatedOpeners[0].value}” begins ${repeatedOpeners[0].count} of ${spoken.length} spoken lines.`,
      severity: repeatedOpeners[0].count > spoken.length * 0.2 ? 'high' : 'medium',
      count: repeatedOpeners.reduce((sum, e) => sum + e.count, 0),
      examples: repeatedOpeners.slice(0, 4).map((e) => `${e.count}× “${e.value}…”`),
      fixable: false,
    });
  }

  // --- formulaic prose -----------------------------------------------------
  const sentences = text.match(/[^.!?\n]+[.!?]+/g) ?? [];
  const sentenceOpeners = sentences.map((s) => words(s.trim()).slice(0, 2).join(' ')).filter((o) => o.length > 2);
  const repeatedSentenceOpeners = topRepeats(sentenceOpeners, Math.max(5, Math.ceil(sentences.length * 0.04)));
  if (sentences.length >= 40 && repeatedSentenceOpeners.length > 0) {
    findings.push({
      category: 'formulaic',
      summary: `Sentences start alike — “${repeatedSentenceOpeners[0].value}” opens ${repeatedSentenceOpeners[0].count} of ${sentences.length} sentences.`,
      severity: repeatedSentenceOpeners.length > 4 ? 'high' : 'medium',
      count: repeatedSentenceOpeners.length,
      examples: repeatedSentenceOpeners.slice(0, 5).map((e) => `${e.count}× “${e.value}…”`),
      fixable: false,
    });
  }

  // --- stock phrasing ------------------------------------------------------
  const lower = text.toLowerCase();
  const hits = STOCK_PHRASES.map((phrase) => ({
    phrase,
    count: lower.split(phrase).length - 1,
  })).filter((h) => h.count > 0);
  const stockTotal = hits.reduce((sum, h) => sum + h.count, 0);
  // Per ten thousand words, so length does not decide the verdict.
  const density = allWords.length > 0 ? (stockTotal / allWords.length) * 10000 : 0;
  if (stockTotal >= 3 && density >= 4) {
    findings.push({
      category: 'ai-tells',
      summary: `${stockTotal} stock phrases (${density.toFixed(1)} per 10,000 words) — the kind reviewers read as unedited machine drafting.`,
      severity: density >= 12 ? 'high' : 'medium',
      count: stockTotal,
      examples: hits.sort((a, b) => b.count - a.count).slice(0, 5).map((h) => `${h.count}× “${h.phrase}”`),
      fixable: false,
    });
  }

  // --- thin content --------------------------------------------------------
  const bodies = chapters.filter((c) => c.title !== 'Front matter').map((c) => words(c.body).length);
  if (bodies.length >= 3 && allWords.length >= 1500) {
    const sorted = [...bodies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) {
    const thin = bodies.filter((count) => count < Math.max(300, median * 0.35));
    if (thin.length > 0) {
      findings.push({
        category: 'thin-content',
        summary: `${thin.length} chapter${thin.length === 1 ? ' is' : 's are'} far shorter than the rest (median ${median} words).`,
        severity: thin.length > bodies.length / 3 ? 'high' : 'low',
        count: thin.length,
        examples: chapters
          .filter((c) => c.title !== 'Front matter' && words(c.body).length < Math.max(300, median * 0.35))
          .slice(0, 4)
          .map((c) => `${c.title} — ${words(c.body).length} words`),
        fixable: false,
        });
      }
    }
  }

  const distinct = new Set(allWords.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''))).size;
  const vocabularyRatio = allWords.length > 0 ? distinct / allWords.length : 0;
  // Below roughly a fifth, prose is circling the same words. Only meaningful
  // once there is enough text for the ratio to settle.
  if (allWords.length >= 2000 && vocabularyRatio < 0.2) {
    findings.push({
      category: 'thin-content',
      summary: `Narrow vocabulary — ${(vocabularyRatio * 100).toFixed(1)}% of words are distinct, which reads as repetition.`,
      severity: vocabularyRatio < 0.15 ? 'high' : 'low',
      count: Math.round(vocabularyRatio * 1000),
      examples: [],
      fixable: false,
    });
  }

  return {
    findings,
    stats: {
      words: allWords.length,
      chapters: bodies.length,
      vocabularyRatio,
      duplicateParagraphs: repeatedParas.reduce((sum, e) => sum + e.count - 1, 0),
    },
    fixableCount: findings.filter((f) => f.fixable).length,
  };
}

export interface FixResult {
  text: string;
  changes: string[];
}

/**
 * Applies only the fixes that remove exact repetition.
 *
 * Nothing here rewrites a sentence. Every change deletes something that
 * appears twice or that the EPUB provides for itself, so the prose that comes
 * out is a subset of the prose that went in — which is what makes the button
 * safe to press on a finished manuscript.
 */
export function applyMechanicalFixes(text: string): FixResult {
  const changes: string[] = [];
  const source = text.replace(/\r\n?/g, '\n');
  const paras = source.split(/\n{2,}/);

  const seen = new Set<string>();
  const kept: string[] = [];
  let removedParagraphs = 0;
  let removedHeadings = 0;
  let removedTocLines = 0;

  // Extractors differ on whether a contents list arrives as one paragraph or
  // one per line, so both shapes have to be handled. Removal is anchored to a
  // "Table of Contents" heading and stops at the first line that is not an
  // entry, which keeps a stray "Chapter 3 ... 5" inside the prose safe.
  let inContentsList = false;

  for (const paragraph of paras) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (/^(table of contents|contents)$/i.test(trimmed)) {
      removedTocLines += 1;
      inContentsList = true;
      continue;
    }

    const lines = trimmed.split('\n');
    const tocLines = lines.filter((line) => isTocEntry(line.trim()));

    if (inContentsList && tocLines.length === lines.length) {
      removedTocLines += tocLines.length;
      continue;
    }
    if (tocLines.length >= 2 && tocLines.length >= lines.length / 2) {
      // A contents list kept together as a single block.
      removedTocLines += tocLines.length;
      const remainder = lines.filter(
        (line) => !isTocEntry(line.trim()) && !/^(table of contents|contents)$/i.test(line.trim()),
      );
      if (remainder.join('').trim()) kept.push(remainder.join('\n'));
      continue;
    }
    inContentsList = false;

    const key = normalise(trimmed);
    const isShort = words(trimmed).length < 8;

    if (seen.has(key)) {
      // Short lines can legitimately repeat ("Yes." "He nodded."); long ones
      // and headings cannot.
      if (isHeading(trimmed)) {
        removedHeadings++;
        continue;
      }
      if (!isShort) {
        removedParagraphs++;
        continue;
      }
    }

    seen.add(key);
    kept.push(trimmed);
  }

  if (removedParagraphs) changes.push(`Removed ${removedParagraphs} duplicated paragraph${removedParagraphs === 1 ? '' : 's'}.`);
  if (removedHeadings) changes.push(`Removed ${removedHeadings} repeated chapter heading${removedHeadings === 1 ? '' : 's'}.`);
  if (removedTocLines) changes.push(`Removed a typed table of contents (${removedTocLines} line${removedTocLines === 1 ? '' : 's'}).`);

  return { text: kept.join('\n\n'), changes };
}
