import { useEffect, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { base64ToPcm, encodeWav } from '../../utils/audio';

export interface TtsVoice {
  name: string;
  character: string;
  timbre: 'warm' | 'bright' | 'deep' | 'clear';
  goodFor: string;
}

export interface VoiceCatalogue {
  voices: TtsVoice[];
  model: string;
  available: boolean;
}

const TIMBRE_STYLE: Record<TtsVoice['timbre'], string> = {
  warm: 'text-amber-300/90 border-amber-500/25 bg-amber-950/20',
  bright: 'text-sky-300/90 border-sky-500/25 bg-sky-950/20',
  deep: 'text-violet-300/90 border-violet-500/25 bg-violet-950/20',
  clear: 'text-emerald-300/90 border-emerald-500/25 bg-emerald-950/20',
};

export function useVoiceCatalogue() {
  const [catalogue, setCatalogue] = useState<VoiceCatalogue | null>(null);

  useEffect(() => {
    fetch('/api/tts/voices')
      .then((response) => response.json())
      .then(setCatalogue)
      .catch(() => setCatalogue(null));
  }, []);

  return catalogue;
}

const PREVIEW_LINE =
  'She climbed the last of the stair, and the lamp turned once, as if it had been waiting for her all these years.';

export default function VoicePicker({
  voices,
  value,
  onChange,
  disabled,
}: {
  voices: TtsVoice[];
  value: string;
  onChange: (voice: string) => void;
  disabled?: boolean;
}) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | TtsVoice['timbre']>('all');

  const preview = async (voice: string) => {
    setPreviewing(voice);
    try {
      const response = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: PREVIEW_LINE, voice }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Preview failed.');
      const audio = new Audio(URL.createObjectURL(encodeWav(base64ToPcm(payload.audioBase64), payload.sampleRate)));
      await audio.play();
    } catch {
      /* the caller surfaces provider errors; a failed preview is not fatal */
    } finally {
      setPreviewing(null);
    }
  };

  const shown = filter === 'all' ? voices : voices.filter((voice) => voice.timbre === filter);

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap">
        {(['all', 'warm', 'clear', 'bright', 'deep'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={`px-2 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wider border cursor-pointer transition ${
              filter === option
                ? 'text-[#D4AF37] border-[#D4AF37]/40 bg-[#D4AF37]/10'
                : 'text-[#71717A] border-[#27272A] hover:text-[#A1A1AA]'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="max-h-72 overflow-y-auto pr-1 space-y-1.5">
        {shown.map((voice) => {
          const selected = voice.name === value;
          return (
            <div
              key={voice.name}
              className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                selected ? 'border-[#D4AF37] bg-[#D4AF37]/10' : 'border-[#27272A] bg-[#111114] hover:border-[#3F3F46]'
              }`}
            >
              <button
                type="button"
                onClick={() => onChange(voice.name)}
                disabled={disabled}
                className="flex-1 text-left min-w-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${selected ? 'text-[#D4AF37]' : 'text-white'}`}>
                    {voice.name}
                  </span>
                  <span
                    className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${TIMBRE_STYLE[voice.timbre]}`}
                  >
                    {voice.character}
                  </span>
                </div>
                <p className="text-[10px] text-[#71717A] mt-0.5 truncate">{voice.goodFor}</p>
              </button>
              <button
                type="button"
                onClick={() => preview(voice.name)}
                disabled={previewing !== null}
                title={`Hear ${voice.name}`}
                aria-label={`Hear ${voice.name}`}
                className="p-2 rounded-lg text-[#D4AF37] hover:bg-[#D4AF37]/10 cursor-pointer disabled:opacity-40 shrink-0"
              >
                {previewing === voice.name ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
