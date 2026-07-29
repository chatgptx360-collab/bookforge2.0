import type { SectionType } from '../../types';

export interface BookReaderChapter {
  title: string;
  content: string;
  sectionType?: SectionType;
  chapterNumber?: number;
}

export type ParagraphKind = 'text' | 'scene' | 'meta';

export interface FlatParagraph {
  key: string;
  chapterIndex: number;
  paragraphIndex: number;
  text: string;
  kind: ParagraphKind;
  words: number;
  /** Words appearing before this paragraph in the whole book. */
  wordsBefore: number;
}

export interface ChapterMeta {
  index: number;
  title: string;
  sectionType: SectionType;
  chapterNumber?: number;
  words: number;
  wordsBefore: number;
  paragraphs: FlatParagraph[];
}

export interface BookModel {
  chapters: ChapterMeta[];
  paragraphs: FlatParagraph[];
  totalWords: number;
}

const SCENE_BREAK = /^(\*\s*\*\s*\*|\*{3,}|-{3,}|—{3,}|#{3}|❦)$/;

export function paragraphId(chapterIndex: number, paragraphIndex: number): string {
  return `p-${chapterIndex}-${paragraphIndex}`;
}

export function chapterId(chapterIndex: number): string {
  return `chapter-${chapterIndex}`;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Flattens chapters into an indexed paragraph model used for paging, progress and anchors. */
export function buildBookModel(chapters: BookReaderChapter[]): BookModel {
  const flat: FlatParagraph[] = [];
  const metas: ChapterMeta[] = [];
  let wordsBefore = 0;

  chapters.forEach((chapter, chapterIndex) => {
    const sectionType = chapter.sectionType ?? 'chapter';
    const isMeta = sectionType !== 'chapter';
    const chunks = chapter.content
      .split(/\n{2,}|\n(?=\s*(?:\*\s*\*\s*\*|\*{3,}|-{3,})\s*$)/)
      .flatMap((chunk) => (isMeta ? chunk.split('\n') : [chunk]))
      .map((chunk) => chunk.replace(/\s+$/g, '').replace(/^\s+/g, ''))
      .filter(Boolean);

    const chapterParagraphs: FlatParagraph[] = [];
    const chapterStart = wordsBefore;

    chunks.forEach((text, paragraphIndex) => {
      const kind: ParagraphKind = SCENE_BREAK.test(text.trim()) ? 'scene' : isMeta ? 'meta' : 'text';
      const words = kind === 'scene' ? 0 : countWords(text);
      const paragraph: FlatParagraph = {
        key: paragraphId(chapterIndex, paragraphIndex),
        chapterIndex,
        paragraphIndex,
        text,
        kind,
        words,
        wordsBefore,
      };
      wordsBefore += words;
      chapterParagraphs.push(paragraph);
      flat.push(paragraph);
    });

    metas.push({
      index: chapterIndex,
      title: chapter.title || `Section ${chapterIndex + 1}`,
      sectionType,
      chapterNumber: chapter.chapterNumber,
      words: wordsBefore - chapterStart,
      wordsBefore: chapterStart,
      paragraphs: chapterParagraphs,
    });
  });

  return { chapters: metas, paragraphs: flat, totalWords: wordsBefore };
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'less than a minute';
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export interface SearchHit {
  paragraph: FlatParagraph;
  before: string;
  match: string;
  after: string;
}

export function searchBook(model: BookModel, query: string, limit = 120): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const hits: SearchHit[] = [];
  for (const paragraph of model.paragraphs) {
    if (paragraph.kind === 'scene') continue;
    const haystack = paragraph.text.toLowerCase();
    let from = 0;
    while (hits.length < limit) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      hits.push({
        paragraph,
        before: paragraph.text.slice(Math.max(0, at - 48), at),
        match: paragraph.text.slice(at, at + needle.length),
        after: paragraph.text.slice(at + needle.length, at + needle.length + 64),
      });
      from = at + needle.length;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}
