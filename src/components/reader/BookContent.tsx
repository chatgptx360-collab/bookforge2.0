import React, { useMemo } from 'react';
import type { Annotation, ReaderSettings } from '../../utils/readerStore';
import { chapterId, paragraphId, type BookModel, type FlatParagraph } from './content';
import { highlightFill, READER_FONTS, type ReaderTheme } from './theme';

interface BookContentProps {
  model: BookModel;
  settings: ReaderSettings;
  theme: ReaderTheme;
  annotations: Annotation[];
  bookmarkedKeys: Set<string>;
  speakingKey: string | null;
  flashKey: string | null;
  title: string;
  author: string;
}

interface Segment {
  text: string;
  annotation?: Annotation;
}

/** Splits a paragraph into plain and highlighted segments. */
function segmentParagraph(text: string, annotations: Annotation[]): Segment[] {
  if (annotations.length === 0) return [{ text }];

  const ordered = [...annotations].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;

  for (const annotation of ordered) {
    const start = Math.max(cursor, Math.min(annotation.start, text.length));
    const end = Math.max(start, Math.min(annotation.end, text.length));
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    if (end > start) segments.push({ text: text.slice(start, end), annotation });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

function Paragraph({
  paragraph,
  annotations,
  settings,
  theme,
  isSpeaking,
  isFlashing,
  isBookmarked,
  dropCap,
  indent,
}: {
  paragraph: FlatParagraph;
  annotations: Annotation[];
  settings: ReaderSettings;
  theme: ReaderTheme;
  isSpeaking: boolean;
  isFlashing: boolean;
  isBookmarked: boolean;
  dropCap: boolean;
  indent: boolean;
}) {
  if (paragraph.kind === 'scene') {
    return (
      <div
        id={paragraph.key}
        data-paragraph={paragraph.key}
        className="text-center select-none"
        style={{ color: theme.muted, padding: '1.1em 0', letterSpacing: '0.75em', fontSize: '0.85em' }}
        aria-hidden="true"
      >
        ❦
      </div>
    );
  }

  const segments = segmentParagraph(paragraph.text, annotations);
  const isMeta = paragraph.kind === 'meta';

  return (
    <p
      id={paragraph.key}
      data-paragraph={paragraph.key}
      data-chapter={paragraph.chapterIndex}
      className="reader-paragraph"
      style={{
        margin: isMeta ? '0 0 0.55em' : '0 0 0.15em',
        textIndent: indent && !isMeta ? '1.35em' : 0,
        textAlign: isMeta ? 'center' : settings.justify ? 'justify' : 'left',
        hyphens: settings.justify ? 'auto' : 'manual',
        color: isMeta ? theme.muted : theme.text,
        fontSize: isMeta ? '0.86em' : undefined,
        background: isSpeaking ? theme.selection : isFlashing ? theme.selection : undefined,
        borderRadius: isSpeaking || isFlashing ? 3 : undefined,
        boxShadow: isBookmarked ? `inset 3px 0 0 ${theme.accent}` : undefined,
        paddingLeft: isBookmarked ? '0.7em' : undefined,
        transition: 'background 220ms ease',
      }}
    >
      {segments.map((segment, index) =>
        segment.annotation ? (
          <mark
            key={index}
            data-annotation={segment.annotation.id}
            title={segment.annotation.note || 'Highlight'}
            style={{
              background: highlightFill(segment.annotation.color, settings.theme),
              color: 'inherit',
              padding: '0.05em 0',
              borderRadius: 2,
              borderBottom: segment.annotation.note ? `2px solid ${theme.accent}` : undefined,
            }}
          >
            {segment.text}
          </mark>
        ) : dropCap && index === 0 ? (
          <React.Fragment key={index}>
            <span
              aria-hidden="true"
              style={{
                float: 'left',
                fontSize: '3.05em',
                lineHeight: 0.86,
                paddingRight: '0.09em',
                paddingTop: '0.06em',
                fontWeight: 600,
                color: theme.text,
              }}
            >
              {segment.text.slice(0, 1)}
            </span>
            {segment.text.slice(1)}
          </React.Fragment>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </p>
  );
}

export default function BookContent({
  model,
  settings,
  theme,
  annotations,
  bookmarkedKeys,
  speakingKey,
  flashKey,
  title,
  author,
}: BookContentProps) {
  const font = READER_FONTS[settings.font];

  const annotationsByParagraph = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const annotation of annotations) {
      const key = paragraphId(annotation.chapterIndex, annotation.paragraphIndex);
      const list = map.get(key);
      if (list) list.push(annotation);
      else map.set(key, [annotation]);
    }
    return map;
  }, [annotations]);

  return (
    <div
      style={{
        fontFamily: font.stack,
        fontSize: `${Math.round(settings.fontSize * font.scale)}px`,
        lineHeight: settings.lineHeight,
        color: theme.text,
      }}
    >
      {model.chapters.map((chapter) => {
        const isTitlePage = chapter.sectionType === 'title';
        let firstTextSeen = false;

        return (
          <section
            key={chapter.index}
            id={chapterId(chapter.index)}
            data-chapter-start={chapter.index}
            style={{ breakBefore: chapter.index === 0 ? 'auto' : 'column', paddingBottom: '1.6em' }}
          >
            {isTitlePage ? (
              <header style={{ textAlign: 'center', padding: '2.2em 0 1.6em' }}>
                <h1 style={{ fontSize: '1.9em', fontWeight: 600, margin: '0 0 0.35em', color: theme.text }}>
                  {chapter.paragraphs[0]?.text || title}
                </h1>
                <p style={{ margin: 0, color: theme.muted, fontStyle: 'italic', fontSize: '0.95em' }}>{author}</p>
                <div style={{ margin: '1.6em auto 0', width: 64, height: 1, background: theme.rule }} />
              </header>
            ) : (
              <header style={{ padding: '0.6em 0 1.5em', textAlign: 'center' }}>
                {chapter.chapterNumber !== undefined && !/^chapter\s/i.test(chapter.title) && (
                  <div
                    style={{
                      fontSize: '0.68em',
                      letterSpacing: '0.22em',
                      textTransform: 'uppercase',
                      color: theme.muted,
                      marginBottom: '0.6em',
                    }}
                  >
                    Chapter {chapter.chapterNumber}
                  </div>
                )}
                <h2
                  style={{
                    fontSize: '1.18em',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    margin: 0,
                    color: theme.text,
                  }}
                >
                  {chapter.title}
                </h2>
                <div style={{ margin: '1.1em auto 0', width: 44, height: 1, background: theme.rule }} />
              </header>
            )}

            {chapter.paragraphs.map((paragraph, index) => {
              // The title page renders its own heading and byline above.
              if (isTitlePage && index === 0) return null;
              if (
                isTitlePage &&
                /^(by|written by)\s+/i.test(paragraph.text) &&
                author.toLowerCase().includes(paragraph.text.replace(/^(by|written by)\s+/i, '').toLowerCase())
              ) {
                return null;
              }
              const isFirstText = paragraph.kind === 'text' && !firstTextSeen;
              if (isFirstText) firstTextSeen = true;
              const previous = chapter.paragraphs[index - 1];
              const indent = paragraph.kind === 'text' && !isFirstText && previous?.kind !== 'scene';

              return (
                <Paragraph
                  key={paragraph.key}
                  paragraph={paragraph}
                  annotations={annotationsByParagraph.get(paragraph.key) ?? []}
                  settings={settings}
                  theme={theme}
                  isSpeaking={speakingKey === paragraph.key}
                  isFlashing={flashKey === paragraph.key}
                  isBookmarked={bookmarkedKeys.has(paragraph.key)}
                  dropCap={isFirstText && chapter.sectionType === 'chapter'}
                  indent={indent}
                />
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
