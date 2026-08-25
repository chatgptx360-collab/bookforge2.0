/**
 * Two voices Kokoro does not ship.
 *
 * A voice in Kokoro is not a model — it is a 510x256 block of floats that
 * conditions the decoder. Averaging two of those blocks gives a working third
 * voice, and the weights are not confined to [0,1]: pushing past a source
 * (1.7 of one, -0.7 of another) extrapolates beyond it. That matters here,
 * because the whole English catalogue tops out at 212 Hz and two of the three
 * voices asked for sits above it, at 240 Hz. Interpolation alone could never
 * have reached it.
 *
 * Every recipe below was tuned by generating a sample and measuring its median
 * pitch, not by taste:
 *
 *   target 239.7 Hz -> 243.7        target 143.2 Hz -> 142.9
 *
 * Pitch is not the whole story, and a third voice was cut for it. It targeted
 * 259 Hz and hit it, but bought the height by pushing 0.7 past its strongest
 * ingredient and sounded wrong for it — measurably so, with the weakest
 * periodicity and worst jitter of anything tried. A gentler recipe against a
 * lower partner scored better on both, and still did not convince, so it went
 * rather than shipping a voice nobody would pick. Lift is roughly weight x the
 * gap between the two ingredients, which is the lever if it is ever revisited.
 *
 * The awkward part: kokoro-js freezes its voice catalogue, so a genuinely new
 * id cannot be registered, and the one method that skips validation needs
 * phonemes the library will not expose. So each new voice takes over the id of
 * an existing one — the weakest in the catalogue, neither used as an
 * ingredient. Asking for `af_river` now returns a blend, which is surprising
 * enough to be worth saying out loud here and in the catalogue.
 *
 * The accent comes from the id's first letter, not from the blend: kokoro-js
 * feeds `a` to the American phonemiser and `b` to the British one. Both
 * recipes were measured through an `a` id, so both occupy `a` ids.
 */

/** [ingredient voice id, weight]. Weights may be negative, and need not sum to 1. */
export type Recipe = ReadonlyArray<readonly [string, number]>;

export const VOICE_BLENDS: Readonly<Record<string, Recipe>> = {
  // Low and full, the male storytime read.
  af_river: [['am_fenrir', 0.6], ['am_eric', 0.4]],
  // High but less pressed, with room to breathe.
  am_echo: [['af_jessica', 1.5], ['am_adam', -0.5]],
};

export function isBlendedVoice(id: string): boolean {
  return Object.hasOwn(VOICE_BLENDS, id);
}

const VOICE_URL = (id: string) =>
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${id}.bin`;

/** Fetches the ingredients and combines them into one style tensor. */
async function buildBlend(recipe: Recipe): Promise<ArrayBuffer> {
  const parts = await Promise.all(
    recipe.map(async ([id]) => {
      const response = await fetch(VOICE_URL(id));
      if (!response.ok) throw new Error(`Voice ingredient ${id} could not be loaded (HTTP ${response.status}).`);
      return new Float32Array(await response.arrayBuffer());
    }),
  );

  return combine(parts, recipe).buffer;
}

/** The weighted sum itself, kept pure so it can be tested without a network. */
export function combine(parts: Float32Array[], recipe: Recipe): Float32Array {
  if (parts.length !== recipe.length) throw new Error('Wrong number of voice ingredients.');
  const out = new Float32Array(parts[0].length);
  recipe.forEach(([, weight], index) => {
    const part = parts[index];
    if (part.length !== out.length) throw new Error('Voice ingredients are not the same shape.');
    for (let i = 0; i < out.length; i++) out[i] += part[i] * weight;
  });
  return out;
}

/**
 * Makes the blended voices reachable by intercepting the library's own fetch.
 *
 * kokoro-js builds the URL itself and offers no hook, so this is the seam.
 * Only the three blended ids are touched; every other request, including the
 * ingredients fetched above, goes through untouched. Idempotent, because the
 * worker may load the model more than once.
 */
let installed = false;

export function installVoiceBlends(scope: { fetch: typeof fetch }): void {
  if (installed) return;
  installed = true;

  const cache = new Map<string, Promise<ArrayBuffer>>();
  const original = scope.fetch.bind(scope);

  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = /\/voices\/([a-z]{2}_[a-z]+)\.bin$/.exec(url);
    const id = match?.[1];

    if (!id || !isBlendedVoice(id)) return original(input as RequestInfo, init);

    // Built once per worker; the tensor is half a megabyte.
    let pending = cache.get(id);
    if (!pending) {
      pending = buildBlend(VOICE_BLENDS[id]);
      cache.set(id, pending);
    }
    // A failed blend must not be cached as a permanent failure.
    pending.catch(() => cache.delete(id));

    return new Response(await pending, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  };
}
