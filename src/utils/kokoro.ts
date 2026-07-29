/**
 * Kokoro — speech that costs nothing and asks for no key.
 *
 * Kokoro is an 82M-parameter Apache-2.0 model that runs in the browser through
 * WebGPU (or WASM where WebGPU is missing). Nothing is sent to a server, there
 * is no quota to exhaust and no billing to enable, which is the whole point:
 * a book-length narration is thousands of passages, and a hosted API bills or
 * throttles every one of them.
 *
 * The cost is a one-time model download, cached by the browser afterwards, and
 * no style direction — Kokoro takes a voice and a speed, nothing more.
 */

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Kokoro emits 24kHz mono, which is exactly what the rest of the pipeline expects. */
export const KOKORO_SAMPLE_RATE = 24000;

interface RawAudio {
  audio: Float32Array;
  sampling_rate: number;
}

interface KokoroModel {
  generate(text: string, options: { voice: string; speed?: number }): Promise<RawAudio>;
  stream(
    text: string,
    options: { voice: string; speed?: number },
  ): AsyncGenerator<{ text: string; audio: RawAudio }, void, void>;
}

let loading: Promise<KokoroModel> | null = null;
let loadedDevice: 'webgpu' | 'wasm' | null = null;

export function kokoroDevice(): 'webgpu' | 'wasm' | null {
  return loadedDevice;
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * Loads the model once and reuses it. WebGPU gets the full-precision weights
 * because it can afford them and sounds better for it; the WASM fallback gets
 * the quantised build, which is a quarter of the download and several times
 * faster on a CPU.
 */
export async function loadKokoro(onProgress?: (fraction: number, label: string) => void): Promise<KokoroModel> {
  if (loading) return loading;

  loading = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const webgpu = await hasWebGpu();
    loadedDevice = webgpu ? 'webgpu' : 'wasm';

    const model = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: webgpu ? 'fp32' : 'q8',
      device: loadedDevice,
      progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') {
          onProgress?.(event.progress / 100, event.file ?? 'model');
        }
      },
    } as never);

    return model as unknown as KokoroModel;
  })();

  try {
    return await loading;
  } catch (error) {
    // A failed load must not poison every later attempt.
    loading = null;
    loadedDevice = null;
    throw error;
  }
}

/** True once the model is in memory, so callers can skip the "downloading" copy. */
export function kokoroReady(): boolean {
  return loading !== null && loadedDevice !== null;
}

function floatToPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: the model can overshoot slightly and wrapping
    // would turn a loud consonant into a click.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff));
  }
  return pcm;
}

/**
 * The model truncates at 509 phoneme tokens, silently. Phonemes run close to
 * one per character for English, so this cap leaves a wide margin — a piece
 * this size cannot reach the limit whatever it contains.
 */
const MAX_PIECE_CHARS = 320;

/**
 * Sentence-ish split that keeps terminal punctuation and closing quotes.
 *
 * The leading alternative has to allow an empty body, or a passage opening on
 * an ellipsis — "…and then she ran" — loses those characters entirely, because
 * a pattern requiring a non-terminator first can never match at position zero.
 */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?…]*[.!?…]+["'”’»)\]]*|[^.!?…]+/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

/**
 * True when a piece has nothing a voice could actually say.
 *
 * Scene breaks (`***`, `❦`, `---`) and stray punctuation reach here as pieces
 * of their own. Phonemising them yields nothing, and handing the model an
 * empty utterance is how a chapter fails part-way through a book. They belong
 * as a pause, which is what they mean on the page anyway.
 */
export function hasNoSpeech(piece: string): boolean {
  return !/[\p{L}\p{N}]/u.test(piece);
}

/**
 * Breaks text into pieces the model can take whole.
 *
 * Sentences are the natural unit, but a sentence can itself be longer than the
 * limit — an unpunctuated passage, a long list, verse — and that case is the
 * dangerous one, because the text still counts as "spoken" while its audio is
 * quietly cut off. Those are split again at clause boundaries, then at spaces
 * as a last resort, so nothing ever reaches the model oversized.
 */
export function splitForKokoro(text: string, limit = MAX_PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };

  for (const sentence of splitSentences(text)) {
    if (sentence.length <= limit) {
      if (`${current} ${sentence}`.trim().length > limit) flush();
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }
    flush();
    // Oversized sentence: clause boundaries first, then words, and finally a
    // blind chop — a single unbroken run (a URL, a hash, a stretch with no
    // spaces at all) has no natural break and must still be cut somewhere.
    for (const clause of sentence.split(/(?<=[,;:—–])\s+/)) {
      for (const word of clause.split(/\s+/).filter(Boolean)) {
        for (let at = 0; at < word.length; at += limit) {
          const part = word.slice(at, at + limit);
          if (`${current} ${part}`.trim().length > limit) flush();
          current = current ? `${current} ${part}` : part;
        }
      }
    }
    flush();
  }
  flush();

  if (pieces.length > 0) return pieces;
  // Fallback for text the sentence pass found nothing in: still never oversized.
  const rest = text.trim();
  if (!rest) return [];
  return rest.length <= limit ? [rest] : (rest.match(new RegExp(`.{1,${limit}}`, 'gs')) ?? [rest]);
}

/**
 * Speaks a passage of any length.
 *
 * `generate()` tokenises with `truncation: true` and the model caps input at
 * 509 tokens, so anything longer is cut off *silently* — no error, just a short
 * clip and the rest of the paragraph gone. Splitting is therefore not an
 * optimisation but the thing that makes the output correct, and it is done
 * here rather than left to the library so the piece size is guaranteed.
 */
export async function speakWithKokoro(
  text: string,
  voice: string,
  speed = 1,
  onProgress?: (fraction: number, label: string) => void,
  shouldContinue?: () => boolean,
): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const model = await loadKokoro(onProgress);

  const parts = splitForKokoro(text);
  if (parts.length === 0) throw new Error('There was nothing to speak in this passage.');

  const pieces: Int16Array[] = [];
  let sampleRate = KOKORO_SAMPLE_RATE;

  for (let index = 0; index < parts.length; index++) {
    if (shouldContinue && !shouldContinue()) throw new Error('Stopped.');
    const piece = parts[index];

    // A scene break carries meaning but no words. Give it the beat it means
    // rather than asking the model to pronounce three asterisks.
    if (hasNoSpeech(piece)) {
      pieces.push(new Int16Array(Math.round(0.45 * sampleRate)));
      continue;
    }

    let result;
    try {
      result = await model.generate(piece, { voice, speed });
    } catch (first) {
      // One retry: a transient allocation failure inside the runtime should not
      // cost a whole chapter.
      if (shouldContinue && !shouldContinue()) throw new Error('Stopped.');
      try {
        result = await model.generate(piece, { voice, speed });
      } catch {
        const detail = first instanceof Error ? first.message : String(first);
        // Name the passage that failed — "chapter 3 failed" is not enough to
        // act on, and this is the text that has to be looked at.
        throw new Error(
          `Speech failed on passage ${index + 1} of ${parts.length} ("${piece.slice(0, 60)}…"): ${detail}`,
        );
      }
    }

    pieces.push(floatToPcm(result.audio));
    sampleRate = result.sampling_rate || sampleRate;
    // A short pause between pieces, but never after the last one.
    if (index < parts.length - 1) pieces.push(new Int16Array(Math.round(0.08 * sampleRate)));
  }

  if (pieces.length === 0) throw new Error('Kokoro produced no audio for this passage.');

  // Second net: if splitting ever drops text, that is exactly the failure that
  // would not announce itself, so refuse to return a mutilated passage.
  // Counted over speakable characters only, so a scene break turned into a
  // pause does not read as loss.
  const speakable = (value: string) => value.replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '').length;
  const asked = speakable(text);
  const said = parts.filter((piece) => !hasNoSpeech(piece)).reduce((sum, piece) => sum + speakable(piece), 0);
  if (asked > 0 && said / asked < 0.98) {
    throw new Error(
      `Only ${Math.round((said / asked) * 100)}% of the passage was prepared for speech — the rest would have been lost silently.`,
    );
  }

  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const piece of pieces) {
    pcm.set(piece, offset);
    offset += piece.length;
  }

  return { pcm, sampleRate };
}

