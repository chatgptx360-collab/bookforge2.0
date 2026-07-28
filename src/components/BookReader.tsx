import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, BookOpen, Moon, Sun } from 'lucide-react';
import type { SectionType } from '../types';

export interface BookReaderChapter {
  title: string;
  content: string;
  sectionType?: SectionType;
  chapterNumber?: number;
}

export interface BookReaderProps {
  title: string;
  author: string;
  chapters: BookReaderChapter[];
  onClose?: () => void;
}

const BOOKMARK_KEY = 'bookforge_bookmarks';
const DARK_MODE_KEY = 'bookforge_reader_dark';

function getBookmarks(): Record<string, number> {
  try {
    const raw = localStorage.getItem(BOOKMARK_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveBookmark(bookKey: string, position: number) {
  try {
    const bookmarks = getBookmarks();
    bookmarks[bookKey] = position;
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarks));
  } catch {
    /* storage unavailable (private mode / quota) — bookmarking is best-effort */
  }
}

function getBookKey(title: string, author: string): string {
  return `${title}::${author}`;
}

const THEMES = {
  light: {
    bg: '#E8E2D6',
    paper: '#FDFBF7',
    text: '#2C2C2C',
    muted: '#8B8680',
    border: '#D5CFC5',
    subtleBorder: '#E8E4DC',
    chapterColor: '#8B8680',
    sceneBreak: '#C5BFB5',
  },
  dark: {
    bg: '#121212',
    paper: '#1E1E1E',
    text: '#D4D4D4',
    muted: '#8A8A8A',
    border: '#333333',
    subtleBorder: '#2A2A2A',
    chapterColor: '#999999',
    sceneBreak: '#555555',
  },
};

const SCENE_BREAK = /^(\*\s*\*\s*\*|\*\*\*|---|—{3,}|#{3})$/;
const serifFont: React.CSSProperties = { fontFamily: "Georgia, 'Times New Roman', serif" };

export default function BookReader({ title, author, chapters, onClose }: BookReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem(DARK_MODE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const bookKey = getBookKey(title, author);
  const theme = darkMode ? THEMES.dark : THEMES.light;

  // Pre-split every chapter once so scene-break detection is not O(n²) per render.
  const renderedChapters = useMemo(
    () =>
      chapters.map((chapter) => ({
        ...chapter,
        paragraphs: chapter.content.split(/\n+/).filter((p) => p.trim() !== ''),
        lines: chapter.content.split('\n').filter((l) => l.trim() !== ''),
      })),
    [chapters],
  );

  // Restore the saved scroll offset for this book.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = getBookmarks()[bookKey];
    if (saved) {
      requestAnimationFrame(() => {
        el.scrollTop = saved;
      });
    }
  }, [bookKey]);

  const savePosition = useCallback(() => {
    const el = scrollRef.current;
    if (el) saveBookmark(bookKey, el.scrollTop);
  }, [bookKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        savePosition();
        ticking = false;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      savePosition();
    };
  }, [savePosition]);

  // Escape closes fullscreen reading mode.
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleDark = () =>
    setDarkMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DARK_MODE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  return (
    <div
      className={`flex flex-col h-full ${onClose ? 'fixed inset-0 z-50' : ''}`}
      style={{ background: theme.bg }}
    >
      {onClose && (
        <div
          className="flex items-center justify-between px-6 shrink-0 select-none"
          style={{
            height: 44,
            background: darkMode ? '#1A1A1A' : '#18160F',
            borderBottom: `1px solid ${darkMode ? '#333' : '#2A2520'}`,
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <BookOpen size={15} style={{ color: '#C4B998' }} />
            <span className="font-semibold truncate max-w-[280px]" style={{ fontSize: 12, color: '#C4B998CC' }}>
              {title}
            </span>
            <span style={{ fontSize: 10, color: '#C4B99866', fontFamily: 'monospace' }}>{author}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleDark}
              className="p-1.5 rounded transition cursor-pointer"
              style={{ color: '#C4B99899', background: 'none', border: 'none' }}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded transition cursor-pointer"
              style={{ color: '#C4B99899', background: 'none', border: 'none' }}
              title="Close (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {!onClose && (
        <div className="flex justify-end px-6 pt-4 shrink-0">
          <button
            type="button"
            onClick={toggleDark}
            className="p-1.5 rounded transition cursor-pointer"
            style={{ color: theme.muted, background: 'none', border: `1px solid ${theme.border}` }}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ background: theme.bg }}>
        <div
          className="max-w-3xl mx-auto my-10 py-16 px-6 sm:px-14 shadow-sm"
          style={{ background: theme.paper, border: `1px solid ${theme.border}` }}
        >
          {renderedChapters.map((chapter, idx) => {
            const sectionType = chapter.sectionType ?? 'chapter';

            if (sectionType === 'title') {
              return (
                <div
                  key={idx}
                  className="text-center pb-20 mb-16"
                  style={{ borderBottom: `1px solid ${theme.border}` }}
                >
                  <h1
                    className="mb-4"
                    style={{ ...serifFont, fontSize: 36, fontWeight: 700, color: theme.text, letterSpacing: '-0.01em' }}
                  >
                    {chapter.lines[0] || title}
                  </h1>
                  {chapter.lines.slice(1).map((line, li) => (
                    <p
                      key={li}
                      style={{ ...serifFont, fontSize: 16, color: theme.muted, fontStyle: 'italic', marginTop: '0.5em' }}
                    >
                      {line}
                    </p>
                  ))}
                </div>
              );
            }

            if (sectionType === 'copyright') {
              return (
                <div
                  key={idx}
                  className="text-center pb-16 mb-12"
                  style={{ borderBottom: `1px solid ${theme.subtleBorder}` }}
                >
                  {chapter.lines.map((line, li) => (
                    <p key={li} style={{ ...serifFont, fontSize: 12, lineHeight: 1.8, color: theme.muted }}>
                      {line}
                    </p>
                  ))}
                </div>
              );
            }

            if (sectionType === 'toc') {
              return (
                <div key={idx} className="pb-16 mb-12" style={{ borderBottom: `1px solid ${theme.subtleBorder}` }}>
                  <h2
                    className="text-center mb-8"
                    style={{
                      ...serifFont,
                      fontSize: 14,
                      fontWeight: 700,
                      color: theme.chapterColor,
                      letterSpacing: '0.15em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Contents
                  </h2>
                  <div className="space-y-1.5 max-w-md mx-auto">
                    {chapter.lines.map((line, li) => (
                      <p
                        key={li}
                        style={{
                          ...serifFont,
                          fontSize: 13,
                          color: theme.text,
                          textAlign: 'center',
                          letterSpacing: '0.03em',
                        }}
                      >
                        {line.replace(/\.{3,}.*$/, '').trim()}
                      </p>
                    ))}
                  </div>
                </div>
              );
            }

            return (
              <div key={idx} className="mb-16">
                <h2
                  className="text-center mb-10 pb-6"
                  style={{
                    ...serifFont,
                    fontSize: 13,
                    fontWeight: 700,
                    color: theme.chapterColor,
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase',
                    borderBottom: `1px solid ${theme.subtleBorder}`,
                  }}
                >
                  {chapter.chapterNumber && !/^chapter\s/i.test(chapter.title)
                    ? `Chapter ${chapter.chapterNumber} · `
                    : ''}
                  {chapter.title}
                </h2>
                <div>
                  {chapter.paragraphs.map((paragraph, i) => {
                    const trimmed = paragraph.trim();
                    if (SCENE_BREAK.test(trimmed)) {
                      return (
                        <div
                          key={i}
                          className="py-8 text-center"
                          style={{ color: theme.sceneBreak, fontSize: 18, letterSpacing: '0.8em' }}
                        >
                          ❦
                        </div>
                      );
                    }
                    const previous = chapter.paragraphs[i - 1]?.trim();
                    const isAfterBreak = i === 0 || (previous ? SCENE_BREAK.test(previous) : false);
                    return (
                      <p
                        key={i}
                        className="mb-4"
                        style={{
                          ...serifFont,
                          fontSize: 16,
                          lineHeight: 1.9,
                          color: theme.text,
                          textAlign: 'justify',
                          textIndent: isAfterBreak ? 0 : '1.5em',
                        }}
                      >
                        {trimmed}
                      </p>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
