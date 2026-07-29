/**
 * Persistence for the reader: per-book position, bookmarks and annotations,
 * plus global typography settings. Everything lives in localStorage and every
 * accessor degrades to a sane default when storage is unavailable.
 */

export type ReaderThemeId = 'paper' | 'sepia' | 'night' | 'black';
export type ReaderFontId = 'serif' | 'literary' | 'sans' | 'mono';
export type ReaderMode = 'paged' | 'scroll';
export type HighlightColor = 'yellow' | 'mint' | 'sky' | 'rose';

export interface ReaderSettings {
  theme: ReaderThemeId;
  font: ReaderFontId;
  fontSize: number;
  lineHeight: number;
  /** Text measure in characters — controls page/column width. */
  measure: number;
  justify: boolean;
  mode: ReaderMode;
  /** Words per minute used for "time left" estimates. */
  wpm: number;
}

export interface ReaderPosition {
  chapterIndex: number;
  paragraphIndex: number;
}

export interface Bookmark {
  id: string;
  chapterIndex: number;
  paragraphIndex: number;
  chapterTitle: string;
  excerpt: string;
  createdAt: number;
}

export interface Annotation {
  id: string;
  chapterIndex: number;
  paragraphIndex: number;
  start: number;
  end: number;
  text: string;
  color: HighlightColor;
  note: string;
  chapterTitle: string;
  createdAt: number;
}

export interface BookState {
  position: ReaderPosition;
  bookmarks: Bookmark[];
  annotations: Annotation[];
  /** Cumulative milliseconds spent reading this book. */
  msRead: number;
  updatedAt: number;
}

const SETTINGS_KEY = 'bookforge_reader_settings_v1';
const LIBRARY_KEY = 'bookforge_reader_library_v1';
const LEGACY_DARK_KEY = 'bookforge_reader_dark';

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'paper',
  font: 'serif',
  fontSize: 19,
  lineHeight: 1.65,
  measure: 42,
  justify: true,
  mode: 'paged',
  wpm: 230,
};

export const EMPTY_BOOK_STATE: BookState = {
  position: { chapterIndex: 0, paragraphIndex: 0 },
  bookmarks: [],
  annotations: [],
  msRead: 0,
  updatedAt: 0,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as object) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota exceeded — persistence is best-effort */
  }
}

export function loadSettings(): ReaderSettings {
  const stored = readJson<ReaderSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  // Honour the pre-2.1 dark-mode flag the first time around.
  try {
    if (!localStorage.getItem(SETTINGS_KEY) && localStorage.getItem(LEGACY_DARK_KEY) === 'true') {
      return { ...stored, theme: 'night' };
    }
  } catch {
    /* ignore */
  }
  return stored;
}

export function saveSettings(settings: ReaderSettings): void {
  writeJson(SETTINGS_KEY, settings);
}

type Library = Record<string, BookState>;

function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    return raw ? (JSON.parse(raw) as Library) : {};
  } catch {
    return {};
  }
}

export function bookKeyOf(title: string, author: string): string {
  return `${title.trim().toLowerCase()}::${author.trim().toLowerCase()}`;
}

export function loadBookState(bookKey: string): BookState {
  const library = loadLibrary();
  const stored = library[bookKey];
  return stored ? { ...EMPTY_BOOK_STATE, ...stored } : { ...EMPTY_BOOK_STATE };
}

export function saveBookState(bookKey: string, state: BookState): void {
  const library = loadLibrary();
  library[bookKey] = { ...state, updatedAt: Date.now() };

  // Keep the library bounded: retain the 25 most recently opened books.
  const keys = Object.keys(library);
  if (keys.length > 25) {
    keys
      .sort((a, b) => (library[b].updatedAt ?? 0) - (library[a].updatedAt ?? 0))
      .slice(25)
      .forEach((key) => delete library[key]);
  }
  writeJson(LIBRARY_KEY, library);
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
