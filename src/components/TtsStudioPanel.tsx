import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AudioLines, Check, Download, Loader2, Sparkles, Square } from 'lucide-react';
import VoicePicker, { useVoiceCatalogue, voiceLabel } from './tts/VoicePicker';
import { loadEngine, planChunks, speak, storeEngine, type Engine } from '../utils/speech';
import { loadSession, savedAgo, saveSession } from '../utils/sessionStore';
import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES, voiceForEngine } from '../utils/kokoroVoices';
import { inspectGpu, type GpuVerdict } from '../utils/gpu';
import {
  concatPcm,
  downloadBlob,
  encodeMp3,
  encodeWav,
  formatBytes,
  formatDuration,
  pcmDurationSeconds,
  safeFileName,
  silence,
} from '../utils/audio';

const ENGINES = [
  { id: 'kokoro' as const, label: 'Kokoro \u00b7 free', hint: 'Runs locally in your browser. No key, no quota.' },
  { id: 'gemini' as const, label: 'Gemini \u00b7 directable', hint: 'Hosted, accepts a delivery instruction, needs a key.' },
];

const STYLE_PRESETS = [
  { label: 'Plain read', value: '' },
  { label: 'Warm narrator', value: 'Read this warmly and unhurriedly, like an audiobook narrator' },
  { label: 'Bright and upbeat', value: 'Read this brightly and energetically' },
  { label: 'Calm and measured', value: 'Read this calmly, slowly and clearly' },
  { label: 'Intimate', value: 'Read this quietly and close, almost confiding' },
  { label: 'Dramatic', value: 'Read this dramatically, with tension and weight' },
];

export default function TtsStudioPanel() {
  const catalogue = useVoiceCatalogue();
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(() => (loadEngine() === 'kokoro' ? KOKORO_DEFAULT_VOICE : 'Sulafat'));
  const [style, setStyle] = useState('');
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<{ pcm: Int16Array; sampleRate: number; url: string } | null>(null);
  const [encoding, setEncoding] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine>(() => loadEngine());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [gpu, setGpu] = useState<GpuVerdict | null>(null);

  useEffect(() => {
    void inspectGpu().then(setGpu);
  }, []);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cancelRef = useRef(false);

  // The passage and the audio made from it both come back after a refresh.
  useEffect(() => {
    let cancelled = false;
    void loadSession('speech').then((saved) => {
      if (cancelled || !saved) {
        setRestoring(false);
        return;
      }
      setText(saved.text);
      const savedEngine = saved.engine ?? loadEngine();
      setEngine(savedEngine);
      storeEngine(savedEngine);
      setVoice(voiceForEngine(savedEngine, saved.voice));
      setStyle(saved.style);
      setSpeed(saved.speed ?? 1);
      if (saved.audio) {
        const pcm = new Int16Array(saved.audio.pcm);
        setAudio({ pcm, sampleRate: saved.audio.sampleRate, url: URL.createObjectURL(encodeWav(pcm, saved.audio.sampleRate)) });
      }
      setSavedAt(saved.savedAt);
      setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (restoring || (!text.trim() && !audio)) return;
    const timer = setTimeout(() => {
      const stamp = Date.now();
      void saveSession('speech', {
        text,
        engine,
        voice,
        style,
        speed,
        audio: audio ? { pcm: audio.pcm, sampleRate: audio.sampleRate } : undefined,
        savedAt: stamp,
      }).then(() => setSavedAt(stamp));
    }, 800);
    return () => clearTimeout(timer);
  }, [restoring, text, voice, style, speed, engine, audio]);

  // The picker is engine-agnostic; only the catalogue behind it changes.
  const activeCatalogue =
    engine === 'kokoro'
      ? { voices: KOKORO_VOICES, model: 'Kokoro-82M', available: true }
      : catalogue;

  // Said plainly, because it decides whether a book takes an hour or a night.
  // Threads are what decides CPU speed, so report the real number rather than
  // a vague promise. One thread means the page is not cross-origin isolated.
  const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0;
  const isolated = typeof window !== 'undefined' && window.crossOriginIsolated;
  const threadNote = isolated
    ? ` using ${Math.max(1, Math.min(cores - 1, 8))} of your ${cores} CPU cores`
    : ' on a single CPU core';

  const gpuNote =
    gpu === null
      ? ''
      : gpu.usable
        ? ' Your graphics card is available, so narration runs fast.'
        : gpu.reason === 'software'
          ? ` Your browser reports WebGPU as software only, so this runs${threadNote}. Turning on graphics acceleration, or updating your graphics driver, would fix it.`
          : gpu.reason === 'device-failed'
            ? ` Your graphics driver offered a card but would not open it for us, so this runs${threadNote}. That usually means the driver is older than the browser expects.`
            : ` No graphics acceleration here, so this runs${threadNote}.`;

  const characters = text.length;
  // Roughly fourteen characters a second at the voice's own pace; speeding it
  // up shortens the clip in proportion, so the estimate has to follow or it
  // quietly contradicts the slider sitting next to it.
  const estimatedSeconds = Math.round(characters / 14 / (engine === 'kokoro' ? speed : 1));

  const generate = async () => {
    if (!text.trim()) return;
    cancelRef.current = false;
    setError(null);
    setBusy('Planning the read…');
    setAudio((previous) => {
      if (previous) URL.revokeObjectURL(previous.url);
      return null;
    });

    try {
      const chunks = await planChunks(text);
      const parts: Int16Array[] = [];
      let sampleRate = 24000;

      for (let index = 0; index < chunks.length; index++) {
        if (cancelRef.current) break;
        const where = `Speaking part ${index + 1} of ${chunks.length}…`;
        setBusy(where);
        let payload;
        try {
          payload = await speak(chunks[index], {
            voice,
            style,
            engine,
            speed,
            onModelProgress: (fraction) =>
              setBusy(`Downloading the local voice model — ${Math.round(fraction * 100)}%`),
            shouldContinue: () => !cancelRef.current,
            onThrottled: (secondsLeft) => setBusy(`Rate limited — resuming in ${secondsLeft}s`),
          });
        } catch (err) {
          // Pressing stop is a choice, not a failure: keep whatever was already
          // spoken instead of discarding it and reporting an error.
          if (err instanceof Error && err.message === 'Stopped.') break;
          throw err;
        }
        sampleRate = payload.sampleRate ?? sampleRate;
        parts.push(payload.pcm);
        if (index < chunks.length - 1) parts.push(silence(0.35, sampleRate));
      }

      if (parts.length === 0) {
        // Stopping before the first passage finished simply leaves nothing.
        if (cancelRef.current) return;
        throw new Error('Nothing was generated.');
      }
      const pcm = concatPcm(parts);
      const url = URL.createObjectURL(encodeWav(pcm, sampleRate));
      setAudio({ pcm, sampleRate, url });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speech generation failed.');
    } finally {
      setBusy(null);
    }
  };

  const download = async (format: 'wav' | 'mp3') => {
    if (!audio) return;
    const name = safeFileName(text.slice(0, 48), 'speech');
    if (format === 'wav') {
      downloadBlob(encodeWav(audio.pcm, audio.sampleRate), `${name}.wav`);
      return;
    }
    setEncoding('Encoding MP3…');
    try {
      const blob = await encodeMp3(audio.pcm, audio.sampleRate, 128, (fraction) =>
        setEncoding(`Encoding MP3… ${Math.round(fraction * 100)}%`),
      );
      downloadBlob(blob, `${name}.mp3`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MP3 encoding failed.');
    } finally {
      setEncoding(null);
    }
  };

  const duration = useMemo(
    () => (audio ? pcmDurationSeconds(audio.pcm, audio.sampleRate) : 0),
    [audio],
  );

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-10 bg-[#0A0A0B] space-y-6">
      <header className="border-b border-[#27272A]/40 pb-6">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-[#D4AF37] uppercase">
          <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
          Speech Studio
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
          Text to Speech
        </h1>
        <p className="text-sm text-[#71717A] max-w-2xl mt-1 leading-relaxed">
          Paste any text, pick a voice, and generate speech. Download it as WAV for editing or MP3 for publishing.
        </p>
        {catalogue?.error ? (
          <div className="mt-4 p-3 rounded-xl bg-red-950/20 border border-red-500/25 text-red-300 text-[11px] leading-relaxed max-w-2xl">
            The voice list could not be loaded — {catalogue.error} Reload the page to try again.
          </div>
        ) : (
          catalogue &&
          !catalogue.available && (
            <div className="mt-4 p-3 rounded-xl bg-amber-950/20 border border-amber-500/25 text-amber-300 text-[11px] leading-relaxed max-w-2xl">
              Speech needs <code className="font-mono">GEMINI_API_KEY</code> set on the deployment. The converter and
              reader work without it.
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

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <div className="xl:col-span-3 space-y-4">
          <label className="block">
            <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5">
              Text to speak
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              placeholder="Paste a paragraph, a chapter, a script…"
              className="w-full bg-[#0D0D10] border border-[#27272A] rounded-xl px-3.5 py-3 text-sm text-[#E4E4E7] placeholder-[#52525B] leading-relaxed resize-y focus:outline-none focus:border-[#D4AF37]/60"
            />
          </label>
          <div className="flex items-center justify-between text-[10px] font-mono text-[#71717A]">
            <span>{characters.toLocaleString()} characters</span>
            <span className="flex items-center gap-3">
              {savedAt && (
                <span className="text-emerald-400/70 flex items-center gap-1">
                  <Check className="w-3 h-3" /> Saved {savedAgo(savedAt)}
                </span>
              )}
              ≈ {formatDuration(estimatedSeconds)} of audio
            </span>
          </div>

          {/* The hosted engine has no tempo control, so the slider appears only
              for the one that does — the mirror of Delivery below. */}
          {engine === 'kokoro' && (
            <label className="block">
              <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider flex items-center justify-between mb-1.5">
                <span>Pace</span>
                <span className="text-[#D4AF37] font-bold">{speed.toFixed(2)}×</span>
              </span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={speed}
                aria-label="Speaking pace"
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-full accent-[#D4AF37] cursor-pointer"
              />
              <span className="mt-1 block text-[10px] text-[#52525B]">
                Tempo only — the voice does not change pitch.{' '}
                {speed !== 1 && (
                  <button type="button" onClick={() => setSpeed(1)} className="text-[#D4AF37] underline cursor-pointer">
                    Reset
                  </button>
                )}
              </span>
            </label>
          )}

          {/* Kokoro takes a voice and nothing else, so a delivery instruction
              it silently ignores has no place on screen. */}
          {engine === 'gemini' && (
            <>
            <label className="block">
              <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5">
                Delivery
              </span>
              <select
                value={STYLE_PRESETS.some((preset) => preset.value === style) ? style : 'custom'}
                onChange={(e) => setStyle(e.target.value === 'custom' ? style : e.target.value)}
                className="w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] cursor-pointer focus:outline-none focus:border-[#D4AF37]/60"
              >
                {STYLE_PRESETS.map((preset) => (
                  <option key={preset.label} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <input
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="Or describe the delivery yourself — e.g. weary, amused, almost whispering"
              className="w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] placeholder-[#52525B] focus:outline-none focus:border-[#D4AF37]/60"
            />
            </>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={generate}
              disabled={!text.trim() || Boolean(busy)}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-30 disabled:pointer-events-none font-bold text-[11px] uppercase tracking-wider rounded-xl transition cursor-pointer"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {busy ?? 'Generate speech'}
            </button>
            {busy && (
              <button
                type="button"
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="px-4 py-3 bg-[#18181B] border border-[#27272A] text-zinc-300 rounded-xl cursor-pointer"
                title="Stop"
              >
                <Square className="w-4 h-4" />
              </button>
            )}
          </div>

          {audio && (
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider flex items-center gap-1.5">
                  <AudioLines className="w-3.5 h-3.5 text-[#D4AF37]" /> Result
                </h3>
                <span className="text-[10px] font-mono text-[#71717A]">
                  {formatDuration(duration)} · {formatBytes(audio.pcm.length * 2 + 44)} WAV
                </span>
              </div>
              <audio ref={audioRef} src={audio.url} controls className="w-full" />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => download('wav')}
                  className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg hover:bg-[#D4AF37]/20 transition cursor-pointer"
                >
                  <Download className="w-3 h-3" /> WAV
                </button>
                <button
                  type="button"
                  onClick={() => download('mp3')}
                  disabled={Boolean(encoding)}
                  className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg hover:bg-[#D4AF37]/20 transition cursor-pointer disabled:opacity-40"
                >
                  {encoding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                  {encoding ?? 'MP3'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="xl:col-span-2">
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

          <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider mb-2">
            Voice — {voiceLabel(activeCatalogue, voice)}
          </h3>
          {activeCatalogue ? (
            <VoicePicker voices={activeCatalogue.voices} value={voice} onChange={setVoice} disabled={Boolean(busy)} engine={engine} />
          ) : (
            <div className="p-8 text-center border border-dashed border-[#27272A] rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin text-[#52525B] mx-auto" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
