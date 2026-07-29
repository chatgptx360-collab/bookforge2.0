import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  Download,
  FileText,
  Languages,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { blockText, type RichBlock } from '../types';
import {
  deleteJob,
  jobProgress,
  listJobs,
  loadJob,
  saveJob,
  type GlossaryEntry,
  type TranslationBrief,
  type TranslationJob,
  type TranslationSegment,
} from '../utils/translationStore';

const LANGUAGES = [
  'Spanish', 'Spanish (Latin America)', 'French', 'German', 'Italian', 'Portuguese (Brazil)',
  'Dutch', 'Polish', 'Russian', 'Japanese', 'Korean', 'Simplified Chinese', 'Traditional Chinese',
  'Arabic', 'Hindi', 'Turkish', 'Swedish', 'Swahili', 'Yoruba',
];

const ACCEPTED = ['.docx', '.pdf', '.epub', '.txt', '.rtf'];

function contextText(blocks: RichBlock[], count: number, fromEnd: boolean): string {
  const slice = fromEnd ? blocks.slice(-count) : blocks.slice(0, count);
  return slice.map(blockText).filter(Boolean).join('\n\n');
}

export default function TranslatePanel() {
  const [job, setJob] = useState<TranslationJob | null>(null);
  const [recent, setRecent] = useState<TranslationJob[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState(false);
  const runningRef = useRef(false);
  const jobRef = useRef<TranslationJob | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep a ref in step with state so the long-running loop always sees fresh data.
  const commit = useCallback((next: TranslationJob) => {
    jobRef.current = next;
    setJob(next);
    void saveJob(next);
  }, []);

  useEffect(() => {
    listJobs().then((jobs) => {
      if (jobs) setRecent(jobs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6));
    });
  }, [job?.id]);

  useEffect(() => () => { runningRef.current = false; }, []);

  // --- 1. upload -----------------------------------------------------------
  const handleFile = async (file: File) => {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED.includes(extension)) {
      setError(`Unsupported file: ${extension}. Upload .docx, .pdf, .epub, .txt or .rtf.`);
      return;
    }
    setBusy('Reading the manuscript…');
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/translate/prepare', { method: 'POST', body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not read the manuscript.');

      commit({
        id: `job_${Date.now().toString(36)}`,
        fileName: file.name,
        title: payload.title,
        author: payload.author ?? '',
        targetLanguage: 'Spanish',
        authorNotes: '',
        wordCount: payload.wordCount,
        sourceBlocks: payload.blocks,
        segments: payload.segments,
        brief: null,
        glossary: [],
        results: {},
        polishEnabled: true,
        updatedAt: Date.now(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(null);
    }
  };

  // --- 2. brief ------------------------------------------------------------
  const buildBrief = async () => {
    const current = jobRef.current;
    if (!current) return;
    setBusy('Reading the whole book to set the voice and glossary…');
    setError(null);
    try {
      const response = await fetch('/api/translate/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: current.sourceBlocks,
          targetLanguage: current.targetLanguage,
          title: current.title,
          author: current.author,
          authorNotes: current.authorNotes,
        }),
      });
      const payload = (await response.json()) as TranslationBrief & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not build the brief.');
      commit({ ...current, brief: payload, glossary: payload.glossary ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Brief failed.');
    } finally {
      setBusy(null);
    }
  };

  // --- 3. run --------------------------------------------------------------
  const translateSegment = async (current: TranslationJob, segment: TranslationSegment) => {
    const source = current.sourceBlocks.slice(segment.startBlock, segment.endBlock + 1);
    const previous = current.segments[segment.index - 1];
    const next = current.segments[segment.index + 1];
    const previousResult = previous ? current.results[previous.index] : undefined;

    const response = await fetch('/api/translate/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: source,
        startIndex: segment.startBlock,
        targetLanguage: current.targetLanguage,
        brief: current.brief,
        glossary: current.glossary,
        authorNotes: current.authorNotes,
        context: {
          precedingSource: previous
            ? contextText(current.sourceBlocks.slice(previous.startBlock, previous.endBlock + 1), 2, true)
            : '',
          precedingTarget: previousResult ? contextText(previousResult.blocks, 2, true) : '',
          followingSource: next
            ? contextText(current.sourceBlocks.slice(next.startBlock, next.endBlock + 1), 1, false)
            : '',
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Segment ${segment.index + 1} failed.`);
    return payload as { blocks: RichBlock[]; missing: number[] };
  };

  const polishSegment = async (current: TranslationJob, segment: TranslationSegment, blocks: RichBlock[]) => {
    const response = await fetch('/api/translate/polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks,
        startIndex: segment.startBlock,
        targetLanguage: current.targetLanguage,
        brief: current.brief,
        glossary: current.glossary,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Polish of segment ${segment.index + 1} failed.`);
    return payload as { blocks: RichBlock[]; missing: number[] };
  };

  const run = async () => {
    if (!jobRef.current || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);

    try {
      for (const segment of jobRef.current.segments) {
        if (!runningRef.current) break;
        const current = jobRef.current;
        const existing = current.results[segment.index];
        if (existing?.stage === 'done') continue;
        if (existing?.stage === 'translated' && !current.polishEnabled) continue;

        try {
          let blocks = existing?.blocks;
          let missing = existing?.missing ?? [];

          if (!blocks || existing?.stage === 'error' || existing?.stage === 'pending') {
            commit({
              ...current,
              results: { ...current.results, [segment.index]: { blocks: [], missing: [], stage: 'translating' } },
            });
            const translated = await translateSegment(jobRef.current!, segment);
            blocks = translated.blocks;
            missing = translated.missing ?? [];
            commit({
              ...jobRef.current!,
              results: {
                ...jobRef.current!.results,
                [segment.index]: { blocks, missing, stage: 'translated' },
              },
            });
          }

          if (!runningRef.current) break;

          if (jobRef.current!.polishEnabled) {
            commit({
              ...jobRef.current!,
              results: {
                ...jobRef.current!.results,
                [segment.index]: { blocks: blocks!, missing, stage: 'polishing' },
              },
            });
            const polished = await polishSegment(jobRef.current!, segment, blocks!);
            commit({
              ...jobRef.current!,
              results: {
                ...jobRef.current!.results,
                [segment.index]: { blocks: polished.blocks, missing, stage: 'done' },
              },
            });
          } else {
            commit({
              ...jobRef.current!,
              results: {
                ...jobRef.current!.results,
                [segment.index]: { blocks: blocks!, missing, stage: 'done' },
              },
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Segment failed.';
          commit({
            ...jobRef.current!,
            results: {
              ...jobRef.current!.results,
              [segment.index]: { blocks: [], missing: [], stage: 'error', error: message },
            },
          });
          setError(`${message} — the run continues; retry failed sections afterwards.`);
        }
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
  };

  const retryFailed = () => {
    const current = jobRef.current;
    if (!current) return;
    const results = { ...current.results };
    for (const [key, value] of Object.entries(results)) {
      if (value.stage === 'error') delete results[Number(key)];
    }
    commit({ ...current, results });
    void run();
  };

  // --- 4. export -----------------------------------------------------------
  const assembled = (current: TranslationJob): RichBlock[] =>
    current.segments.flatMap((segment) => {
      const result = current.results[segment.index];
      return result?.blocks?.length
        ? result.blocks
        : current.sourceBlocks.slice(segment.startBlock, segment.endBlock + 1);
    });

  const exportAs = async (format: string) => {
    const current = jobRef.current;
    if (!current) return;
    setBusy(`Building the ${format.toUpperCase()}…`);
    try {
      const response = await fetch('/api/translate/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: assembled(current),
          format,
          title: current.title,
          author: current.author,
          language: current.targetLanguage,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Export failed.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${current.title.replace(/\s+/g, '_')}_${current.targetLanguage.replace(/\s+/g, '_')}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };

  const progress = job ? jobProgress(job) : null;
  const canRun = Boolean(job && job.brief && !running);

  const setField = <K extends keyof TranslationJob>(key: K, value: TranslationJob[K]) => {
    if (!jobRef.current) return;
    commit({ ...jobRef.current, [key]: value });
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-10 bg-[#0A0A0B] space-y-6">
      <header className="border-b border-[#27272A]/40 pb-6">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-[#D4AF37] uppercase">
          <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
          Literary Translation
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
          Translate a Whole Manuscript
        </h1>
        <p className="text-sm text-[#71717A] max-w-2xl mt-1 leading-relaxed">
          Upload a book, and it is translated the way a publishing house does it: a voice-and-glossary brief drawn
          from the entire manuscript first, then chapter-aware passes that carry context forward, then a native
          editor pass that reads only the translation and removes anything that sounds translated.
        </p>
      </header>

      {error && (
        <div role="alert" className="p-3 rounded-xl bg-red-950/20 border border-red-500/25 text-red-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="text-[11px] leading-relaxed">{error}</span>
        </div>
      )}
      {busy && (
        <div className="p-3 rounded-xl bg-[#D4AF37]/8 border border-[#D4AF37]/25 text-[#D4AF37] flex items-center gap-2.5">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-[11px]">{busy}</span>
        </div>
      )}

      {!job ? (
        <>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className="border-2 border-dashed border-[#27272A] hover:border-[#D4AF37]/40 rounded-2xl p-14 text-center cursor-pointer transition"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED.join(',')}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = '';
              }}
            />
            <Upload className="w-8 h-8 text-[#D4AF37] mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-[#E4E4E7]">Drop your manuscript here</h3>
            <p className="text-[11px] text-[#71717A] mt-1.5">DOCX, PDF, EPUB, RTF or TXT — a full book is fine</p>
          </div>

          {recent.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider">
                Unfinished translations
              </h2>
              {recent.map((entry) => {
                const entryProgress = jobProgress(entry);
                return (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-3 p-3 bg-[#111114] border border-[#27272A] rounded-xl"
                  >
                    <button
                      type="button"
                      onClick={() => loadJob(entry.id).then((found) => found && commit(found))}
                      className="text-left min-w-0 flex-1 cursor-pointer"
                    >
                      <p className="text-xs font-medium text-white truncate">{entry.title}</p>
                      <p className="text-[10px] text-[#71717A] font-mono mt-0.5">
                        → {entry.targetLanguage} · {entryProgress.percent}% · {entry.wordCount.toLocaleString()} words
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteJob(entry.id).then(() => setRecent((r) => r.filter((j) => j.id !== entry.id)))}
                      className="p-2 text-zinc-600 hover:text-red-400 cursor-pointer"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
          {/* ---- left: setup ---- */}
          <div className="xl:col-span-2 space-y-4">
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-white truncate">{job.title}</h2>
                  <p className="text-[10px] text-[#71717A] font-mono mt-0.5">
                    {job.wordCount.toLocaleString()} words · {job.segments.length} sections · {job.fileName}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    stop();
                    jobRef.current = null;
                    setJob(null);
                  }}
                  className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white cursor-pointer shrink-0"
                >
                  Close
                </button>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5">
                  Translate into
                </span>
                <select
                  value={job.targetLanguage}
                  onChange={(e) => setField('targetLanguage', e.target.value)}
                  disabled={running}
                  className="w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] cursor-pointer focus:outline-none focus:border-[#D4AF37]/60 disabled:opacity-50"
                >
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5">
                  Instructions for the translator
                </span>
                <textarea
                  value={job.authorNotes}
                  onChange={(e) => setField('authorNotes', e.target.value)}
                  rows={3}
                  placeholder="e.g. keep the narrator's dry humour; the setting stays Scottish, don't relocate it; use usted between the sisters"
                  className="w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] placeholder-[#52525B] resize-y focus:outline-none focus:border-[#D4AF37]/60"
                />
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={job.polishEnabled}
                  onChange={(e) => setField('polishEnabled', e.target.checked)}
                  disabled={running}
                  className="accent-[#D4AF37]"
                />
                <span className="text-[11px] text-[#A1A1AA]">
                  Native-editor second pass <span className="text-[#52525B]">(doubles cost, removes translationese)</span>
                </span>
              </label>

              <button
                type="button"
                onClick={buildBrief}
                disabled={Boolean(busy) || running}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#18181B] border border-[#27272A] text-[#E4E4E7] hover:border-[#D4AF37]/40 disabled:opacity-40 font-semibold text-[11px] uppercase tracking-wider rounded-xl transition cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
                {job.brief ? 'Rebuild brief & glossary' : 'Step 1 — Build brief & glossary'}
              </button>
            </div>

            {job.brief && (
              <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-3">
                <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider">
                  Translation brief
                </h3>
                <dl className="space-y-2">
                  {([
                    ['Source', job.brief.detectedSourceLanguage],
                    ['Voice', job.brief.narrativeVoice],
                    ['Register', job.brief.register],
                    ['Formality', job.brief.formality],
                    ['Rhythm', job.brief.rhythmNotes],
                    ['Culture', job.brief.culturalNotes],
                    ['Watch for', job.brief.translatorGuidance],
                  ] as [string, string][])
                    .filter(([, value]) => value)
                    .map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-[9px] uppercase font-mono text-[#D4AF37]/70 tracking-wider">{label}</dt>
                        <dd className="text-[11px] text-[#A1A1AA] leading-relaxed">{value}</dd>
                      </div>
                    ))}
                </dl>

                <div>
                  <h4 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider mb-2">
                    Glossary — binding for the whole book ({job.glossary.length})
                  </h4>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {job.glossary.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <span className="text-[10px] text-[#71717A] font-mono truncate flex-1" title={entry.source}>
                          {entry.source}
                        </span>
                        <span className="text-[#52525B]">→</span>
                        <input
                          value={entry.keepAsIs ? entry.source : entry.target}
                          onChange={(e) => {
                            const next = [...job.glossary];
                            next[index] = { ...entry, target: e.target.value, keepAsIs: false };
                            setField('glossary', next);
                          }}
                          className="flex-1 min-w-0 bg-[#0D0D10] border border-[#27272A] rounded px-2 py-1 text-[10px] text-[#E4E4E7] focus:outline-none focus:border-[#D4AF37]/60"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = [...job.glossary];
                            next[index] = { ...entry, keepAsIs: !entry.keepAsIs };
                            setField('glossary', next);
                          }}
                          title="Keep this name untranslated"
                          className={`text-[9px] font-mono px-1.5 py-1 rounded border cursor-pointer shrink-0 ${
                            entry.keepAsIs
                              ? 'text-[#D4AF37] border-[#D4AF37]/40 bg-[#D4AF37]/10'
                              : 'text-[#52525B] border-[#27272A]'
                          }`}
                        >
                          keep
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setField('glossary', [...job.glossary, { source: '', target: '' } as GlossaryEntry])
                    }
                    className="mt-2 text-[10px] text-[#D4AF37] hover:underline cursor-pointer"
                  >
                    + Add a term
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ---- right: run ---- */}
          <div className="xl:col-span-3 space-y-4">
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider">
                  Step 2 — Translate
                </h3>
                <span className="text-[10px] font-mono text-[#D4AF37]">
                  {progress?.percent ?? 0}% · {progress?.wordsDone.toLocaleString() ?? 0} /{' '}
                  {job.wordCount.toLocaleString()} words
                </span>
              </div>

              <div className="h-1.5 bg-[#27272A] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#D4AF37] rounded-full transition-all duration-500"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {running ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#18181B] border border-[#27272A] text-[#E4E4E7] font-semibold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer hover:border-[#D4AF37]/40"
                  >
                    <Pause className="w-3.5 h-3.5" /> Pause after this section
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={run}
                    disabled={!canRun}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-30 disabled:pointer-events-none font-bold text-[11px] uppercase tracking-wider rounded-xl transition cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {progress && progress.translated > 0 ? 'Resume translation' : 'Start translating'}
                  </button>
                )}

                {progress && progress.errored > 0 && (
                  <button
                    type="button"
                    onClick={retryFailed}
                    disabled={running}
                    className="flex items-center gap-2 px-3 py-2.5 bg-red-950/30 border border-red-500/25 text-red-300 font-semibold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer disabled:opacity-40"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Retry {progress.errored} failed
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setPreview((v) => !v)}
                  className="flex items-center gap-2 px-3 py-2.5 bg-[#18181B] border border-[#27272A] text-zinc-300 font-semibold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer hover:text-white"
                >
                  <BookOpen className="w-3.5 h-3.5" /> {preview ? 'Hide' : 'Compare'}
                </button>
              </div>

              {!job.brief && (
                <p className="text-[11px] text-[#71717A] leading-relaxed">
                  Build the brief first — it is what keeps the voice and the names consistent across the whole book.
                </p>
              )}

              <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                {job.segments.map((segment) => {
                  const result = job.results[segment.index];
                  const stage = result?.stage ?? 'pending';
                  return (
                    <div
                      key={segment.index}
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg bg-[#0D0D10] border border-[#27272A]/60"
                    >
                      <span className="text-[9px] font-mono text-[#52525B] w-8 shrink-0">
                        {String(segment.index + 1).padStart(3, '0')}
                      </span>
                      <span className="text-[11px] text-[#A1A1AA] truncate flex-1">{segment.label}</span>
                      <span className="text-[9px] font-mono text-[#52525B] shrink-0">{segment.words}w</span>
                      <span className="shrink-0 w-16 text-right">
                        {stage === 'done' && <Check className="w-3.5 h-3.5 text-emerald-400 inline" />}
                        {stage === 'translated' && (
                          <span className="text-[9px] font-mono text-[#D4AF37]">drafted</span>
                        )}
                        {(stage === 'translating' || stage === 'polishing') && (
                          <Loader2 className="w-3.5 h-3.5 text-[#D4AF37] animate-spin inline" />
                        )}
                        {stage === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-400 inline" />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {preview && (
              <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4">
                <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider mb-3">
                  Original and translation
                </h3>
                <div className="grid grid-cols-2 gap-4 max-h-[420px] overflow-y-auto pr-1">
                  <div className="space-y-2">
                    {job.sourceBlocks.slice(0, 40).map((block, index) => (
                      <p key={index} className="text-[11px] text-[#71717A] leading-relaxed font-serif">
                        {blockText(block) || '❦'}
                      </p>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {assembled(job)
                      .slice(0, 40)
                      .map((block, index) => (
                        <p key={index} className="text-[11px] text-[#D1D1D6] leading-relaxed font-serif">
                          {blockText(block) || '❦'}
                        </p>
                      ))}
                  </div>
                </div>
              </div>
            )}

            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-3">
              <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider">
                Step 3 — Publish
              </h3>
              <p className="text-[11px] text-[#71717A] leading-relaxed">
                Exports the finished translation with its structure intact. Sections not yet translated keep the
                original text, so an early export is still a complete book.
              </p>
              <div className="flex flex-wrap gap-2">
                {(['docx', 'epub', 'pdf', 'txt'] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    onClick={() => exportAs(format)}
                    disabled={Boolean(busy)}
                    className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg hover:bg-[#D4AF37]/20 transition cursor-pointer disabled:opacity-40"
                  >
                    {format === 'txt' ? <FileText className="w-3 h-3" /> : <Download className="w-3 h-3" />}
                    {format}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="text-[10px] text-[#3F3F46] flex items-center gap-1.5">
        <Languages className="w-3 h-3" />
        Sections run one at a time so each one can see the translation before it.
      </p>
    </div>
  );
}
