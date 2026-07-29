/**
 * The speech client.
 *
 * Two things go wrong in production that a plain `fetch().then(r => r.json())`
 * handles badly, and both were hit on the first real book:
 *
 * 1. A serverless platform that fails outside our handler — a timeout, a cold
 *    start that dies — answers with an HTML error page. Parsing that as JSON
 *    reports `Unexpected token 'A'`, which tells the user nothing about what
 *    actually happened.
 * 2. Speech quotas are per minute, and a book is thousands of calls, so being
 *    throttled is routine rather than exceptional. Failing the chapter on a 429
 *    turns a slow run into a broken one.
 */

/**
 * Both engines resolve to raw PCM, so callers never branch on which one ran.
 * Gemini's base64 is decoded here rather than in every panel.
 */
export interface SpeechResult {
  pcm: Int16Array;
  sampleRate: number;
}

/**
 * Two engines, deliberately kept side by side. Kokoro runs locally and is free
 * without limit but cannot be directed; Gemini is directable but metered.
 */
export type Engine = 'kokoro' | 'gemini';

export const ENGINE_STORAGE_KEY = 'bookforge.speech.engine';

export function loadEngine(): Engine {
  return localStorage.getItem(ENGINE_STORAGE_KEY) === 'gemini' ? 'gemini' : 'kokoro';
}

export function storeEngine(engine: Engine): void {
  localStorage.setItem(ENGINE_STORAGE_KEY, engine);
}

export class SpeechError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
  }
}

/**
 * Reads a JSON body, and when the response is not JSON at all, reports what the
 * server actually said instead of where the parser gave up.
 */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    if (response.ok) throw new SpeechError('The server sent a malformed reply.', response.status);
    // An HTML error page, a proxy notice, a gateway timeout.
    const plain = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const detail = plain.slice(0, 160) || response.statusText || 'no detail';
    throw new SpeechError(`The server returned ${response.status} — ${detail}`, response.status);
  }
}

export async function planChunks(text: string, maxChars?: number): Promise<string[]> {
  const response = await fetch('/api/tts/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, maxChars }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw new SpeechError(String(payload.error ?? 'Could not plan the passage.'), response.status);
  return (payload.chunks as string[]) ?? [];
}

export interface SpeakOptions {
  voice: string;
  style?: string;
  engine?: Engine;
  /** Reports the one-time model download when Kokoro is loading. */
  onModelProgress?: (fraction: number, label: string) => void;
  /** Called while waiting out a quota window, so the wait is visible. */
  onThrottled?: (secondsLeft: number, attempt: number) => void;
  /** Return false to abandon the wait — a stopped run should not keep waiting. */
  shouldContinue?: () => boolean;
  /** How many quota windows to sit through before giving up. */
  maxRetries?: number;
  /** How many times to re-try an outright server failure. */
  maxServerRetries?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Speaks one passage.
 *
 * Throttling and failure get different budgets on purpose. A 429 means "come
 * back in a minute" and is worth sitting through several times, because the
 * alternative is abandoning a book part-way. A 5xx or a dropped connection
 * means something is broken; two quick attempts cover a blip, and anything
 * beyond that should reach the user in seconds rather than after minutes of
 * invisible retrying. A 4xx that is not 429 is our own mistake and is raised at
 * once.
 */
export async function speak(text: string, options: SpeakOptions): Promise<SpeechResult> {
  const {
    voice,
    style,
    engine = 'kokoro',
    onModelProgress,
    onThrottled,
    shouldContinue,
    maxRetries = 6,
    maxServerRetries = 2,
  } = options;
  let quotaWaits = 0;
  let serverRetries = 0;

  const stopped = () => Boolean(shouldContinue) && !shouldContinue!();

  // Kokoro never leaves the browser, so none of the retry machinery below
  // applies to it — there is no quota, no network and no server to fail.
  if (engine === 'kokoro') {
    if (stopped()) throw new SpeechError('Stopped.', 0);
    const { speakWithKokoro } = await import('./kokoro');
    try {
      return await speakWithKokoro(text, voice, 1, onModelProgress);
    } catch (error) {
      throw new SpeechError(
        error instanceof Error ? `Local speech failed: ${error.message}` : 'Local speech failed.',
        0,
      );
    }
  }

  for (;;) {
    if (stopped()) throw new SpeechError('Stopped.', 0);

    let response: Response;
    try {
      response = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, style }),
      });
    } catch {
      // The network dropped, or the function never answered at all.
      if (serverRetries >= maxServerRetries) throw new SpeechError('The server could not be reached.', 0);
      serverRetries++;
      await sleep(2000 * serverRetries);
      continue;
    }

    if (response.ok) {
      const payload = await readJson(response);
      const { base64ToPcm } = await import('./audio');
      return {
        pcm: base64ToPcm(String(payload.audioBase64)),
        sampleRate: Number(payload.sampleRate) || 24000,
      };
    }

    const payload: Record<string, unknown> = await readJson(response).catch((error: SpeechError) => ({
      error: error.message,
    }));
    const message = String(payload.error ?? `Speech generation failed (${response.status}).`);

    if (response.status === 429) {
      // A daily allowance does not refill in a minute, so waiting out the
      // provider's suggested delay would burn time and still fail.
      if (payload.quotaScope === 'day' || quotaWaits >= maxRetries) {
        throw new SpeechError(message, 429);
      }
      quotaWaits++;
      const wait = Math.ceil(
        Number(payload.retryAfterSeconds) || Number(response.headers.get('Retry-After')) || 60,
      );
      for (let left = wait; left > 0; left--) {
        if (stopped()) throw new SpeechError('Stopped.', 0);
        onThrottled?.(left, quotaWaits);
        await sleep(1000);
      }
      continue;
    }

    if (response.status >= 500 && serverRetries < maxServerRetries) {
      serverRetries++;
      await sleep(1500 * serverRetries);
      continue;
    }

    throw new SpeechError(message, response.status);
  }
}
