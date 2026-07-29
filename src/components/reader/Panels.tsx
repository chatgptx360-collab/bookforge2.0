import { Bookmark as BookmarkIcon, Highlighter, Search, Trash2, X } from 'lucide-react';
import type { Annotation, Bookmark, HighlightColor, ReaderSettings } from '../../utils/readerStore';
import { formatDuration, type BookModel, type ChapterMeta, type FlatParagraph, type SearchHit } from './content';
import { HIGHLIGHT_COLORS, READER_FONTS, READER_THEMES, type ReaderTheme } from './theme';
import { rankVoices } from './narrator';

const FONT_SIZES = { min: 14, max: 30, step: 1 };
const LINE_HEIGHTS = [1.4, 1.55, 1.65, 1.8, 2.0];
const MEASURES = [32, 38, 42, 48, 56];

export function TocPanel({
  model,
  currentChapter,
  settings,
  theme,
  onJump,
}: {
  model: BookModel;
  currentChapter: number;
  settings: ReaderSettings;
  theme: ReaderTheme;
  onJump: (chapter: ChapterMeta) => void;
}) {
  return (
    <div className="py-2">
      {model.chapters.map((chapter) => {
        const active = chapter.index === currentChapter;
        return (
          <button
            key={chapter.index}
            type="button"
            onClick={() => onJump(chapter)}
            className="w-full text-left px-4 py-2.5 transition cursor-pointer"
            style={{
              background: active ? theme.selection : 'transparent',
              borderLeft: `2px solid ${active ? theme.accent : 'transparent'}`,
            }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span
                style={{
                  fontSize: 13,
                  color: theme.chromeText,
                  fontWeight: active ? 600 : 400,
                  opacity: chapter.sectionType === 'chapter' ? 1 : 0.75,
                }}
              >
                {chapter.title}
              </span>
              <span style={{ fontSize: 10, color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>
                {formatDuration(chapter.words / settings.wpm)}
              </span>
            </div>
            <div style={{ fontSize: 10, color: theme.muted, marginTop: 2 }}>
              {chapter.words.toLocaleString()} words
              {chapter.sectionType !== 'chapter' ? ` · ${chapter.sectionType}` : ''}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function SearchPanel({
  query,
  onQueryChange,
  hits,
  theme,
  onJump,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  hits: SearchHit[];
  theme: ReaderTheme;
  onJump: (paragraph: FlatParagraph) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3" style={{ borderBottom: `1px solid ${theme.rule}` }}>
        <div
          className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
          style={{ background: theme.canvas, border: `1px solid ${theme.rule}` }}
        >
          <Search size={13} style={{ color: theme.muted }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search in this book"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: 12, color: theme.chromeText }}
          />
          {query && (
            <button type="button" onClick={() => onQueryChange('')} className="cursor-pointer" title="Clear">
              <X size={12} style={{ color: theme.muted }} />
            </button>
          )}
        </div>
        {query.trim().length >= 2 && (
          <div style={{ fontSize: 10, color: theme.muted, marginTop: 8 }}>
            {hits.length === 0 ? 'No matches' : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {hits.map((hit, index) => (
          <button
            key={`${hit.paragraph.key}-${index}`}
            type="button"
            onClick={() => onJump(hit.paragraph)}
            className="w-full text-left px-4 py-2.5 cursor-pointer transition hover:opacity-80"
            style={{ borderBottom: `1px solid ${theme.rule}` }}
          >
            <span style={{ fontSize: 12, color: theme.chromeText, lineHeight: 1.5 }}>
              …{hit.before}
              <span style={{ background: theme.selection, fontWeight: 600 }}>{hit.match}</span>
              {hit.after}…
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AnnotationsPanel({
  bookmarks,
  annotations,
  theme,
  onJumpBookmark,
  onRemoveBookmark,
  onJumpAnnotation,
  onRemoveAnnotation,
  onNoteChange,
}: {
  bookmarks: Bookmark[];
  annotations: Annotation[];
  theme: ReaderTheme;
  onJumpBookmark: (bookmark: Bookmark) => void;
  onRemoveBookmark: (id: string) => void;
  onJumpAnnotation: (annotation: Annotation) => void;
  onRemoveAnnotation: (id: string) => void;
  onNoteChange: (id: string, note: string) => void;
}) {
  const empty = bookmarks.length === 0 && annotations.length === 0;

  return (
    <div className="overflow-y-auto h-full">
      {empty && (
        <p className="px-4 py-8 text-center" style={{ fontSize: 12, color: theme.muted, lineHeight: 1.7 }}>
          No bookmarks or highlights yet.
          <br />
          Select text to highlight it, or press <kbd>B</kbd> to bookmark the page.
        </p>
      )}

      {bookmarks.length > 0 && (
        <div className="pt-3">
          <h3
            className="px-4 pb-2 flex items-center gap-1.5"
            style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: theme.muted }}
          >
            <BookmarkIcon size={11} /> Bookmarks ({bookmarks.length})
          </h3>
          {bookmarks.map((bookmark) => (
            <div
              key={bookmark.id}
              className="px-4 py-2.5 flex items-start gap-2 group"
              style={{ borderBottom: `1px solid ${theme.rule}` }}
            >
              <button
                type="button"
                onClick={() => onJumpBookmark(bookmark)}
                className="flex-1 text-left cursor-pointer min-w-0"
              >
                <div style={{ fontSize: 10, color: theme.accent, marginBottom: 3 }}>{bookmark.chapterTitle}</div>
                <div style={{ fontSize: 12, color: theme.chromeText, lineHeight: 1.5 }}>{bookmark.excerpt}…</div>
              </button>
              <button
                type="button"
                onClick={() => onRemoveBookmark(bookmark.id)}
                className="opacity-0 group-hover:opacity-100 transition cursor-pointer shrink-0 p-1"
                title="Remove bookmark"
              >
                <Trash2 size={12} style={{ color: theme.muted }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {annotations.length > 0 && (
        <div className="pt-3">
          <h3
            className="px-4 pb-2 flex items-center gap-1.5"
            style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: theme.muted }}
          >
            <Highlighter size={11} /> Highlights ({annotations.length})
          </h3>
          {annotations.map((annotation) => (
            <div
              key={annotation.id}
              className="px-4 py-3 group"
              style={{ borderBottom: `1px solid ${theme.rule}` }}
            >
              <div className="flex items-start gap-2">
                <span
                  className="mt-1 shrink-0 rounded-full"
                  style={{ width: 8, height: 8, background: HIGHLIGHT_COLORS[annotation.color].dot }}
                />
                <button
                  type="button"
                  onClick={() => onJumpAnnotation(annotation)}
                  className="flex-1 text-left cursor-pointer min-w-0"
                >
                  <div style={{ fontSize: 10, color: theme.muted, marginBottom: 3 }}>{annotation.chapterTitle}</div>
                  <div style={{ fontSize: 12, color: theme.chromeText, lineHeight: 1.5, fontStyle: 'italic' }}>
                    “{annotation.text}”
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveAnnotation(annotation.id)}
                  className="opacity-0 group-hover:opacity-100 transition cursor-pointer shrink-0 p-1"
                  title="Delete highlight"
                >
                  <Trash2 size={12} style={{ color: theme.muted }} />
                </button>
              </div>
              <textarea
                value={annotation.note}
                onChange={(e) => onNoteChange(annotation.id, e.target.value)}
                placeholder="Add a note…"
                rows={annotation.note ? 2 : 1}
                className="w-full mt-2 px-2 py-1.5 rounded resize-none outline-none"
                style={{
                  fontSize: 11,
                  color: theme.chromeText,
                  background: theme.canvas,
                  border: `1px solid ${theme.rule}`,
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({
  settings,
  theme,
  onChange,
  voices = [],
}: {
  settings: ReaderSettings;
  theme: ReaderTheme;
  onChange: (patch: Partial<ReaderSettings>) => void;
  voices?: SpeechSynthesisVoice[];
}) {
  const ranked = rankVoices(voices, typeof navigator === 'undefined' ? 'en' : navigator.language || 'en');

  const previewVoice = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      'She climbed the last of the stair, and the lamp turned once, as if it had been waiting for her.',
    );
    const voice = voices.find((candidate) => candidate.voiceURI === settings.voiceURI) ?? ranked[0]?.voice;
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    window.speechSynthesis.speak(utterance);
  };

  const label = (text: string) => (
    <div
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: theme.muted,
        marginBottom: 8,
      }}
    >
      {text}
    </div>
  );

  const chip = (active: boolean) => ({
    fontSize: 11,
    padding: '6px 10px',
    borderRadius: 7,
    cursor: 'pointer',
    border: `1px solid ${active ? theme.accent : theme.rule}`,
    background: active ? theme.selection : 'transparent',
    color: theme.chromeText,
    fontWeight: active ? 600 : 400,
  });

  return (
    <div className="overflow-y-auto h-full px-4 py-4 space-y-6">
      <section>
        {label('Theme')}
        <div className="grid grid-cols-4 gap-2">
          {Object.values(READER_THEMES).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange({ theme: option.id })}
              className="rounded-lg p-2 cursor-pointer transition"
              style={{
                border: `1.5px solid ${settings.theme === option.id ? theme.accent : theme.rule}`,
                background: option.swatch,
              }}
              title={option.label}
            >
              <div style={{ fontSize: 10, color: option.text, fontFamily: 'Georgia, serif' }}>Aa</div>
            </button>
          ))}
        </div>
      </section>

      <section>
        {label('Typeface')}
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(READER_FONTS) as (keyof typeof READER_FONTS)[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onChange({ font: id })}
              style={{ ...chip(settings.font === id), fontFamily: READER_FONTS[id].stack }}
            >
              {READER_FONTS[id].label}
            </button>
          ))}
        </div>
      </section>

      <section>
        {label(`Text size — ${settings.fontSize}px`)}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onChange({ fontSize: Math.max(FONT_SIZES.min, settings.fontSize - FONT_SIZES.step) })}
            style={{ ...chip(false), fontSize: 13, minWidth: 34 }}
            title="Smaller text"
          >
            A−
          </button>
          <input
            type="range"
            min={FONT_SIZES.min}
            max={FONT_SIZES.max}
            step={FONT_SIZES.step}
            value={settings.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            className="flex-1 cursor-pointer"
            style={{ accentColor: theme.accent }}
            aria-label="Text size"
          />
          <button
            type="button"
            onClick={() => onChange({ fontSize: Math.min(FONT_SIZES.max, settings.fontSize + FONT_SIZES.step) })}
            style={{ ...chip(false), fontSize: 15, minWidth: 34 }}
            title="Larger text"
          >
            A+
          </button>
        </div>
      </section>

      <section>
        {label('Line spacing')}
        <div className="flex gap-2 flex-wrap">
          {LINE_HEIGHTS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ lineHeight: value })}
              style={chip(settings.lineHeight === value)}
            >
              {value.toFixed(2).replace(/0$/, '')}
            </button>
          ))}
        </div>
      </section>

      <section>
        {label('Margins')}
        <div className="flex gap-2 flex-wrap">
          {MEASURES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ measure: value })}
              style={chip(settings.measure === value)}
            >
              {value <= 34 ? 'Wide' : value <= 40 ? 'Roomy' : value <= 44 ? 'Normal' : value <= 50 ? 'Narrow' : 'Full'}
            </button>
          ))}
        </div>
      </section>

      <section>
        {label('Layout')}
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={() => onChange({ mode: 'paged' })} style={chip(settings.mode === 'paged')}>
            Paged
          </button>
          <button type="button" onClick={() => onChange({ mode: 'scroll' })} style={chip(settings.mode === 'scroll')}>
            Scrolling
          </button>
          <button
            type="button"
            onClick={() => onChange({ justify: !settings.justify })}
            style={chip(settings.justify)}
          >
            Justified
          </button>
        </div>
      </section>

      <section>
        {label('Narration voice')}
        {ranked.length === 0 ? (
          <p style={{ fontSize: 11, color: theme.muted, lineHeight: 1.6 }}>
            This browser exposes no speech voices. Chrome, Edge and Safari all ship them; Firefox needs system
            voices installed.
          </p>
        ) : (
          <>
            <select
              value={settings.voiceURI ?? ranked[0]?.voice.voiceURI ?? ''}
              onChange={(e) => onChange({ voiceURI: e.target.value })}
              className="w-full rounded-lg px-2 py-2 cursor-pointer"
              style={{
                fontSize: 11,
                color: theme.chromeText,
                background: theme.canvas,
                border: `1px solid ${theme.rule}`,
              }}
              aria-label="Narration voice"
            >
              {ranked.map((entry) => (
                <option key={entry.voice.voiceURI} value={entry.voice.voiceURI}>
                  {entry.label}
                </option>
              ))}
            </select>
            <p style={{ fontSize: 10, color: theme.muted, marginTop: 6, lineHeight: 1.5 }}>
              Voices marked Natural are the neural ones — they carry a book far better than the standard set.
            </p>

            <div className="mt-3 space-y-2">
              <div>
                <div style={{ fontSize: 10, color: theme.muted, marginBottom: 4 }}>Pace — {settings.rate.toFixed(2)}×</div>
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.02}
                  value={settings.rate}
                  onChange={(e) => onChange({ rate: Number(e.target.value) })}
                  className="w-full cursor-pointer"
                  style={{ accentColor: theme.accent }}
                  aria-label="Narration pace"
                />
              </div>
              <div>
                <div style={{ fontSize: 10, color: theme.muted, marginBottom: 4 }}>Pitch — {settings.pitch.toFixed(2)}</div>
                <input
                  type="range"
                  min={0.6}
                  max={1.4}
                  step={0.02}
                  value={settings.pitch}
                  onChange={(e) => onChange({ pitch: Number(e.target.value) })}
                  className="w-full cursor-pointer"
                  style={{ accentColor: theme.accent }}
                  aria-label="Narration pitch"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-3 flex-wrap">
              <button type="button" onClick={() => onChange({ expressive: !settings.expressive })} style={chip(settings.expressive)}>
                Narrator pacing
              </button>
              <button type="button" onClick={previewVoice} style={chip(false)}>
                Hear a line
              </button>
            </div>
            <p style={{ fontSize: 10, color: theme.muted, marginTop: 6, lineHeight: 1.5 }}>
              Narrator pacing adds breath at paragraph ends, a real gap at scene breaks, and lifts the voice for
              dialogue and questions.
            </p>
          </>
        )}
      </section>

      <section>
        {label(`Reading speed — ${settings.wpm} wpm`)}
        <input
          type="range"
          min={120}
          max={420}
          step={10}
          value={settings.wpm}
          onChange={(e) => onChange({ wpm: Number(e.target.value) })}
          className="w-full cursor-pointer"
          style={{ accentColor: theme.accent }}
          aria-label="Reading speed"
        />
      </section>
    </div>
  );
}

export function HighlightMenu({
  x,
  y,
  theme,
  hasLookup,
  onHighlight,
  onLookup,
  onCopy,
  onDismiss,
}: {
  x: number;
  y: number;
  theme: ReaderTheme;
  hasLookup: boolean;
  onHighlight: (color: HighlightColor) => void;
  onLookup: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed z-[70] flex items-center gap-1 rounded-xl px-2 py-1.5 shadow-2xl"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 240)),
        top: Math.max(8, y),
        background: theme.chrome,
        border: `1px solid ${theme.rule}`,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onHighlight(color)}
          className="rounded-full cursor-pointer transition hover:scale-110"
          style={{ width: 18, height: 18, background: HIGHLIGHT_COLORS[color].dot }}
          title={`Highlight ${HIGHLIGHT_COLORS[color].label.toLowerCase()}`}
          aria-label={`Highlight ${HIGHLIGHT_COLORS[color].label}`}
        />
      ))}
      <span style={{ width: 1, height: 18, background: theme.rule, margin: '0 4px' }} />
      <button
        type="button"
        onClick={onCopy}
        className="px-2 py-1 rounded cursor-pointer"
        style={{ fontSize: 11, color: theme.chromeText }}
      >
        Copy
      </button>
      {hasLookup && (
        <button
          type="button"
          onClick={onLookup}
          className="px-2 py-1 rounded cursor-pointer"
          style={{ fontSize: 11, color: theme.accent, fontWeight: 600 }}
        >
          Look up
        </button>
      )}
      <button type="button" onClick={onDismiss} className="px-1 cursor-pointer" title="Dismiss">
        <X size={12} style={{ color: theme.muted }} />
      </button>
    </div>
  );
}
