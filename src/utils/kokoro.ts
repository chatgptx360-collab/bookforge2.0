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

export async function speakWithKokoro(
  text: string,
  voice: string,
  speed = 1,
  onProgress?: (fraction: number, label: string) => void,
): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const model = await loadKokoro(onProgress);
  const result = await model.generate(text, { voice, speed });
  return { pcm: floatToPcm(result.audio), sampleRate: result.sampling_rate || KOKORO_SAMPLE_RATE };
}

