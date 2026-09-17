import { useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Download, FileSpreadsheet, Loader2, Package, Square } from 'lucide-react';
import VoicePicker from './tts/VoicePicker';
import { KOKORO_VOICES } from '../utils/kokoroVoices';
import { loadEngine, speak, type Engine } from '../utils/speech';
import { encodeMp3, encodeWav, formatBytes } from '../utils/audio';
import { columnValues, parseCsv, parseOverrides, planBank, SLOT } from '../utils/lineBank';

/**
 * Generates a bank of short clips in one run.
 *
 * TTS Studio makes one recording at a time, which is the wrong shape for
 * anything that speaks on demand — a game calling a goal, an app reading a
 * list. Those need hundreds of small files prepared in advance, because
 * generating at the moment of the event costs about a second per second of
 * audio and arrives late.
 *
 * So: paste a list or a CSV, write the lines, get a ZIP with a manifest. The
 * planning is in utils/lineBank.ts and is tested there; this is the driving.
 */

type Phase = 'idle' | 'running' | 'done';

const EXAMPLE_TEMPLATES = `And it is ${SLOT} with the finish!
${SLOT} is booked.
Saved by ${SLOT}!`;

export default function LineBankPanel() {
  const [csv, setCsv] = useState('');
  const [column, setColumn] = useState('');
  const [list, setList] = useState('');
  const [lines, setLines] = useState('');
  const [templates, setTemplates] = useState('');
  const [overrideText, setOverrideText] = useState('');
  const [mode, setMode] = useState<'whole' | 'surname'>('whole');
  const [voice, setVoice] = useState('bm_george');
  const [pace, setPace] = useState(1.15);
  const [format, setFormat] = useState<'mp3' | 'wav'>('mp3');
  // Whatever the rest of the app is set to. Kokoro is the sane default for
  // bulk — a hosted engine would bill and throttle every one of these — but
  // forcing it here would be the panel disagreeing with the picker.
  const [engine] = useState<Engine>(() => loadEngine());

  const [phase, setPhase] = useState<Phase>('idle');
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zip, setZip] = useState<{ url: string; name: string; size: number } | null>(null);
  const stop = useRef(false);
  const urlRef = useRef<string | null>(null);

  const headers = useMemo(() => (csv.trim() ? parseCsv(csv).headers : []), [csv]);

  const plan = useMemo(() => {
    const entries = [
      ...(csv.trim() && column ? columnValues(csv, column) : []),
      ...list.split('\n').map((l) => l.trim()).filter(Boolean),
    ];
    return planBank({
      entries,
      lines: lines.split('\n'),
      templates: templates.split('\n'),
      mode,
      overrides: parseOverrides(overrideText),
    });
  }, [csv, column, list, lines, templates, mode, overrideText]);

  const estimate = plan.clips.length * 1.4; // measured: about 1.4s per short clip on CPU

  const run = async () => {
    if (plan.clips.length === 0) return;
    stop.current = false;
    setPhase('running');
    setDone(0);
    setFailed([]);
    setError(null);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    setZip(null);

    const JSZip = (await import('jszip')).default;
    const archive = new JSZip();
    const folder = archive.folder('clips')!;
    const missed: string[] = [];

    for (let i = 0; i < plan.clips.length; i++) {
      if (stop.current) break;
      const clip = plan.clips[i];
      try {
        const audio = await speak(clip.say, {
          voice,
          engine,
          speed: pace,
          shouldContinue: () => !stop.current,
          onModelProgress: (fraction) =>
            setNote(`Loading the voice model — ${Math.round(fraction * 100)}%`),
        });
        setNote(null);
        const blob =
          format === 'mp3'
            ? await encodeMp3(audio.pcm, audio.sampleRate, 64)
            : encodeWav(audio.pcm, audio.sampleRate);
        folder.file(`${clip.slug}.${format}`, blob);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        // Stopping is a choice, not a failure.
        if (message.includes('Stopped')) break;
        // One unspeakable value must not end a run of two thousand.
        missed.push(clip.display);
        setFailed([...missed]);
      }
      setDone(i + 1);
    }

    if (stop.current && missed.length === 0 && done === 0) {
      setPhase('idle');
      return;
    }

    archive.file(
      'manifest.json',
      JSON.stringify(
        {
          voice,
          pace,
          format,
          index: plan.index,
          templates: plan.templates,
          spoken: Object.fromEntries(plan.clips.map((c) => [c.slug, c.say])),
          spokenDiffersFromSource: plan.overridden,
          failed: missed,
        },
        null,
        1,
      ),
    );

    try {
      const blob = await archive.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setZip({ url, name: `line-bank-${plan.clips.length}.zip`, size: blob.size });
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the archive.');
      setPhase('idle');
    }
  };

  const busy = phase === 'running';
  const field =
    'w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] placeholder-[#52525B] focus:outline-none focus:border-[#D4AF37]/60';
  const label = 'text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5';

  return (
    <div className="max-w-6xl mx-auto px-5 py-8">
      <div className="flex items-center gap-2 text-[10px] uppercase font-mono font-bold text-[#D4AF37] tracking-wider mb-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]" /> Line Bank
      </div>
      <h1 className="text-3xl font-bold text-[#E4E4E7] mb-2">Many clips, one run</h1>
      <p className="text-sm text-[#A1A1AA] mb-7 max-w-2xl">
        For anything that speaks on demand. Give it a list — or a CSV column — and the lines to say,
        and it returns a ZIP of small files with a manifest mapping each source value to its clip.
        Prepared in advance, because generating at the moment of the event arrives late.
      </p>

      <div className="grid lg:grid-cols-2 gap-5">
        <div className="space-y-4">
          <div>
            <span className={label}>A list, one per line</span>
            <textarea rows={4} value={list} onChange={(e) => setList(e.target.value)} disabled={busy}
              placeholder={'Arsenal\nLiverpool\nReal Madrid'} className={`${field} resize-y`} />
          </div>

          <div>
            <span className={label}>…or a CSV</span>
            <div className="flex gap-2">
              <input type="file" accept=".csv,text/csv" disabled={busy} className="hidden" id="bank-csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  setCsv(text);
                  const first = parseCsv(text).headers;
                  setColumn(first.find((h) => /name/i.test(h)) ?? first[0] ?? '');
                }} />
              <label htmlFor="bank-csv"
                className="flex items-center gap-2 px-3 py-2 bg-[#18181B] border border-[#27272A] rounded-lg text-xs text-[#E4E4E7] cursor-pointer hover:border-[#D4AF37]/40">
                <FileSpreadsheet className="w-3.5 h-3.5 text-[#D4AF37]" /> Choose file
              </label>
              {headers.length > 0 && (
                <select value={column} onChange={(e) => setColumn(e.target.value)} disabled={busy}
                  className={`${field} flex-1 cursor-pointer`}>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              )}
            </div>
          </div>

          <div>
            <span className={label}>Speak each entry as</span>
            <div className="flex gap-2">
              {(['whole', 'surname'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} disabled={busy}
                  className={`flex-1 py-2 text-[11px] uppercase font-bold tracking-wider rounded-lg border transition cursor-pointer ${
                    mode === m ? 'bg-[#D4AF37] text-black border-[#D4AF37]' : 'bg-[#18181B] text-[#A1A1AA] border-[#27272A]'
                  }`}>
                  {m === 'whole' ? 'The whole value' : 'Last name only'}
                </button>
              ))}
            </div>
            <span className="mt-1 block text-[10px] text-[#52525B]">
              Last name keeps its particle: “van der Sar”, not “Sar”.
            </span>
          </div>

          <div>
            <span className={label}>Whole lines, one per line</span>
            <textarea rows={3} value={lines} onChange={(e) => setLines(e.target.value)} disabled={busy}
              placeholder={'That is full time.\nAnd we are underway.'} className={`${field} resize-y`} />
          </div>

          <div>
            <span className={label}>Templates — {SLOT} is where an entry goes</span>
            <textarea rows={3} value={templates} onChange={(e) => setTemplates(e.target.value)} disabled={busy}
              placeholder={EXAMPLE_TEMPLATES} className={`${field} resize-y`} />
            <span className="mt-1 block text-[10px] text-[#52525B]">
              Each template is cut into the halves either side of the slot, so they can be joined
              around any entry at playback.
            </span>
          </div>

          <div>
            <span className={label}>Say it differently — one “Source = Spoken” per line</span>
            <textarea rows={2} value={overrideText} onChange={(e) => setOverrideText(e.target.value)} disabled={busy}
              placeholder={'Nice = Neece\nSevilla = Seveeya'} className={`${field} resize-y`} />
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <span className={label}>Voice</span>
            <VoicePicker voices={KOKORO_VOICES} value={voice} onChange={setVoice} disabled={busy} engine="kokoro" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>Pace — {pace.toFixed(2)}×</span>
              <input type="range" min={0.5} max={2} step={0.05} value={pace} disabled={busy}
                aria-label="Bank pace" onChange={(e) => setPace(Number(e.target.value))}
                className="w-full accent-[#D4AF37] cursor-pointer" />
            </label>
            <div>
              <span className={label}>Format</span>
              <div className="flex gap-2">
                {(['mp3', 'wav'] as const).map((f) => (
                  <button key={f} type="button" onClick={() => setFormat(f)} disabled={busy}
                    className={`flex-1 py-2 text-[11px] uppercase font-bold rounded-lg border cursor-pointer ${
                      format === f ? 'bg-[#D4AF37] text-black border-[#D4AF37]' : 'bg-[#18181B] text-[#A1A1AA] border-[#27272A]'
                    }`}>{f}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 text-xs text-[#A1A1AA] space-y-1.5">
            <div className="flex justify-between"><span>Clips to make</span>
              <span className="text-[#E4E4E7] font-mono">{plan.clips.length}</span></div>
            <div className="flex justify-between"><span>Source values indexed</span>
              <span className="text-[#E4E4E7] font-mono">{Object.keys(plan.index).length}</span></div>
            <div className="flex justify-between"><span>Templates</span>
              <span className="text-[#E4E4E7] font-mono">{plan.templates.length}</span></div>
            <div className="flex justify-between"><span>Engine</span>
              <span className="text-[#E4E4E7] font-mono">{engine === 'kokoro' ? 'Kokoro · local' : 'Gemini · hosted'}</span></div>
            <div className="flex justify-between"><span>Rough time</span>
              <span className="text-[#E4E4E7] font-mono">
                {estimate < 90 ? `${Math.round(estimate)}s` : `${Math.round(estimate / 60)} min`}
              </span></div>
            {Object.keys(plan.overridden).length > 0 && (
              <div className="pt-1 text-[10px] text-[#71717A]">
                {Object.keys(plan.overridden).length} spoken differently from the source value.
              </div>
            )}
          </div>

          {busy && (
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4">
              <div className="flex justify-between text-xs text-[#E4E4E7] mb-2">
                <span>{note ?? `Speaking ${done + 1} of ${plan.clips.length}`}</span>
                <span className="font-mono">{Math.round((done / plan.clips.length) * 100)}%</span>
              </div>
              <div className="h-1.5 bg-[#27272A] rounded-full overflow-hidden">
                <div className="h-full bg-[#D4AF37] transition-all"
                  style={{ width: `${(done / plan.clips.length) * 100}%` }} />
              </div>
            </div>
          )}

          {failed.length > 0 && (
            <div className="flex gap-2 text-[11px] text-amber-300/80 bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{failed.length} could not be spoken and were left out; they are listed in the manifest.</span>
            </div>
          )}
          {error && (
            <div className="flex gap-2 text-[11px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-xl p-3">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button type="button" onClick={run} disabled={busy || plan.clips.length === 0}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-30 disabled:pointer-events-none font-bold text-[11px] uppercase tracking-wider rounded-xl transition cursor-pointer">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
              {busy ? 'Building the bank…' : `Build ${plan.clips.length || ''} clips`}
            </button>
            {busy && (
              <button type="button" onClick={() => { stop.current = true; }}
                className="px-4 py-3 bg-[#18181B] border border-[#27272A] text-zinc-300 rounded-xl cursor-pointer" title="Stop">
                <Square className="w-4 h-4" />
              </button>
            )}
          </div>

          {zip && (
            <a href={zip.url} download={zip.name}
              className="flex items-center justify-center gap-2 py-3 bg-[#D4AF37]/10 border border-[#D4AF37]/25 text-[#D4AF37] font-bold text-[11px] uppercase tracking-wider rounded-xl hover:bg-[#D4AF37]/20 transition">
              <Download className="w-4 h-4" /> {zip.name} · {formatBytes(zip.size)}
            </a>
          )}
          {phase === 'done' && (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
              <Check className="w-3.5 h-3.5" /> {done} clips built.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
