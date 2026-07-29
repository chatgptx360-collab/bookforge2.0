import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  BookOpen,
  Upload,
  Download,
  Plus,
  Trash2,
  Edit3,
  FileText,
  RotateCcw,
  Maximize2,
  Minimize2,
  Type,
  Palette,
  Clock,
  AlertCircle,
  ArrowRightLeft,
  BookMarked,
  Award,
  PanelLeft,
} from 'lucide-react';
import BookReader from './BookReader';
import type { BookProject, DocumentChapter, ParsedDocument, ParsedSection } from '../types';
import { clearWorkspace, describeAge, loadWorkspace, saveWorkspace } from '../utils/workspaceStore';

const EDITOR_THEMES = [
  {
    id: 'charcoal',
    name: 'Imperial Charcoal',
    bg: 'bg-[#0E0E11]',
    editorBg: 'bg-[#141417]',
    border: 'border-[#27272A]',
    accent: '#D4AF37',
    textColor: 'text-[#D1D1D6]',
  },
  {
    id: 'papyrus',
    name: 'Warm Papyrus',
    bg: 'bg-[#F7F4EB]',
    editorBg: 'bg-[#FCFAF5]',
    border: 'border-[#E3DEC3]',
    accent: '#8B5E3C',
    textColor: 'text-[#3D3A39]',
  },
  {
    id: 'midnight',
    name: 'Midnight Velvet',
    bg: 'bg-[#070913]',
    editorBg: 'bg-[#0A0D1E]',
    border: 'border-[#1E293B]',
    accent: '#38BDF8',
    textColor: 'text-[#94A3B8]',
  },
  {
    id: 'emerald',
    name: 'Emerald Library',
    bg: 'bg-[#05110E]',
    editorBg: 'bg-[#091A16]',
    border: 'border-[#10342B]',
    accent: '#10B981',
    textColor: 'text-[#A7F3D0]',
  },
] as const;

const FONTS = [
  { id: 'font-serif', name: 'Georgia Classic (Books)', css: 'font-serif' },
  { id: 'font-sans', name: 'Inter Modern (Sleek)', css: 'font-sans' },
  { id: 'font-mono', name: 'JetBrains Workspace (Mono)', css: 'font-mono' },
];

const ACCEPTED = ['.pdf', '.docx', '.epub', '.txt', '.rtf'];

const SAMPLE_CHAPTER: DocumentChapter = {
  id: 'sample_1',
  title: 'Introduction',
  text: [
    'Welcome to the BookForge Reader & Editor.',
    '',
    'Upload a manuscript (.pdf, .docx, .epub, .txt, .rtf) with the import panel on the left, or start writing directly in this pane.',
    '',
    'Edit, re-title and split sections, preview the typeset layout, then export the result as a clean DOCX or TXT file.',
  ].join('\n'),
  sectionType: 'chapter',
};

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function sectionLabel(section: ParsedSection, index: number): string {
  if (section.title?.trim()) return section.title.trim();
  if (section.type === 'chapter') return `Chapter ${section.chapterNumber ?? index + 1}`;
  return section.type.charAt(0).toUpperCase() + section.type.slice(1);
}

export default function ReaderEditorPanel() {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState('My Uploaded Masterpiece');
  const [docSubtitle, setDocSubtitle] = useState('');
  const [docAuthor, setDocAuthor] = useState('Unknown Author');
  const [chapters, setChapters] = useState<DocumentChapter[]>([SAMPLE_CHAPTER]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>(SAMPLE_CHAPTER.id);
  const [activeThemeId, setActiveThemeId] = useState<string>('charcoal');
  const [activeFontClass, setActiveFontClass] = useState('font-serif');
  const [fontSize, setFontSize] = useState(16);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingKdp, setIsExportingKdp] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [readingFullscreen, setReadingFullscreen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const hydratedRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Restore the previous session before the first autosave can overwrite it.
  useEffect(() => {
    const saved = loadWorkspace();
    hydratedRef.current = true;
    if (!saved) return;
    setDocTitle(saved.title);
    setDocSubtitle(saved.subtitle);
    setDocAuthor(saved.author);
    setChapters(saved.chapters);
    setSelectedChapterId(saved.selectedChapterId || saved.chapters[0].id);
    setRestoredAt(saved.savedAt);
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const isUntouchedSample = chapters.length === 1 && chapters[0].id === SAMPLE_CHAPTER.id;
    if (isUntouchedSample) return;
    const timer = setTimeout(() => {
      saveWorkspace({
        title: docTitle,
        subtitle: docSubtitle,
        author: docAuthor,
        chapters,
        selectedChapterId,
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [chapters, docTitle, docSubtitle, docAuthor, selectedChapterId]);

  const startFresh = () => {
    clearWorkspace();
    setChapters([SAMPLE_CHAPTER]);
    setSelectedChapterId(SAMPLE_CHAPTER.id);
    setDocTitle('My Uploaded Masterpiece');
    setDocSubtitle('');
    setDocAuthor('Unknown Author');
    setRestoredAt(null);
  };

  const activeTheme = EDITOR_THEMES.find((t) => t.id === activeThemeId) ?? EDITOR_THEMES[0];
  const activeChapter = chapters.find((c) => c.id === selectedChapterId) ?? chapters[0] ?? null;

  const readerChapters = useMemo(
    () =>
      chapters.map((ch) => ({
        title: ch.title,
        content: ch.text,
        sectionType: ch.sectionType,
        chapterNumber: ch.chapterNumber,
      })),
    [chapters],
  );

  const handleTextChange = (newVal: string) =>
    setChapters((prev) => prev.map((ch) => (ch.id === selectedChapterId ? { ...ch, text: newVal } : ch)));

  const handleTitleChange = (newVal: string) =>
    setChapters((prev) => prev.map((ch) => (ch.id === selectedChapterId ? { ...ch, title: newVal } : ch)));

  const parseFile = useCallback(async (file: File) => {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      setError(`Unsupported file format: ${ext}. Please select pdf, docx, epub, txt or rtf.`);
      return;
    }

    setIsParsing(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/book/parse-file', { method: 'POST', body: formData });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'The server could not parse this manuscript.');
      }
      const result = (await response.json()) as ParsedDocument;
      const baseName = file.name.replace(/\.[^/.]+$/, '');

      if (!result.sections?.length) throw new Error('No readable sections were found in this manuscript.');

      const stamp = Date.now();
      const loaded: DocumentChapter[] = result.sections.map((section, idx) => ({
        id: `section_${idx}_${stamp}`,
        title: sectionLabel(section, idx),
        text: section.content,
        sectionType: section.type,
        chapterNumber: section.chapterNumber,
      }));

      setDocTitle(result.title || baseName);
      setDocSubtitle('');
      setDocAuthor(result.author || 'Unknown Author');
      setChapters(loaded);
      setSelectedChapterId(loaded[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process book contents.');
    } finally {
      setIsParsing(false);
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parseFile(file);
  };

  const handleAddChapter = () => {
    const newId = `chapter_${Date.now()}`;
    setChapters((prev) => [
      ...prev,
      { id: newId, title: `Chapter ${prev.length + 1}`, text: 'Start drafting here…', sectionType: 'chapter' },
    ]);
    setSelectedChapterId(newId);
  };

  const handleDeleteChapter = (idToDelete: string) => {
    if (chapters.length <= 1) {
      setError('At least one section must remain in the document.');
      return;
    }
    const filtered = chapters.filter((c) => c.id !== idToDelete);
    setChapters(filtered);
    if (selectedChapterId === idToDelete) setSelectedChapterId(filtered[0].id);
  };

  const handleSplitChapter = () => {
    const textarea = textareaRef.current;
    if (!textarea || !activeChapter) return;
    const caret = textarea.selectionStart;
    const firstHalf = activeChapter.text.slice(0, caret).trim();
    const secondHalf = activeChapter.text.slice(caret).trim();
    if (!secondHalf) {
      setError('Place the cursor inside the text before splitting — there is nothing after the caret.');
      return;
    }
    const currentIdx = chapters.findIndex((c) => c.id === selectedChapterId);
    if (currentIdx === -1) return;

    const proposed = window.prompt('Title for the new section:', `Chapter ${chapters.length + 1}`);
    if (proposed === null) return;

    const newId = `split_${Date.now()}`;
    const next = [...chapters];
    next[currentIdx] = { ...next[currentIdx], text: firstHalf || '' };
    next.splice(currentIdx + 1, 0, {
      id: newId,
      title: proposed || `Chapter ${chapters.length + 1}`,
      text: secondHalf,
      sectionType: 'chapter',
    });
    setChapters(next);
    setSelectedChapterId(newId);
    setError(null);
  };

  const handleExportDocx = async () => {
    setIsExporting(true);
    setError(null);
    try {
      const response = await fetch('/api/book/export-custom-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: docTitle,
          subtitle: docSubtitle,
          author: docAuthor,
          chapters: chapters.map((ch) => ({ title: ch.title, text: ch.text, sectionType: ch.sectionType })),
        }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to compile the document.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${docTitle.trim().replace(/\s+/g, '_') || 'manuscript'}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'DOCX export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  /** Offline export: builds the KDP-layout DOCX entirely in the browser. */
  const handleExportKdp = async () => {
    setIsExportingKdp(true);
    setError(null);
    try {
      const bodyChapters = chapters.filter((ch) => (ch.sectionType ?? 'chapter') === 'chapter');
      const source = bodyChapters.length > 0 ? bodyChapters : chapters;
      const project: BookProject = {
        id: `local_${Date.now()}`,
        title: docTitle,
        subtitle: docSubtitle,
        genre: '',
        audience: '',
        tone: '',
        premise: '',
        pacing: '',
        authorPersona: docAuthor,
        penName: docAuthor,
        discoveryAnswers: {},
        discoveryAnalysis: null,
        status: 'completed',
        createdAt: new Date().toISOString(),
        outline: {
          suggestedBookTitle: docTitle,
          suggestedSubTitle: docSubtitle,
          chaptersSettingFocus: '',
          chapters: source.map((ch, idx) => ({
            chapterNumber: ch.chapterNumber ?? idx + 1,
            title: ch.title,
            focus: '',
            subsections: [],
            emotionalArcOrKeyLesson: '',
            estimatedWordCount: wordCount(ch.text),
          })),
        },
        chapters: source.map((ch, idx) => ({
          chapterNumber: ch.chapterNumber ?? idx + 1,
          title: ch.title,
          text: ch.text,
          actualWordCount: wordCount(ch.text),
          status: 'completed',
          statusIntermission: null,
        })),
      };
      // The `docx` library is ~400 kB — load it only when the user exports.
      const { exportToKDPDocx } = await import('../utils/docxExporter');
      await exportToKDPDocx(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'KDP export failed.');
    } finally {
      setIsExportingKdp(false);
    }
  };

  const handleExportTxt = () => {
    const divider = '='.repeat(41);
    const lines = [divider, docTitle.toUpperCase()];
    if (docSubtitle) lines.push(docSubtitle);
    lines.push(`by ${docAuthor}`, divider, '', '');
    for (const ch of chapters) {
      lines.push(`## ${ch.title}`, '', ch.text, '', '-'.repeat(41), '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docTitle.trim().replace(/\s+/g, '_') || 'manuscript'}_compiled.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const activeWordCount = activeChapter ? wordCount(activeChapter.text) : 0;
  const activeCharCount = activeChapter ? activeChapter.text.length : 0;
  const readingMinutes = Math.max(1, Math.ceil(activeWordCount / 220));
  const totalWords = chapters.reduce((sum, ch) => sum + wordCount(ch.text), 0);

  useEffect(() => {
    if (readingFullscreen) document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [readingFullscreen]);

  return (
    <div className={`flex-1 flex flex-col min-h-0 overflow-hidden ${activeTheme.bg} transition-colors duration-200`}>
      <header className="h-14 sm:h-16 border-b border-[#27272A] px-3 sm:px-6 bg-[#111114] flex items-center justify-between gap-2 z-10 select-none shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/10 border border-[#D4AF37]/35 flex items-center justify-center text-[#D4AF37] shrink-0">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xs font-bold text-white uppercase tracking-wider">Universal Reader &amp; Editor</h1>
            <p className="text-[10px] text-zinc-400 font-mono truncate max-w-[240px]">
              Active: {docTitle || 'Untitled Manuscript'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          <div className="hidden lg:flex items-center bg-[#18181B] border border-[#27272A] rounded-lg p-1.5 gap-1 text-[10px] font-mono text-zinc-400">
            <Palette className="w-3.5 h-3.5 text-[#D4AF37] ml-0.5 mr-1" />
            {EDITOR_THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                onClick={() => {
                  setActiveThemeId(theme.id);
                  if (theme.id === 'papyrus') setActiveFontClass('font-serif');
                }}
                className={`px-1.5 py-0.5 rounded text-[9px] capitalize transition cursor-pointer ${
                  activeThemeId === theme.id ? 'bg-[#D4AF37] text-black font-semibold' : 'hover:text-white'
                }`}
                title={theme.name}
              >
                {theme.id.slice(0, 3)}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setSectionsOpen((v) => !v)}
            className="md:hidden p-2 rounded-lg bg-[#18181B] border border-[#27272A] text-zinc-300 hover:text-white cursor-pointer transition shrink-0"
            title="Sections"
            aria-label="Toggle sections"
          >
            <PanelLeft className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setIsPreviewMode((v) => !v)}
            className={`p-2 rounded-lg border transition cursor-pointer flex items-center gap-1.5 text-xs font-semibold ${
              isPreviewMode
                ? 'bg-[#D4AF37] border-[#D4AF37] text-black'
                : 'bg-[#18181B] border-[#27272A] text-zinc-300 hover:text-white'
            }`}
            title="Toggle typeset preview"
          >
            <BookMarked className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">Typeset Preview</span>
          </button>

          <button
            type="button"
            onClick={() => setReadingFullscreen(true)}
            className="p-2 rounded-lg bg-[#18181B] border border-[#27272A] text-zinc-300 hover:text-white text-xs font-medium cursor-pointer transition flex items-center gap-1.5"
            title="Fullscreen reading mode"
          >
            <BookOpen className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden xl:inline">Read</span>
          </button>

          <div className="h-6 w-px bg-zinc-800 mx-1" />

          <button
            type="button"
            onClick={handleExportTxt}
            className="p-2 rounded-lg bg-[#18181B] border border-[#27272A] text-zinc-300 hover:text-white text-xs font-medium cursor-pointer transition flex items-center gap-1.5"
            title="Export the manuscript as plain text"
          >
            <FileText className="w-3.5 h-3.5 text-blue-400" />
            <span className="hidden sm:inline">Export .txt</span>
          </button>

          <button
            type="button"
            onClick={handleExportKdp}
            disabled={isExportingKdp}
            className="p-2 rounded-lg bg-[#18181B] border border-[#27272A] text-zinc-300 hover:text-white text-xs font-medium cursor-pointer transition flex items-center gap-1.5 disabled:opacity-50"
            title="Build a KDP-layout DOCX in the browser (works offline)"
          >
            {isExportingKdp ? (
              <RotateCcw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Award className="w-3.5 h-3.5 text-amber-400" />
            )}
            <span className="hidden lg:inline">KDP DOCX</span>
          </button>

          <button
            type="button"
            onClick={handleExportDocx}
            disabled={isExporting}
            className="py-2 px-3 rounded-lg bg-[#D4AF37] text-black font-semibold hover:bg-[#b59228] transition flex items-center gap-1.5 text-xs cursor-pointer disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                <span>Compiling…</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Download DOCX</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setIsFocusMode((v) => !v)}
            className={`p-2 rounded-lg border transition cursor-pointer text-zinc-400 hover:text-white ${
              isFocusMode ? 'bg-[#D4AF37]/20 border-[#D4AF37] text-[#D4AF37]' : 'bg-[#18181B] border-[#27272A]'
            }`}
            title="Toggle distraction-free mode"
          >
            {isFocusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {restoredAt !== null && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-[#D4AF37]/8 border-b border-[#D4AF37]/20">
          <span className="text-[11px] text-[#D4AF37]/90">
            Restored your last session from {describeAge(restoredAt)}.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={startFresh}
              className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300 hover:text-white cursor-pointer"
            >
              Start fresh
            </button>
            <button
              type="button"
              onClick={() => setRestoredAt(null)}
              className="text-[10px] font-semibold uppercase tracking-wider text-[#71717A] hover:text-white cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {sectionsOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
            onClick={() => setSectionsOpen(false)}
            aria-hidden="true"
          />
        )}
        <AnimatePresence initial={false}>
          {!isFocusMode && (
            <motion.aside
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`border-r border-[#27272A] bg-[#0A0A0B] md:bg-[#0A0A0B]/80 flex-col h-full select-none overflow-hidden shrink-0 w-[260px] ${
                sectionsOpen ? 'flex fixed inset-y-0 left-0 z-40 shadow-2xl' : 'hidden'
              } md:static md:flex md:shadow-none`}
            >
              <div className="p-4 border-b border-[#27272A] space-y-4 w-[260px]">
                <div className="space-y-1">
                  <span className="text-[9px] font-mono text-[#D4AF37] font-bold tracking-widest uppercase">
                    Document Attributes
                  </span>
                  <input
                    type="text"
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder="Document Title"
                    className="w-full bg-transparent text-sm font-semibold text-white focus:outline-none border-b border-zinc-800 focus:border-[#D4AF37] py-1"
                  />
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <input
                      type="text"
                      value={docSubtitle}
                      onChange={(e) => setDocSubtitle(e.target.value)}
                      placeholder="Subtitle"
                      className="w-full bg-transparent text-[10px] text-zinc-400 focus:outline-none border-b border-zinc-900 focus:border-zinc-700 py-0.5"
                    />
                    <input
                      type="text"
                      value={docAuthor}
                      onChange={(e) => setDocAuthor(e.target.value)}
                      placeholder="Author/Pen"
                      className="w-full bg-transparent text-[10px] text-zinc-400 focus:outline-none border-b border-zinc-900 focus:border-zinc-700 py-0.5"
                    />
                  </div>
                </div>

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border border-dashed p-3 rounded-xl text-center cursor-pointer transition flex flex-col items-center justify-center ${
                    isDragOver
                      ? 'border-[#D4AF37] bg-[#D4AF37]/5'
                      : 'border-zinc-800 hover:border-zinc-700 bg-black/30 hover:bg-black/50'
                  }`}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void parseFile(file);
                      e.target.value = '';
                    }}
                    className="hidden"
                    accept={ACCEPTED.join(',')}
                  />
                  <Upload className="w-5 h-5 text-[#D4AF37] mb-1" />
                  <span className="text-[10px] font-medium text-white">Import Book File</span>
                  <span className="text-[8px] text-zinc-500 mt-0.5">PDF, EPUB, DOCX, TXT, RTF</span>
                </div>
              </div>

              {error && (
                <div className="m-3 p-3 bg-red-950/40 border border-red-800 text-red-200 text-[10px] rounded-lg flex items-start gap-2 leading-relaxed w-[236px]">
                  <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}

              <div className="flex-1 flex flex-col min-h-0 w-[260px]">
                <div className="px-4 py-3 flex items-center justify-between text-[10px] font-mono border-b border-[#27272A]/40 bg-black/10">
                  <span className="text-zinc-400 uppercase tracking-widest font-semibold">
                    TOC outline ({chapters.length})
                  </span>
                  <button
                    type="button"
                    onClick={handleAddChapter}
                    className="flex items-center gap-1 text-[#D4AF37] hover:underline cursor-pointer"
                    title="Insert a new section"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Section</span>
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  {chapters.map((ch, idx) => (
                    <div
                      key={ch.id}
                      onClick={() => {
                        setSelectedChapterId(ch.id);
                        setSectionsOpen(false);
                      }}
                      className={`p-2.5 rounded-lg border group cursor-pointer transition flex items-center gap-2 ${
                        selectedChapterId === ch.id
                          ? 'bg-[#D4AF37]/10 border-[#D4AF37]/45 text-white'
                          : 'bg-transparent border-transparent text-zinc-400 hover:bg-[#18181B]/50 hover:text-zinc-200'
                      }`}
                    >
                      <span className="text-[9px] font-mono text-[#D4AF37]/60 group-hover:text-[#D4AF37] shrink-0">
                        {(idx + 1).toString().padStart(2, '0')}
                      </span>
                      <div className="flex-1 truncate min-w-0 pr-1">
                        <span className="text-[11px] font-medium block truncate leading-none">
                          {ch.title || 'Untitled Section'}
                        </span>
                        <span className="text-[8.5px] font-mono text-zinc-500 block mt-1 leading-none">
                          {ch.sectionType && ch.sectionType !== 'chapter' ? `${ch.sectionType} · ` : ''}
                          ~{wordCount(ch.text).toLocaleString()} words
                        </span>
                      </div>
                      {chapters.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteChapter(ch.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/40 hover:text-red-400 transition"
                          title="Delete section"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="p-4 border-t border-[#27272A]/70 bg-black/20 text-[10px] text-zinc-400 space-y-1.5 font-mono select-none">
                  <div className="flex justify-between items-center">
                    <span>Document total words:</span>
                    <span className="text-[#D4AF37] font-semibold">{totalWords.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between items-center text-[9px] text-zinc-500">
                    <span>Estimate target:</span>
                    <span>1 bound novel (~50k)</span>
                  </div>
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {isParsing && (
          <div className="absolute inset-0 bg-black/75 z-20 flex flex-col items-center justify-center space-y-4 select-none">
            <div className="w-12 h-12 rounded-xl bg-[#1E1E22] border border-[#27272A] flex items-center justify-center text-[#D4AF37] animate-spin">
              <RotateCcw className="w-6 h-6" />
            </div>
            <div className="text-center space-y-1">
              <h3 className="text-sm font-semibold text-white">Extracting book content…</h3>
              <p className="text-[10px] text-zinc-400 font-mono">Running mammoth, pdf-parse and the EPUB reader</p>
            </div>
          </div>
        )}

        {isPreviewMode ? (
          <div className="flex-1 overflow-hidden">
            <BookReader title={docTitle} author={docAuthor} chapters={readerChapters} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {activeChapter && (
              <div className="h-10 px-6 border-b border-[#27272A]/55 bg-black/10 flex items-center justify-between text-xs select-none shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Edit3 className="w-3.5 h-3.5 text-[#D4AF37]/75 shrink-0" />
                  <input
                    type="text"
                    value={activeChapter.title}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    className="bg-transparent font-medium text-white focus:outline-none focus:border-b focus:border-[#D4AF37] max-w-[200px] text-xs py-0.5"
                    title="Rename this section"
                  />
                </div>
                <div className="flex items-center gap-4 text-[10.5px] font-mono text-zinc-400">
                  <div className="flex items-center gap-1.5">
                    <Type className="w-3.5 h-3.5 text-zinc-500" />
                    <select
                      value={activeFontClass}
                      onChange={(e) => setActiveFontClass(e.target.value)}
                      className="bg-transparent border-none text-[10px] text-zinc-300 focus:outline-none cursor-pointer"
                      title="Editor typeface"
                    >
                      {FONTS.map((f) => (
                        <option key={f.id} value={f.css} className="bg-[#111114] text-white">
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1 bg-black/20 rounded border border-zinc-800/80 px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => setFontSize((prev) => Math.max(12, prev - 1))}
                      className="w-4 h-4 text-center text-[10px] hover:text-white transition cursor-pointer"
                      title="Smaller text"
                    >
                      −
                    </button>
                    <span className="text-[9px] text-[#D4AF37]/80 min-w-[24px] text-center">{fontSize}px</span>
                    <button
                      type="button"
                      onClick={() => setFontSize((prev) => Math.min(28, prev + 1))}
                      className="w-4 h-4 text-center text-[10px] hover:text-white transition cursor-pointer"
                      title="Larger text"
                    >
                      +
                    </button>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <button
                    type="button"
                    onClick={handleSplitChapter}
                    className="flex items-center gap-1 text-zinc-400 hover:text-white transition cursor-pointer"
                    title="Split this section at the cursor"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5 text-[#D4AF37]/80" />
                    <span className="hidden lg:inline">Split at Cursor</span>
                  </button>
                </div>
              </div>
            )}

            {activeChapter ? (
              <div className={`flex-1 overflow-hidden p-8 flex justify-center ${activeTheme.editorBg}`}>
                <div className="w-full max-w-3xl flex flex-col h-full min-h-0">
                  <textarea
                    ref={textareaRef}
                    value={activeChapter.text}
                    onChange={(e) => handleTextChange(e.target.value)}
                    style={{ fontSize: `${fontSize}px` }}
                    spellCheck
                    className={`flex-1 w-full bg-transparent border-none placeholder-zinc-700 resize-none focus:outline-none leading-relaxed focus:ring-0 selection:bg-[#D4AF37]/20 ${activeFontClass} ${activeTheme.textColor}`}
                    placeholder="Draft your chapters, scenes, or parsed manuscript sections here…"
                  />
                  <div className="h-8 border-t border-zinc-800/30 text-[10px] font-mono text-zinc-500 mt-4 flex items-center justify-between select-none shrink-0">
                    <div className="flex items-center gap-4">
                      <span className="truncate max-w-[220px]">
                        Section: <strong className="text-zinc-400 font-medium">{activeChapter.title}</strong>
                      </span>
                      <span>
                        Words: <strong className="text-zinc-400 font-medium">{activeWordCount.toLocaleString()}</strong>
                      </span>
                      <span>
                        Chars: <strong className="text-zinc-400 font-medium">{activeCharCount.toLocaleString()}</strong>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-zinc-600" />
                      <span>
                        Est. read: <strong className="text-[#D4AF37]">{readingMinutes} min</strong>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                Add a section to start writing.
              </div>
            )}
          </div>
        )}
      </div>

      {readingFullscreen && (
        <BookReader
          title={docTitle}
          author={docAuthor}
          chapters={readerChapters}
          onClose={() => setReadingFullscreen(false)}
        />
      )}
    </div>
  );
}
