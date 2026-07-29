import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bookmark as BookmarkIcon,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  Keyboard,
  List,
  Pause,
  Search,
  Settings2,
  Volume2,
  X,
} from 'lucide-react';
import {
  bookKeyOf,
  createId,
  loadBookState,
  loadSettings,
  saveBookState,
  saveSettings,
  type Annotation,
  type Bookmark,
  type BookState,
  type HighlightColor,
  type ReaderSettings,
} from '../utils/readerStore';
import BookContent from './reader/BookContent';
import { AnnotationsPanel, HighlightMenu, SearchPanel, SettingsPanel, TocPanel } from './reader/Panels';
import {
  buildBookModel,
  chapterId,
  formatDuration,
  paragraphId,
  searchBook,
  type BookReaderChapter,
  type ChapterMeta,
  type FlatParagraph,
} from './reader/content';
import { READER_THEMES } from './reader/theme';
import { loadVoices, pickDefaultVoice, planNarration } from './reader/narrator';

export type { BookReaderChapter };

export interface BookReaderProps {
  title: string;
  author: string;
  chapters: BookReaderChapter[];
  onClose?: () => void;
}

type PanelId = 'toc' | 'search' | 'notes' | 'settings';

interface SelectionState {
  x: number;
  y: number;
  chapterIndex: number;
  paragraphIndex: number;
  start: number;
  end: number;
  text: string;
}

const COLUMN_GAP = 56;
const VIEWPORT_PADDING_X = 28;
const SHORTCUTS: [string, string][] = [
  ['→ / Space', 'Next page'],
  ['←', 'Previous page'],
  ['T', 'Table of contents'],
  ['/', 'Search in book'],
  ['B', 'Bookmark this page'],
  ['N', 'Notes & highlights'],
  ['A', 'Read aloud'],
  [', ', 'Display settings'],
  ['+ / −', 'Text size'],
  ['F', 'Immersive mode'],
  ['?', 'This help'],
  ['Esc', 'Close panel or reader'],
];

export default function BookReader({ title, author, chapters, onClose }: BookReaderProps) {
  const model = useMemo(() => buildBookModel(chapters), [chapters]);
  const bookKey = useMemo(() => bookKeyOf(title, author), [title, author]);

  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings());
  const [book, setBook] = useState<BookState>(() => loadBookState(bookKey));
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [currentKey, setCurrentKey] = useState<string>(model.paragraphs[0]?.key ?? '');
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [lookup, setLookup] = useState<{ term: string; state: 'loading' | 'done' | 'error'; body: string } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageMapRef = useRef<Map<string, number>>(new Map());
  const restoredRef = useRef(false);
  const [metrics, setMetrics] = useState({ height: 0, columnWidth: 0, columnsPerPage: 1 });

  const theme = READER_THEMES[settings.theme];
  const paged = settings.mode === 'paged';
  /** Width of one visible spread — one column on narrow screens, two on wide ones. */
  const spreadWidth = metrics.columnWidth * metrics.columnsPerPage + COLUMN_GAP * (metrics.columnsPerPage - 1);
  const stride = (metrics.columnWidth + COLUMN_GAP) * metrics.columnsPerPage;

  const currentParagraph = useMemo(
    () => model.paragraphs.find((p) => p.key === currentKey) ?? model.paragraphs[0],
    [model, currentKey],
  );
  const currentChapter: ChapterMeta | undefined = model.chapters[currentParagraph?.chapterIndex ?? 0];

  const progress = model.totalWords > 0 ? (currentParagraph?.wordsBefore ?? 0) / model.totalWords : 0;
  const minutesLeftInBook = (model.totalWords - (currentParagraph?.wordsBefore ?? 0)) / settings.wpm;
  const minutesLeftInChapter = currentChapter
    ? (currentChapter.wordsBefore + currentChapter.words - (currentParagraph?.wordsBefore ?? 0)) / settings.wpm
    : 0;

  const bookmarkedKeys = useMemo(
    () => new Set(book.bookmarks.map((b) => paragraphId(b.chapterIndex, b.paragraphIndex))),
    [book.bookmarks],
  );
  const isPageBookmarked = currentKey ? bookmarkedKeys.has(currentKey) : false;
  const hits = useMemo(() => (panel === 'search' ? searchBook(model, query) : []), [panel, query, model]);
  // Hidden after the server reports no AI provider, so the menu stops offering it.
  const [lookupAvailable, setLookupAvailable] = useState(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadVoices().then((available) => {
      if (!cancelled) setVoices(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- persistence --------------------------------------------------------
  useEffect(() => saveSettings(settings), [settings]);

  useEffect(() => {
    setBook(loadBookState(bookKey));
    restoredRef.current = false;
  }, [bookKey]);

  useEffect(() => {
    const timer = setTimeout(() => saveBookState(bookKey, book), 400);
    return () => clearTimeout(timer);
  }, [bookKey, book]);

  const updateBook = useCallback((patch: Partial<BookState>) => setBook((prev) => ({ ...prev, ...patch })), []);
  const updateSettings = useCallback(
    (patch: Partial<ReaderSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );

  // ---- layout measurement -------------------------------------------------
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      const available = viewport.clientWidth - VIEWPORT_PADDING_X * 2;
      const height = viewport.clientHeight;
      const ideal = Math.max(280, settings.measure * settings.fontSize * 0.52);
      const columnWidth = Math.max(240, Math.round(Math.min(available, ideal)));
      // A two-page spread only when both columns fit comfortably side by side.
      const columnsPerPage =
        settings.mode === 'paged' && available >= columnWidth * 2 + COLUMN_GAP + 40 ? 2 : 1;
      setMetrics({ height, columnWidth, columnsPerPage });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [settings.measure, settings.fontSize, settings.mode]);

  // Recompute the paragraph → page map whenever layout inputs change.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || metrics.columnWidth === 0) return;

    const map = new Map<string, number>();
    const rafId = requestAnimationFrame(() => {
      const nodes = content.querySelectorAll<HTMLElement>('[data-paragraph]');
      nodes.forEach((node) => {
        const key = node.dataset.paragraph;
        if (!key) return;
        map.set(key, paged ? Math.max(0, Math.floor(node.offsetLeft / stride)) : 0);
      });
      pageMapRef.current = map;
      if (paged) {
        const columns = Math.round((content.scrollWidth + COLUMN_GAP) / (metrics.columnWidth + COLUMN_GAP));
        setTotalPages(Math.max(1, Math.ceil(columns / metrics.columnsPerPage)));
      } else {
        setTotalPages(1);
      }

      // Keep the reader anchored to the same paragraph across reflows.
      if (paged && currentKey) {
        const target = map.get(currentKey);
        if (target !== undefined) setPage(target);
      }
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, paged, stride, settings.fontSize, settings.lineHeight, settings.font, settings.justify, model]);

  // ---- position tracking --------------------------------------------------
  const firstParagraphOnPage = useCallback(
    (pageIndex: number): FlatParagraph | undefined =>
      model.paragraphs.find((p) => pageMapRef.current.get(p.key) === pageIndex),
    [model],
  );

  const topParagraphInScroll = useCallback((): FlatParagraph | undefined => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return undefined;
    const threshold = viewport.scrollTop + 24;
    let found: FlatParagraph | undefined;
    for (const paragraph of model.paragraphs) {
      const node = content.querySelector<HTMLElement>(`#${CSS.escape(paragraph.key)}`);
      if (!node) continue;
      if (node.offsetTop <= threshold) found = paragraph;
      else break;
    }
    return found ?? model.paragraphs[0];
  }, [model]);

  useEffect(() => {
    if (!paged) return;
    const paragraph = firstParagraphOnPage(page);
    if (paragraph) {
      setCurrentKey(paragraph.key);
      updateBook({ position: { chapterIndex: paragraph.chapterIndex, paragraphIndex: paragraph.paragraphIndex } });
    }
  }, [page, paged, firstParagraphOnPage, updateBook]);

  useEffect(() => {
    if (paged) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const paragraph = topParagraphInScroll();
        if (paragraph) {
          setCurrentKey(paragraph.key);
          updateBook({ position: { chapterIndex: paragraph.chapterIndex, paragraphIndex: paragraph.paragraphIndex } });
        }
        ticking = false;
      });
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [paged, topParagraphInScroll, updateBook]);

  // ---- navigation ---------------------------------------------------------
  const goToParagraph = useCallback(
    (key: string, flash = true) => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;

      if (paged) {
        const target = pageMapRef.current.get(key);
        if (target !== undefined) setPage(target);
      } else {
        const node = content.querySelector<HTMLElement>(`#${CSS.escape(key)}`);
        if (node) viewport.scrollTo({ top: Math.max(0, node.offsetTop - 24), behavior: 'smooth' });
      }
      setCurrentKey(key);
      if (flash) {
        setFlashKey(key);
        setTimeout(() => setFlashKey(null), 1400);
      }
    },
    [paged],
  );

  const goToChapter = useCallback(
    (chapter: ChapterMeta) => {
      const first = chapter.paragraphs[0];
      if (!first) return;
      if (paged) {
        const content = contentRef.current;
        const heading = content?.querySelector<HTMLElement>(`#${CSS.escape(chapterId(chapter.index))}`);
        if (heading) {
          setPage(Math.max(0, Math.floor(heading.offsetLeft / stride)));
          setCurrentKey(first.key);
          return;
        }
      }
      goToParagraph(first.key, false);
    },
    [goToParagraph, paged, stride],
  );

  const turnPage = useCallback(
    (delta: number) => {
      if (paged) {
        setPage((prev) => Math.min(Math.max(prev + delta, 0), Math.max(0, totalPages - 1)));
      } else {
        viewportRef.current?.scrollBy({ top: delta * (metrics.height - 80), behavior: 'smooth' });
      }
    },
    [paged, totalPages, metrics.height],
  );

  // Restore the saved position once the page map exists.
  useEffect(() => {
    if (restoredRef.current || pageMapRef.current.size === 0) return;
    restoredRef.current = true;
    const key = paragraphId(book.position.chapterIndex, book.position.paragraphIndex);
    if (pageMapRef.current.has(key) && (book.position.chapterIndex > 0 || book.position.paragraphIndex > 0)) {
      goToParagraph(key, false);
    }
  }, [book.position, goToParagraph, metrics]);

  // ---- bookmarks & annotations -------------------------------------------
  const toggleBookmark = useCallback(() => {
    if (!currentParagraph) return;
    const key = currentParagraph.key;
    const existing = book.bookmarks.find(
      (b) => paragraphId(b.chapterIndex, b.paragraphIndex) === key,
    );
    if (existing) {
      updateBook({ bookmarks: book.bookmarks.filter((b) => b.id !== existing.id) });
      return;
    }
    const bookmark: Bookmark = {
      id: createId('bm'),
      chapterIndex: currentParagraph.chapterIndex,
      paragraphIndex: currentParagraph.paragraphIndex,
      chapterTitle: currentChapter?.title ?? 'Section',
      excerpt: currentParagraph.text.slice(0, 90),
      createdAt: Date.now(),
    };
    updateBook({ bookmarks: [bookmark, ...book.bookmarks] });
  }, [book.bookmarks, currentChapter, currentParagraph, updateBook]);

  const captureSelection = useCallback(() => {
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = domSelection.getRangeAt(0);
    const text = domSelection.toString().trim();
    if (!text) {
      setSelection(null);
      return;
    }

    const anchor = (range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement
    )?.closest<HTMLElement>('[data-paragraph]');
    const focus = (range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as HTMLElement)
      : range.endContainer.parentElement
    )?.closest<HTMLElement>('[data-paragraph]');

    // Anchoring is per paragraph, so ignore selections spanning several.
    if (!anchor || !focus || anchor !== focus) {
      setSelection(null);
      return;
    }
    const key = anchor.dataset.paragraph;
    const paragraph = model.paragraphs.find((p) => p.key === key);
    if (!paragraph) {
      setSelection(null);
      return;
    }

    const prefix = range.cloneRange();
    prefix.selectNodeContents(anchor);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;

    const rect = range.getBoundingClientRect();
    setSelection({
      x: rect.left + rect.width / 2 - 110,
      y: Math.max(8, rect.top - 46),
      chapterIndex: paragraph.chapterIndex,
      paragraphIndex: paragraph.paragraphIndex,
      start,
      end: start + domSelection.toString().length,
      text,
    });
  }, [model]);

  const addHighlight = useCallback(
    (color: HighlightColor) => {
      if (!selection) return;
      const annotation: Annotation = {
        id: createId('hl'),
        chapterIndex: selection.chapterIndex,
        paragraphIndex: selection.paragraphIndex,
        start: selection.start,
        end: selection.end,
        text: selection.text,
        color,
        note: '',
        chapterTitle: model.chapters[selection.chapterIndex]?.title ?? 'Section',
        createdAt: Date.now(),
      };
      updateBook({ annotations: [annotation, ...book.annotations] });
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    },
    [book.annotations, model.chapters, selection, updateBook],
  );

  const runLookup = useCallback(async () => {
    if (!selection) return;
    const term = selection.text.slice(0, 240);
    const context = model.paragraphs.find(
      (p) => p.chapterIndex === selection.chapterIndex && p.paragraphIndex === selection.paragraphIndex,
    )?.text;
    setSelection(null);
    setLookup({ term, state: 'loading', body: '' });
    try {
      const response = await fetch('/api/book/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: term, context: context?.slice(0, 600), bookTitle: title }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 503) setLookupAvailable(false);
      if (!response.ok) throw new Error(payload.error || 'Lookup is unavailable.');
      setLookup({ term, state: 'done', body: String(payload.explanation ?? '') });
    } catch (error) {
      setLookup({ term, state: 'error', body: error instanceof Error ? error.message : 'Lookup failed.' });
    }
  }, [model.paragraphs, selection, title]);

  // ---- read aloud ---------------------------------------------------------
  const speakingRef = useRef(false);
  const stopSpeaking = useCallback(() => {
    speakingRef.current = false;
    setSpeakingKey(null);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const startSpeaking = useCallback(() => {
    if (!('speechSynthesis' in window) || !currentParagraph) return;
    speakingRef.current = true;
    window.speechSynthesis.cancel();

    const remaining = model.paragraphs.filter((p) => p.wordsBefore >= currentParagraph.wordsBefore);
    const plan = planNarration(remaining, settings);
    const voice =
      voices.find((candidate) => candidate.voiceURI === settings.voiceURI) ??
      pickDefaultVoice(voices, navigator.language || 'en');

    const speakAt = (index: number) => {
      if (!speakingRef.current || index >= plan.length) {
        stopSpeaking();
        return;
      }
      const chunk = plan[index];
      setSpeakingKey(chunk.paragraphKey);

      // Keep the page in step with the voice.
      const targetPage = pageMapRef.current.get(chunk.paragraphKey);
      if (paged && targetPage !== undefined) setPage(targetPage);
      else if (!paged) {
        const node = contentRef.current?.querySelector<HTMLElement>(`#${CSS.escape(chunk.paragraphKey)}`);
        if (node) viewportRef.current?.scrollTo({ top: Math.max(0, node.offsetTop - 24), behavior: 'smooth' });
      }

      const utterance = new SpeechSynthesisUtterance(chunk.text);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = chunk.rate;
      utterance.pitch = chunk.pitch;
      utterance.onend = () => {
        if (!speakingRef.current) return;
        if (chunk.pauseAfter > 0) window.setTimeout(() => speakAt(index + 1), chunk.pauseAfter);
        else speakAt(index + 1);
      };
      utterance.onerror = () => stopSpeaking();
      window.speechSynthesis.speak(utterance);
    };

    speakAt(0);
  }, [currentParagraph, model.paragraphs, paged, settings, stopSpeaking, voices]);

  useEffect(() => () => stopSpeaking(), [stopSpeaking]);

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        if (event.key === 'Escape') target.blur();
        return;
      }

      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          turnPage(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault();
          turnPage(-1);
          break;
        case 't':
          setPanel((prev) => (prev === 'toc' ? null : 'toc'));
          break;
        case '/':
          event.preventDefault();
          setPanel('search');
          break;
        case 'n':
          setPanel((prev) => (prev === 'notes' ? null : 'notes'));
          break;
        case ',':
          setPanel((prev) => (prev === 'settings' ? null : 'settings'));
          break;
        case 'b':
          toggleBookmark();
          break;
        case 'a':
          speakingRef.current ? stopSpeaking() : startSpeaking();
          break;
        case 'f':
          setImmersive((prev) => !prev);
          break;
        case '?':
          setShowShortcuts((prev) => !prev);
          break;
        case '+':
        case '=':
          updateSettings({ fontSize: Math.min(30, settings.fontSize + 1) });
          break;
        case '-':
          updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) });
          break;
        case 'Escape':
          if (showShortcuts) setShowShortcuts(false);
          else if (lookup) setLookup(null);
          else if (panel) setPanel(null);
          else if (immersive) setImmersive(false);
          else onClose?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    immersive,
    lookup,
    onClose,
    panel,
    settings.fontSize,
    showShortcuts,
    startSpeaking,
    stopSpeaking,
    toggleBookmark,
    turnPage,
    updateSettings,
  ]);

  // ---- render -------------------------------------------------------------
  const chromeVisible = !immersive;
  const iconButton = (active = false): React.CSSProperties => ({
    padding: 7,
    borderRadius: 8,
    cursor: 'pointer',
    background: active ? theme.selection : 'transparent',
    color: active ? theme.accent : theme.chromeText,
    border: 'none',
    lineHeight: 0,
  });

  return (
    <div
      className={`flex flex-col h-full ${onClose ? 'fixed inset-0 z-50' : ''}`}
      style={{ background: theme.canvas, color: theme.text }}
    >
      <style>{`
        .reader-paragraph::selection, .reader-paragraph *::selection { background: ${theme.selection}; }
        @media (prefers-reduced-motion: reduce) { .reader-pages { transition: none !important; } }
      `}</style>

      {chromeVisible && (
        <header
          className="flex items-center justify-between px-3 sm:px-5 shrink-0 select-none"
          style={{ height: 46, background: theme.chrome, borderBottom: `1px solid ${theme.rule}` }}
        >
          <div className="flex items-center gap-1 min-w-0">
            {onClose && (
              <button type="button" onClick={onClose} style={iconButton()} title="Close reader (Esc)">
                <ChevronLeft size={16} />
              </button>
            )}
            <BookOpen size={14} style={{ color: theme.accent, margin: '0 6px' }} />
            <div className="min-w-0">
              <div
                className="truncate"
                style={{ fontSize: 12, fontWeight: 600, color: theme.chromeText, maxWidth: 260 }}
              >
                {title}
              </div>
              <div className="truncate" style={{ fontSize: 10, color: theme.muted, maxWidth: 260 }}>
                {currentChapter?.title ?? author}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'toc' ? null : 'toc'))}
              style={iconButton(panel === 'toc')}
              title="Contents (T)"
            >
              <List size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'search' ? null : 'search'))}
              style={iconButton(panel === 'search')}
              title="Search (/)"
            >
              <Search size={16} />
            </button>
            <button type="button" onClick={toggleBookmark} style={iconButton(isPageBookmarked)} title="Bookmark (B)">
              <BookmarkIcon size={16} fill={isPageBookmarked ? theme.accent : 'none'} />
            </button>
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'notes' ? null : 'notes'))}
              style={iconButton(panel === 'notes')}
              title="Notes & highlights (N)"
            >
              <Highlighter size={16} />
            </button>
            <button
              type="button"
              onClick={() => (speakingKey ? stopSpeaking() : startSpeaking())}
              style={iconButton(Boolean(speakingKey))}
              title="Read aloud (A)"
            >
              {speakingKey ? <Pause size={16} /> : <Volume2 size={16} />}
            </button>
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}
              style={iconButton(panel === 'settings')}
              title="Display settings (,)"
            >
              <Settings2 size={16} />
            </button>
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              style={iconButton(false)}
              title="Keyboard shortcuts (?)"
              className="hidden sm:block"
            >
              <Keyboard size={16} />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 flex min-h-0 relative">
        <div
          ref={viewportRef}
          className={`flex-1 min-w-0 relative flex justify-center ${paged ? 'overflow-hidden' : 'overflow-y-auto'}`}
          style={{
            background: theme.page,
            padding: `${paged ? 26 : 40}px ${VIEWPORT_PADDING_X}px`,
            // The app shell sets `select-none`; prose must always be selectable
            // so highlighting and copy work.
            userSelect: 'text',
            WebkitUserSelect: 'text',
          }}
          onMouseUp={captureSelection}
          onTouchEnd={captureSelection}
        >
          {/* Clipping box sized to exactly one spread, so neighbouring
              columns never bleed into the margins. */}
          <div
            style={{
              width: paged ? spreadWidth : metrics.columnWidth,
              maxWidth: '100%',
              height: paged ? '100%' : undefined,
              overflow: paged ? 'hidden' : undefined,
              position: 'relative',
              flexShrink: 0,
            }}
          >
            <div
              ref={contentRef}
              className="reader-pages"
              style={
                paged
                  ? {
                      position: 'relative',
                      height: '100%',
                      columnWidth: `${metrics.columnWidth}px`,
                      columnGap: `${COLUMN_GAP}px`,
                      columnFill: 'auto',
                      transform: `translateX(-${page * stride}px)`,
                      transition: 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)',
                      willChange: 'transform',
                    }
                  : { position: 'relative' }
              }
            >
              <BookContent
                model={model}
                settings={settings}
                theme={theme}
                annotations={book.annotations}
                bookmarkedKeys={bookmarkedKeys}
                speakingKey={speakingKey}
                flashKey={flashKey}
                title={title}
                author={author}
              />
            </div>
          </div>

          {paged && (
            <>
              <button
                type="button"
                aria-label="Previous page"
                onClick={() => turnPage(-1)}
                className="absolute inset-y-0 left-0 cursor-w-resize opacity-0 hover:opacity-100 transition"
                style={{ width: '18%', background: 'transparent', border: 'none' }}
              />
              <button
                type="button"
                aria-label="Next page"
                onClick={() => turnPage(1)}
                className="absolute inset-y-0 right-0 cursor-e-resize opacity-0 hover:opacity-100 transition"
                style={{ width: '18%', background: 'transparent', border: 'none' }}
              />
            </>
          )}
        </div>

        {panel && (
          <aside
            className="shrink-0 flex flex-col"
            style={{
              width: 320,
              maxWidth: '85vw',
              background: theme.chrome,
              borderLeft: `1px solid ${theme.rule}`,
            }}
          >
            <div
              className="flex items-center justify-between px-3 py-2 shrink-0"
              style={{ borderBottom: `1px solid ${theme.rule}` }}
            >
              <div className="flex gap-1">
                {(
                  [
                    ['toc', 'Contents'],
                    ['search', 'Search'],
                    ['notes', 'Notes'],
                    ['settings', 'Display'],
                  ] as [PanelId, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPanel(id)}
                    className="px-2 py-1 rounded cursor-pointer transition"
                    style={{
                      fontSize: 11,
                      fontWeight: panel === id ? 600 : 400,
                      color: panel === id ? theme.accent : theme.muted,
                      background: panel === id ? theme.selection : 'transparent',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setPanel(null)} style={iconButton()} title="Close panel">
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 min-h-0">
              {panel === 'toc' && (
                <div className="h-full overflow-y-auto">
                  <TocPanel
                    model={model}
                    currentChapter={currentParagraph?.chapterIndex ?? 0}
                    settings={settings}
                    theme={theme}
                    onJump={(chapter) => goToChapter(chapter)}
                  />
                </div>
              )}
              {panel === 'search' && (
                <SearchPanel
                  query={query}
                  onQueryChange={setQuery}
                  hits={hits}
                  theme={theme}
                  onJump={(paragraph) => goToParagraph(paragraph.key)}
                />
              )}
              {panel === 'notes' && (
                <AnnotationsPanel
                  bookmarks={book.bookmarks}
                  annotations={book.annotations}
                  theme={theme}
                  onJumpBookmark={(bookmark) =>
                    goToParagraph(paragraphId(bookmark.chapterIndex, bookmark.paragraphIndex))
                  }
                  onRemoveBookmark={(id) => updateBook({ bookmarks: book.bookmarks.filter((b) => b.id !== id) })}
                  onJumpAnnotation={(annotation) =>
                    goToParagraph(paragraphId(annotation.chapterIndex, annotation.paragraphIndex))
                  }
                  onRemoveAnnotation={(id) =>
                    updateBook({ annotations: book.annotations.filter((a) => a.id !== id) })
                  }
                  onNoteChange={(id, note) =>
                    updateBook({
                      annotations: book.annotations.map((a) => (a.id === id ? { ...a, note } : a)),
                    })
                  }
                />
              )}
              {panel === 'settings' && (
                <SettingsPanel settings={settings} theme={theme} onChange={updateSettings} voices={voices} />
              )}
            </div>
          </aside>
        )}
      </div>

      {chromeVisible && (
        <footer
          className="shrink-0 select-none"
          style={{ background: theme.chrome, borderTop: `1px solid ${theme.rule}` }}
        >
          <div className="relative" style={{ height: 3, background: theme.rule }}>
            <div style={{ width: `${progress * 100}%`, height: '100%', background: theme.accent }} />
            {model.chapters.map((chapter) => (
              <span
                key={chapter.index}
                className="absolute top-0"
                style={{
                  left: `${model.totalWords ? (chapter.wordsBefore / model.totalWords) * 100 : 0}%`,
                  width: 1,
                  height: '100%',
                  background: theme.canvas,
                }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between px-3 sm:px-5" style={{ height: 32 }}>
            <span style={{ fontSize: 10.5, color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(progress * 100)}% · {formatDuration(minutesLeftInChapter)} left in chapter
            </span>
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline" style={{ fontSize: 10.5, color: theme.muted }}>
                {formatDuration(minutesLeftInBook)} left in book
              </span>
              {paged && (
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => turnPage(-1)} style={iconButton()} title="Previous page (←)">
                    <ChevronLeft size={14} />
                  </button>
                  <span
                    style={{ fontSize: 10.5, color: theme.muted, fontVariantNumeric: 'tabular-nums', minWidth: 74, textAlign: 'center' }}
                  >
                    Page {page + 1} of {totalPages}
                  </span>
                  <button type="button" onClick={() => turnPage(1)} style={iconButton()} title="Next page (→)">
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </footer>
      )}

      {selection && (
        <HighlightMenu
          x={selection.x}
          y={selection.y}
          theme={theme}
          hasLookup={lookupAvailable}
          onHighlight={addHighlight}
          onLookup={runLookup}
          onCopy={() => {
            navigator.clipboard?.writeText(selection.text).catch(() => undefined);
            setSelection(null);
          }}
          onDismiss={() => {
            window.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
        />
      )}

      {lookup && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}>
          <div
            className="w-full max-w-md rounded-2xl p-5 shadow-2xl"
            style={{ background: theme.chrome, border: `1px solid ${theme.rule}` }}
          >
            <div className="flex items-start justify-between gap-4">
              <h3 style={{ fontSize: 15, fontWeight: 600, color: theme.chromeText }}>“{lookup.term}”</h3>
              <button type="button" onClick={() => setLookup(null)} style={iconButton()} title="Close">
                <X size={15} />
              </button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, color: theme.muted, marginTop: 12, whiteSpace: 'pre-wrap' }}>
              {lookup.state === 'loading' ? 'Looking it up…' : lookup.body}
            </div>
          </div>
        </div>
      )}

      {showShortcuts && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setShowShortcuts(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-5 shadow-2xl"
            style={{ background: theme.chrome, border: `1px solid ${theme.rule}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 14, fontWeight: 600, color: theme.chromeText, marginBottom: 12 }}>
              Keyboard shortcuts
            </h3>
            <dl className="space-y-1.5">
              {SHORTCUTS.map(([keys, description]) => (
                <div key={keys} className="flex items-center justify-between gap-4">
                  <dt style={{ fontSize: 12, color: theme.muted }}>{description}</dt>
                  <dd
                    style={{
                      fontSize: 11,
                      fontFamily: 'ui-monospace, monospace',
                      color: theme.chromeText,
                      background: theme.canvas,
                      border: `1px solid ${theme.rule}`,
                      borderRadius: 5,
                      padding: '2px 7px',
                    }}
                  >
                    {keys.trim()}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {immersive && (
        <button
          type="button"
          onClick={() => setImmersive(false)}
          className="fixed bottom-4 right-4 z-[60] rounded-full px-3 py-2 shadow-lg cursor-pointer"
          style={{ background: theme.chrome, border: `1px solid ${theme.rule}`, fontSize: 11, color: theme.muted }}
        >
          Exit immersive (F)
        </button>
      )}
    </div>
  );
}
