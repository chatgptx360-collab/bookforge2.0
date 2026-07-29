import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  AudioLines,
  Check,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Upload,
} from 'lucide-react';
import VoicePicker, { useVoiceCatalogue, voiceLabel } from './tts/VoicePicker';
import {
  concatPcm,
  decodeWav,
  downloadBlob,
  encodeMp3,
  encodeWav,
  formatBytes,
  formatDuration,
  pcmDurationSeconds,
  safeFileName,
  silence,
} from '../utils/audio';
import {
  loadEngine,
  planChunks,
  readJson,
  speak,
  SpeechError,
  storeEngine,
  type Engine,
} from '../utils/speech';
import { clearSession, loadSession, savedAgo, saveSession } from '../utils/sessionStore';
import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES, voiceForEngine } from '../utils/kokoroVoices';
import { inspectGpu, type GpuVerdict } from '../utils/gpu';
import type { ParsedDocument, ParsedSection } from '../types';

const ENGINES = [
  { id: 'kokoro' as const, label: 'Kokoro \u00b7 free', hint: 'Runs locally in your browser. No key, no quota.' },
  { id: 'gemini' as const, label: 'Gemini \u00b7 directable', hint: 'Hosted, accepts a delivery instruction, needs a key.' },
];

const ACCEPTED = ['.docx', '.pdf', '.epub', '.txt', '.rtf'];

interface ChapterAudio {
  status: 'pending' | 'working' | 'done' | 'error';
  blob?: Blob;
  url?: string;
  seconds?: number;
  error?: string;
}

export default function AudiobookPanel() {
  const catalogue = useVoiceCatalogue();
  const [doc, setDoc] = useState<ParsedDocument | null>(null);
  const [fileName, setFileName] = useState('');
  const [voice, setVoice] = useState(() => (loadEngine() === 'kokoro' ? KOKORO_DEFAULT_VOICE : 'Sulafat'));
  const [style, setStyle] = useState('Read this warmly and unhurriedly, like an audiobook narrator');
  const [announceChapters, setAnnounceChapters] = useState(true);
  const [audio, setAudio] = useState<Record<number, ChapterAudio>>({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine>(() => loadEngine());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [gpu, setGpu] = useState<GpuVerdict | null>(null);

  useEffect(() => {
    void inspectGpu().then(setGpu);
  }, []);
  // Which sections to narrate. A table of contents is meaningless read aloud,
  // so it starts excluded; everything else starts in.
  const [included, setIncluded] = useState<Record<number, boolean>>({});
  const runningRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirrors `audio` so unmount can revoke every object URL without the cleanup
  // closing over a stale snapshot.
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const includedRef = useRef(included);
  includedRef.current = included;

  const releaseAudio = useCallback(() => {
    Object.values(audioRef.current).forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
    setAudio({});
  }, []);

  useEffect(
    () => () => {
      runningRef.current = false;
      Object.values(audioRef.current).forEach((entry) => entry.url && URL.revokeObjectURL(entry.url));
    },
    [],
  );

  // Pick the last run back up. A refresh in the middle of a book should cost
  // nothing — neither the audio already made nor the quota it took to make it.
  useEffect(() => {
    let cancelled = false;
    void loadSession('audiobook').then((saved) => {
      if (cancelled || !saved) {
        setRestoring(false);
        return;
      }
      setDoc(saved.doc as ParsedDocument);
      setFileName(saved.fileName);
      const savedEngine = saved.engine ?? loadEngine();
      setEngine(savedEngine);
      storeEngine(savedEngine);
      setVoice(voiceForEngine(savedEngine, saved.voice));
      setStyle(saved.style);
      setAnnounceChapters(saved.announceChapters);
      setIncluded(
        saved.included ??
          Object.fromEntries(
            (saved.doc as ParsedDocument).sections.map((section, index) => [index, section.type !== 'toc']),
          ),
      );
      setAudio(
        Object.fromEntries(
          Object.entries(saved.chapters).map(([index, chapter]) => [
            Number(index),
            {
              status: 'done' as const,
              blob: chapter.blob,
              url: URL.createObjectURL(chapter.blob),
              seconds: chapter.seconds,
            },
          ]),
        ),
      );
      setSavedAt(saved.savedAt);
      setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const chapters = doc?.sections ?? [];

  // Checkpoint whenever anything worth keeping changes. Debounced so a burst of
  // finished chapters writes once, and skipped while restoring so the restore
  // does not immediately save what it just read.
  useEffect(() => {
    if (restoring || !doc) return;
    const timer = setTimeout(() => {
      const chapterSaves: Record<number, { blob: Blob; seconds: number }> = {};
      for (const [index, entry] of Object.entries(audioRef.current)) {
        if (entry.status === 'done' && entry.blob) {
          chapterSaves[Number(index)] = { blob: entry.blob, seconds: entry.seconds ?? 0 };
        }
      }
      const stamp = Date.now();
      void saveSession('audiobook', {
        fileName,
        engine,
        doc,
        voice,
        style,
        announceChapters,
        included,
        chapters: chapterSaves,
        savedAt: stamp,
      }).then(() => setSavedAt(stamp));
    }, 800);
    return () => clearTimeout(timer);
  }, [restoring, doc, fileName, voice, style, announceChapters, engine, included, audio]);

  // The picker is engine-agnostic; only the catalogue behind it changes.
  const activeCatalogue =
    engine === 'kokoro'
      ? { voices: KOKORO_VOICES, model: 'Kokoro-82M', available: true }
      : catalogue;

  // Said plainly, because it decides whether a book takes an hour or a night.
  const gpuNote =
    gpu === null
      ? ''
      : gpu.usable
        ? ' Your graphics card is available, so narration runs fast.'
        : gpu.reason === 'software'
          ? ' Your browser reports WebGPU as software only, so this runs on the CPU — several times slower. Turning on graphics acceleration in your browser, or updating your graphics driver, would fix it.'
          : ' No graphics acceleration here, so this runs on the CPU — several times slower, but it still works.';

  const handleFile = async (file: File) => {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED.includes(extension)) {
      setError(`Unsupported file: ${extension}. Upload .docx, .pdf, .epub, .txt or .rtf.`);
      return;
    }
    setStatus('Reading the book…');
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/book/parse-file', { method: 'POST', body: form });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(String(payload.error ?? 'Could not read the book.'));
      const parsed = payload as unknown as ParsedDocument;
      setDoc(parsed);
      setFileName(file.name);
      setIncluded(Object.fromEntries(parsed.sections.map((section, index) => [index, section.type !== 'toc'])));
      releaseAudio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setStatus(null);
    }
  };

  const speakChapter = useCallback(
    async (section: ParsedSection, index: number) => {
      const body = announceChapters && section.title ? `${section.title}.\n\n${section.content}` : section.content;
      const chunks = await planChunks(body);
      // Position within the run, not within the file — skipped sections are
      // not being narrated and should not inflate the total.
      const order = chapters.map((_, i) => i).filter((i) => includedRef.current[i] !== false);
      const place = order.indexOf(index) + 1;

      const parts: Int16Array[] = [];
      let sampleRate = 24000;

      for (let piece = 0; piece < chunks.length; piece++) {
        if (!runningRef.current) throw new Error('Stopped.');
        const where = `Section ${place || index + 1} of ${order.length || chapters.length} — part ${piece + 1}/${chunks.length}`;
        setStatus(where);
        const payload = await speak(chunks[piece], {
          voice,
          style,
          engine,
          onModelProgress: (fraction) =>
            setStatus(`Downloading the local voice model — ${Math.round(fraction * 100)}%`),
          shouldContinue: () => runningRef.current,
          // A quota window is a wait, not a failure — say so rather than
          // leaving the run looking stalled.
          onThrottled: (secondsLeft) =>
            setStatus(`${where} · rate limited, resuming in ${secondsLeft}s`),
        });
        sampleRate = payload.sampleRate ?? sampleRate;
        parts.push(payload.pcm);
        if (piece < chunks.length - 1) parts.push(silence(0.4, sampleRate));
      }

      const pcm = concatPcm([silence(0.3, sampleRate), ...parts, silence(0.8, sampleRate)]);
      const blob = encodeWav(pcm, sampleRate);
      return { blob, seconds: pcmDurationSeconds(pcm, sampleRate) };
    },
    [announceChapters, chapters.length, engine, style, voice],
  );

  const run = async () => {
    if (!doc || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);

    try {
      for (let index = 0; index < chapters.length; index++) {
        if (!runningRef.current) break;
        if (included[index] === false) continue;
        if (audio[index]?.status === 'done') continue;

        setAudio((prev) => ({ ...prev, [index]: { status: 'working' } }));
        try {
          const { blob, seconds } = await speakChapter(chapters[index], index);
          setAudio((prev) => ({
            ...prev,
            [index]: { status: 'done', blob, url: URL.createObjectURL(blob), seconds },
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Chapter failed.';
          if (message === 'Stopped.') break;
          setAudio((prev) => ({ ...prev, [index]: { status: 'error', error: message } }));

          // An exhausted quota will fail every remaining chapter too, so stop
          // rather than grinding through them. The server's message already
          // explains the allowance and when it resets.
          if (err instanceof SpeechError && err.status === 429) {
            setError(`${message} The run stopped here; press Continue narrating to pick it up.`);
            break;
          }
          setError(`${message} — the run continues; retry the failed chapters afterwards.`);
        }
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setStatus(null);
    }
  };

  const retryFailed = () => {
    setAudio((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(next)) {
        if (value.status === 'error') delete next[Number(key)];
      }
      return next;
    });
    void run();
  };


  /**
   * Regenerate one section, keeping everything else.
   *
   * A chapter can come out wrong — a mispronunciation, a clipped passage, a
   * voice changed after the fact — and until now the only remedy was to close
   * the book and narrate all of it again.
   */
  const redoChapter = async (index: number) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);

    setAudio((prev) => {
      // The old clip is about to be replaced, so let its object URL go.
      if (prev[index]?.url) URL.revokeObjectURL(prev[index].url!);
      return { ...prev, [index]: { status: 'working' } };
    });

    try {
      const { blob, seconds } = await speakChapter(chapters[index], index);
      setAudio((prev) => ({
        ...prev,
        [index]: { status: 'done', blob, url: URL.createObjectURL(blob), seconds },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That section failed.';
      // Stopping mid-redo leaves the section as it was before: not done, not
      // broken, just waiting.
      setAudio((prev) => ({
        ...prev,
        [index]: message === 'Stopped.' ? { status: 'pending' } : { status: 'error', error: message },
      }));
      if (message !== 'Stopped.') setError(message);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setStatus(null);
    }
  };

  const downloadChapter = async (index: number, format: 'wav' | 'mp3') => {
    const entry = audio[index];
    if (!entry?.blob) return;
    const base = `${String(index + 1).padStart(2, '0')}_${safeFileName(chapters[index].title, 'chapter')}`;
    if (format === 'wav') {
      downloadBlob(entry.blob, `${base}.wav`);
      return;
    }
    setStatus('Encoding MP3…');
    try {
      const { pcm, sampleRate } = await decodeWav(entry.blob);
      downloadBlob(await encodeMp3(pcm, sampleRate), `${base}.mp3`);
    } catch (err) {
      // Without this the rejection was unhandled and the click looked ignored.
      setError(err instanceof Error ? `MP3 encoding failed: ${err.message}` : 'MP3 encoding failed.');
    } finally {
      setStatus(null);
    }
  };

  const downloadAll = async (format: 'wav' | 'mp3') => {
    const done = chosen.filter((index) => audio[index]?.blob);
    if (done.length === 0) return;
    setStatus(`Packaging ${done.length} chapters…`);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const index of done) {
        const base = `${String(index + 1).padStart(2, '0')}_${safeFileName(chapters[index].title, 'chapter')}`;
        const blob = audio[index].blob!;
        if (format === 'wav') {
          zip.file(`${base}.wav`, blob);
        } else {
          setStatus(`Encoding chapter ${index + 1} to MP3…`);
          const { pcm, sampleRate } = await decodeWav(blob);
          zip.file(`${base}.mp3`, await encodeMp3(pcm, sampleRate));
        }
      }
      const archive = await zip.generateAsync({ type: 'blob' });
      downloadBlob(archive, `${safeFileName(doc?.title ?? 'audiobook')}_${format}.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Packaging failed.');
    } finally {
      setStatus(null);
    }
  };

  const isIn = (index: number) => included[index] !== false;
  const chosen = chapters.map((_, index) => index).filter(isIn);
  const completed = chosen.filter((index) => audio[index]?.status === 'done').length;
  const totalSeconds = chosen.reduce((sum, index) => sum + (audio[index]?.seconds ?? 0), 0);
  const failed = chosen.filter((index) => audio[index]?.status === 'error').length;
  const percent = chosen.length === 0 ? 0 : Math.round((completed / chosen.length) * 100);

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-10 bg-[#0A0A0B] space-y-6">
      <header className="border-b border-[#27272A]/40 pb-6">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-[#D4AF37] uppercase">
          <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
          Audiobook Studio
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
          Turn a Book into an Audiobook
        </h1>
        <p className="text-sm text-[#71717A] max-w-2xl mt-1 leading-relaxed">
          Upload a manuscript, choose a narrator, and it is read chapter by chapter. Download each chapter or the
          whole book as WAV or MP3.
        </p>
        {catalogue?.error ? (
          <div className="mt-4 p-3 rounded-xl bg-red-950/20 border border-red-500/25 text-red-300 text-[11px] leading-relaxed max-w-2xl">
            The voice list could not be loaded — {catalogue.error} Reload the page to try again.
          </div>
        ) : (
          catalogue &&
          !catalogue.available && (
            <div className="mt-4 p-3 rounded-xl bg-amber-950/20 border border-amber-500/25 text-amber-300 text-[11px] leading-relaxed max-w-2xl">
              Narration needs <code className="font-mono">GEMINI_API_KEY</code> set on the deployment.
            </div>
          )
        )}
      </header>

      {error && (
        <div role="alert" className="p-3 rounded-xl bg-red-950/20 border border-red-500/25 text-red-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="text-[11px] leading-relaxed">{error}</span>
        </div>
      )}
      {status && (
        <div className="p-3 rounded-xl bg-[#D4AF37]/8 border border-[#D4AF37]/25 text-[#D4AF37] flex items-center gap-2.5">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-[11px]">{status}</span>
        </div>
      )}

      {restoring ? (
        // Avoids flashing the drop zone before a saved run is read back.
        <div className="border-2 border-dashed border-[#27272A] rounded-2xl p-14 text-center">
          <Loader2 className="w-5 h-5 text-[#52525B] mx-auto animate-spin" />
        </div>
      ) : !doc ? (
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
          <h3 className="text-sm font-semibold text-[#E4E4E7]">Drop your book here</h3>
          <p className="text-[11px] text-[#71717A] mt-1.5">DOCX, PDF, EPUB, RTF or TXT</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
          <div className="xl:col-span-2 space-y-4">
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-white truncate">{doc.title}</h2>
                  <p className="text-[10px] text-[#71717A] font-mono mt-0.5">
                    {chapters.length} chapters · {fileName}
                  </p>
                  {savedAt && (
                    <p className="text-[10px] text-emerald-400/70 font-mono mt-1 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Saved {savedAgo(savedAt)} — safe to refresh
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      completed > 0 &&
                      !window.confirm(
                        `Close "${doc.title}"? The ${completed} narrated chapter${completed === 1 ? '' : 's'} will be discarded.`,
                      )
                    ) {
                      return;
                    }
                    runningRef.current = false;
                    setDoc(null);
                    setFileName('');
                    setSavedAt(null);
                    releaseAudio();
                    void clearSession('audiobook');
                  }}
                  className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white cursor-pointer shrink-0"
                >
                  Close
                </button>
              </div>

              {/* Kokoro takes a voice and nothing else, so offering a delivery
                  instruction it silently ignores would be a lie. */}
              {engine === 'gemini' && (
                <label className="block">
                  <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5">
                    Delivery
                  </span>
                  <input
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] focus:outline-none focus:border-[#D4AF37]/60"
                  />
                </label>
              )}

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={announceChapters}
                  onChange={(e) => setAnnounceChapters(e.target.checked)}
                  className="accent-[#D4AF37]"
                />
                <span className="text-[11px] text-[#A1A1AA]">Read the chapter title before each chapter</span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider w-full mb-0.5">
                Engine
              </span>
              {ENGINES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setEngine(option.id);
                    storeEngine(option.id);
                    setVoice(option.id === 'kokoro' ? KOKORO_DEFAULT_VOICE : 'Sulafat');
                  }}
                  title={option.hint}
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-semibold uppercase tracking-wider border cursor-pointer transition ${
                    engine === option.id
                      ? 'text-[#D4AF37] border-[#D4AF37]/40 bg-[#D4AF37]/10'
                      : 'text-[#71717A] border-[#27272A] hover:text-[#A1A1AA]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
              <p className="text-[10px] text-[#52525B] leading-relaxed w-full mt-1">
                {engine === 'kokoro'
                  ? `Runs on this device. Free and unlimited, no key — the voice model downloads once and is then cached. It cannot be given a delivery instruction.${
                      gpuNote
                    }`
                  : 'Runs on Google\u2019s servers. Takes a delivery instruction, but needs an API key and is limited by its quota.'}
              </p>
            </div>

            <div>
              <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider mb-2">
                Narrator — {voiceLabel(activeCatalogue, voice)}
              </h3>
              {activeCatalogue && (
                <VoicePicker voices={activeCatalogue.voices} value={voice} onChange={setVoice} disabled={running} engine={engine} />
              )}
            </div>
          </div>

          <div className="xl:col-span-3 space-y-4">
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider">
                  Narration
                </h3>
                <span className="text-[10px] font-mono text-[#D4AF37]">
                  {completed}/{chosen.length} sections · {formatDuration(totalSeconds)}
                </span>
              </div>

              <div className="h-1.5 bg-[#27272A] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#D4AF37] rounded-full transition-all duration-500"
                  style={{ width: `${percent}%` }}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {running ? (
                  <button
                    type="button"
                    onClick={() => {
                      runningRef.current = false;
                    }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#18181B] border border-[#27272A] text-[#E4E4E7] font-semibold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer"
                  >
                    <Pause className="w-3.5 h-3.5" /> Stop after this chapter
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={run}
                    disabled={chosen.length === 0}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-30 disabled:pointer-events-none font-bold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> {completed > 0 ? 'Continue narrating' : 'Narrate the book'}
                  </button>
                )}
                {failed > 0 && !running && (
                  <button
                    type="button"
                    onClick={retryFailed}
                    className="flex items-center gap-2 px-3 py-2.5 bg-red-950/30 border border-red-500/25 text-red-300 font-semibold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Retry {failed}
                  </button>
                )}
                {completed > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => downloadAll('wav')}
                      className="flex items-center gap-1.5 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg cursor-pointer"
                    >
                      <Archive className="w-3 h-3" /> All WAV
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadAll('mp3')}
                      className="flex items-center gap-1.5 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg cursor-pointer"
                    >
                      <Archive className="w-3 h-3" /> All MP3
                    </button>
                  </>
                )}
              </div>


              <div className="flex items-center gap-2 flex-wrap text-[10px]">
                <span className="font-mono uppercase tracking-wider text-[#71717A]">Include</span>
                {[
                  { label: 'Everything', pick: () => chapters.map((_, i) => i) },
                  { label: 'Chapters only', pick: () => chapters.map((s, i) => (s.type === 'chapter' ? i : -1)).filter((i) => i >= 0) },
                  { label: 'Nothing', pick: () => [] },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={running}
                    onClick={() => {
                      const keep = new Set(preset.pick());
                      setIncluded(Object.fromEntries(chapters.map((_, i) => [i, keep.has(i)])));
                    }}
                    className="px-2 py-1 rounded-lg border border-[#27272A] text-[#71717A] hover:text-[#A1A1AA] cursor-pointer disabled:opacity-40 disabled:pointer-events-none uppercase tracking-wider font-semibold"
                  >
                    {preset.label}
                  </button>
                ))}
                <span className="text-[#52525B] font-mono ml-auto">
                  {chosen.length} of {chapters.length} selected
                </span>
              </div>

              <div className="max-h-[420px] overflow-y-auto space-y-1.5 pr-1">
                {chapters.map((section, index) => {
                  const entry = audio[index];
                  const inRun = isIn(index);
                  return (
                    <div
                      key={index}
                      className={`p-2.5 rounded-lg border transition ${
                        inRun ? 'bg-[#0D0D10] border-[#27272A]/60' : 'bg-transparent border-[#27272A]/30 opacity-45'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={inRun}
                          disabled={running}
                          aria-label={`Narrate ${section.title}`}
                          onChange={(e) => setIncluded((prev) => ({ ...prev, [index]: e.target.checked }))}
                          className="accent-[#D4AF37] shrink-0 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <span className="text-[9px] font-mono text-[#52525B] w-7 shrink-0">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="text-[11px] text-[#A1A1AA] truncate flex-1">
                          {section.title}
                          {section.type !== 'chapter' && (
                            <span className="ml-1.5 text-[9px] font-mono uppercase text-[#52525B]">{section.type}</span>
                          )}
                        </span>
                        {entry?.seconds && (
                          <span className="text-[9px] font-mono text-[#52525B] shrink-0">
                            {formatDuration(entry.seconds)}
                          </span>
                        )}
                        <span className="shrink-0 w-5 text-right">
                          {entry?.status === 'done' && <Check className="w-3.5 h-3.5 text-emerald-400 inline" />}
                          {entry?.status === 'working' && (
                            <Loader2 className="w-3.5 h-3.5 text-[#D4AF37] animate-spin inline" />
                          )}
                          {entry?.status === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-400 inline" />}
                        </span>
                      </div>
                      {entry?.status === 'done' && entry.url && (
                        <div className="flex items-center gap-2 mt-2">
                          <audio src={entry.url} controls className="h-8 flex-1" />
                          <button
                            type="button"
                            onClick={() => downloadChapter(index, 'wav')}
                            className="text-[9px] font-mono uppercase text-[#D4AF37] hover:underline cursor-pointer shrink-0"
                          >
                            wav
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadChapter(index, 'mp3')}
                            className="text-[9px] font-mono uppercase text-[#D4AF37] hover:underline cursor-pointer shrink-0"
                          >
                            mp3
                          </button>
                          <button
                            type="button"
                            onClick={() => redoChapter(index)}
                            disabled={running}
                            title={`Narrate "${section.title}" again`}
                            aria-label={`Redo ${section.title}`}
                            className="flex items-center gap-1 text-[9px] font-mono uppercase text-[#71717A] hover:text-[#D4AF37] cursor-pointer shrink-0 disabled:opacity-40 disabled:pointer-events-none"
                          >
                            <RotateCcw className="w-3 h-3" /> redo
                          </button>
                        </div>
                      )}
                      {entry?.status === 'error' && (
                        <div className="flex items-start gap-2 mt-1.5">
                          <p className="text-[10px] text-red-400 font-mono flex-1 break-words">{entry.error}</p>
                          <button
                            type="button"
                            onClick={() => redoChapter(index)}
                            disabled={running}
                            title={`Try "${section.title}" again`}
                            aria-label={`Redo ${section.title}`}
                            className="flex items-center gap-1 text-[9px] font-mono uppercase text-[#D4AF37] hover:underline cursor-pointer shrink-0 disabled:opacity-40 disabled:pointer-events-none"
                          >
                            <RotateCcw className="w-3 h-3" /> retry
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {completed > 0 && (
              <p className="text-[10px] text-[#3F3F46] flex items-center gap-1.5">
                <AudioLines className="w-3 h-3" />
                {formatBytes(
                  Object.values(audio).reduce((sum, entry) => sum + (entry.blob?.size ?? 0), 0),
                )}{' '}
                of audio generated. MP3 is encoded on download and is roughly a tenth the size.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
