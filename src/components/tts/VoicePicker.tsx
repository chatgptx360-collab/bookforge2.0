import { useEffect, useState } from 'react';
import { Loader2, Mars, Play, Venus } from 'lucide-react';
import { encodeWav } from '../../utils/audio';
import { readJson, speak, type Engine } from '../../utils/speech';

export interface TtsVoice {
  /** The model's own voice name, sent with every request. */
  id: string;
  /** The human name shown in the list — chosen to match the voice's gender. */
  name: string;
  character: string;
  timbre: 'warm' | 'bright' | 'deep' | 'clear';
  gender: 'male' | 'female';
  goodFor: string;
  bestFor: string[];
  /**
   * Kokoro publishes a quality grade per voice and they vary a lot — an A
   * carries a whole book, an F+ does not. Shown so the choice is informed.
   */
  grade?: string;
}

export interface VoiceCatalogue {
  voices: TtsVoice[];
  model: string;
  available: boolean;
  /** Set when the catalogue could not be loaded, so the UI stops spinning. */
  error?: string;
}

const TIMBRE_STYLE: Record<TtsVoice['timbre'], string> = {
  warm: 'text-amber-300/90 border-amber-500/25 bg-amber-950/20',
  bright: 'text-sky-300/90 border-sky-500/25 bg-sky-950/20',
  deep: 'text-violet-300/90 border-violet-500/25 bg-violet-950/20',
  clear: 'text-emerald-300/90 border-emerald-500/25 bg-emerald-950/20',
};

/** Reads as male / female — the labels are for filtering, not identity. */
const GENDER = {
  male: { Icon: Mars, tone: 'text-sky-400', label: 'Male voice' },
  female: { Icon: Venus, tone: 'text-rose-400', label: 'Female voice' },
} as const;

type Filter = 'all' | TtsVoice['timbre'] | TtsVoice['gender'];
const FILTERS: Filter[] = ['all', 'female', 'male', 'warm', 'clear', 'bright', 'deep'];

function matchesFilter(voice: TtsVoice, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'male' || filter === 'female') return voice.gender === filter;
  return voice.timbre === filter;
}

export function useVoiceCatalogue() {
  const [catalogue, setCatalogue] = useState<VoiceCatalogue | null>(null);

  useEffect(() => {
    let cancelled = false;

    // A cold serverless start can miss the first request; one retry covers it.
    const load = async (attempt = 0): Promise<void> => {
      try {
        const response = await fetch('/api/tts/voices');
        const payload = await readJson(response);
        if (!response.ok) throw new Error(String(payload.error ?? `Request failed (${response.status}).`));
        if (!cancelled) setCatalogue(payload as unknown as VoiceCatalogue);
      } catch (error) {
        if (cancelled) return;
        if (attempt < 1) {
          setTimeout(() => void load(attempt + 1), 1500);
          return;
        }
        setCatalogue({
          voices: [],
          model: '',
          available: false,
          error: error instanceof Error ? error.message : 'Could not load the voice list.',
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return catalogue;
}

/** Headings show the human name; state and requests carry the id. */
export function voiceLabel(catalogue: VoiceCatalogue | null, id: string): string {
  return catalogue?.voices.find((voice) => voice.id === id)?.name ?? id;
}

const PREVIEW_LINE =
  'She climbed the last of the stair, and the lamp turned once, as if it had been waiting for her all these years.';

export default function VoicePicker({
  voices,
  value,
  onChange,
  disabled,
  engine = 'gemini',
  onModelProgress,
}: {
  voices: TtsVoice[];
  value: string;
  onChange: (voice: string) => void;
  disabled?: boolean;
  engine?: Engine;
  onModelProgress?: (fraction: number, label: string) => void;
}) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const preview = async (voice: string) => {
    setPreviewing(voice);
    setPreviewError(null);
    try {
      // A preview is a single short line, so it should not sit waiting out a
      // quota window the way a book-length run does.
      const payload = await speak(PREVIEW_LINE, { voice, engine, maxRetries: 0, onModelProgress: onModelProgress });
      const audio = new Audio(URL.createObjectURL(encodeWav(payload.pcm, payload.sampleRate)));
      await audio.play();
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Preview failed.');
    } finally {
      setPreviewing(null);
    }
  };

  const shown = voices.filter((voice) => matchesFilter(voice, filter));

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap">
        {FILTERS.map((option) => {
          const GenderIcon = option === 'male' || option === 'female' ? GENDER[option].Icon : null;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wider border cursor-pointer transition ${
                filter === option
                  ? 'text-[#D4AF37] border-[#D4AF37]/40 bg-[#D4AF37]/10'
                  : 'text-[#71717A] border-[#27272A] hover:text-[#A1A1AA]'
              }`}
            >
              {GenderIcon && <GenderIcon className="w-3 h-3" />}
              {option}
            </button>
          );
        })}
      </div>

      {previewError && (
        <p className="text-[10px] text-red-400 leading-relaxed px-0.5">{previewError}</p>
      )}

      <div className="max-h-[26rem] overflow-y-auto pr-1 space-y-1.5">
        {shown.map((voice) => {
          const selected = voice.id === value;
          const { Icon: GenderIcon, tone, label } = GENDER[voice.gender];
          return (
            <div
              key={voice.id}
              className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                selected ? 'border-[#D4AF37] bg-[#D4AF37]/10' : 'border-[#27272A] bg-[#111114] hover:border-[#3F3F46]'
              }`}
            >
              <button
                type="button"
                onClick={() => onChange(voice.id)}
                disabled={disabled}
                className="flex-1 text-left min-w-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-semibold ${selected ? 'text-[#D4AF37]' : 'text-white'}`}>
                    {voice.name}
                  </span>
                  <span
                    className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${TIMBRE_STYLE[voice.timbre]}`}
                  >
                    {voice.character}
                  </span>
                  {voice.grade && (
                    <span
                      title={`Model quality grade: ${voice.grade}`}
                      className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                        /^[AB]/.test(voice.grade)
                          ? 'text-emerald-300 border-emerald-500/30 bg-emerald-950/20'
                          : /^C/.test(voice.grade)
                            ? 'text-amber-300 border-amber-500/30 bg-amber-950/20'
                            : 'text-red-300/80 border-red-500/25 bg-red-950/20'
                      }`}
                    >
                      {voice.grade}
                    </span>
                  )}
                  {/* Kept visible so a voice can still be matched to the model docs. */}
                  <span className="text-[9px] font-mono text-[#3F3F46]">{voice.id}</span>
                </div>
                <p className="text-[10px] text-[#71717A] mt-0.5 truncate">{voice.goodFor}</p>
                <div className="flex gap-1 flex-wrap mt-1.5">
                  <span className="text-[9px] text-[#52525B] font-mono uppercase tracking-wider">Best for</span>
                  {voice.bestFor.map((use) => (
                    <span
                      key={use}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-[#18181B] border border-[#27272A] text-[#A1A1AA]"
                    >
                      {use}
                    </span>
                  ))}
                </div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <span title={label} aria-label={label} className={tone}>
                  <GenderIcon className="w-3.5 h-3.5" />
                </span>
                <button
                  type="button"
                  onClick={() => preview(voice.id)}
                  disabled={previewing !== null}
                  title={`Hear ${voice.name}`}
                  aria-label={`Hear ${voice.name}`}
                  className="p-2 rounded-lg text-[#D4AF37] hover:bg-[#D4AF37]/10 cursor-pointer disabled:opacity-40"
                >
                  {previewing === voice.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
