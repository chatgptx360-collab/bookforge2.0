/// <reference lib="webworker" />

/**
 * Kokoro runs here, off the main thread.
 *
 * ONNX Runtime's WASM backend executes inference synchronously on whatever
 * thread calls it. On the page that is the UI thread, so every passage froze
 * the whole tab for the length of its inference — no repainting, no progress,
 * and a Stop button that could not be clicked. A book is thousands of passages,
 * which makes that unusable rather than merely rough.
 *
 * The model is loaded once here and kept for the life of the worker, so the
 * cost is paid on the first passage only.
 */

export type WorkerRequest =
  | { id: number; type: 'load' }
  | { id: number; type: 'speak'; text: string; voice: string; speed: number };

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; file: string }
  | { id: number; type: 'ready'; device: string }
  | { id: number; type: 'audio'; pcm: Int16Array; sampleRate: number }
  | { id: number; type: 'error'; message: string };

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

interface RawAudio {
  audio: Float32Array;
  sampling_rate: number;
}
interface KokoroModel {
  generate(text: string, options: { voice: string; speed?: number }): Promise<RawAudio>;
}

let model: KokoroModel | null = null;
let loading: Promise<KokoroModel> | null = null;
let device: 'webgpu' | 'wasm' = 'wasm';

async function hasWebGpu(): Promise<boolean> {
  const gpu = (self.navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function load(id: number): Promise<KokoroModel> {
  if (loading) return loading;

  loading = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    device = (await hasWebGpu()) ? 'webgpu' : 'wasm';

    const loaded = await KokoroTTS.from_pretrained(MODEL_ID, {
      // WebGPU can afford full precision and sounds better for it; the WASM
      // fallback takes the quantised build, a quarter of the download.
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      device,
      progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') {
          post({ id, type: 'progress', fraction: event.progress / 100, file: event.file ?? 'model' });
        }
      },
    } as never);

    model = loaded as unknown as KokoroModel;
    return model;
  })();

  return loading.catch((error) => {
    // A failed load must not poison every later attempt.
    loading = null;
    model = null;
    throw error;
  });
}

function post(message: WorkerResponse, transfer?: Transferable[]) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer ?? []);
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

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const ready = model ?? (await load(request.id));
    if (request.type === 'load') {
      post({ id: request.id, type: 'ready', device });
      return;
    }

    const result = await ready.generate(request.text, { voice: request.voice, speed: request.speed });
    const pcm = floatToPcm(result.audio);
    // Hand the buffer over rather than copying it; a chapter is megabytes.
    post(
      { id: request.id, type: 'audio', pcm, sampleRate: result.sampling_rate || 24000 },
      [pcm.buffer],
    );
  } catch (error) {
    post({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
