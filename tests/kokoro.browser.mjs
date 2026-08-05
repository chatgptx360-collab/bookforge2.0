/**
 * Does the local voice actually speak?
 *
 * This is the one thing the rest of the suite cannot answer. Every other test
 * stubs the speech route, so the whole app can pass while Kokoro produces
 * nothing at all — which is exactly the state this project shipped in for
 * weeks. Here the model really loads and really runs, and the audio it returns
 * is inspected rather than counted.
 *
 * Opt-in, because it downloads ~92 MB and takes a minute:
 *
 *   BOOKFORGE_KOKORO=1 npm run test:kokoro
 *
 * Offline, point it at a directory holding the Hub's layout for
 * onnx-community/Kokoro-82M-v1.0-ONNX (config.json, tokenizer.json,
 * tokenizer_config.json, onnx/model_quantized.onnx, voices/*.bin):
 *
 *   BOOKFORGE_KOKORO=1 BOOKFORGE_KOKORO_MIRROR=/path/to/mirror npm run test:kokoro
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startServer, withBrowser, openPage } from './harness.mjs';

const ENABLED = process.env.BOOKFORGE_KOKORO === '1';
const MIRROR = process.env.BOOKFORGE_KOKORO_MIRROR;
const RUNTIME_DIST = new URL('../node_modules/@huggingface/transformers/dist/', import.meta.url).pathname;

const TYPES = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
};

/**
 * Serves the mirrored weights over a real socket.
 *
 * Returning 92 MB from a Playwright route handler pushes it across the debug
 * protocol as base64 and kills the browser outright, so the interception only
 * redirects and the bytes come from here.
 */
async function startMirror(root) {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = rel.startsWith('runtime/') ? join(RUNTIME_DIST, rel.slice(8)) : join(root, rel);
    if (!existsSync(file)) {
      res.writeHead(404).end('not mirrored');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      // The app is cross-origin isolated, so anything it pulls in must say so.
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    base: `http://localhost:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Reads a mono 16-bit WAV into samples. */
function readWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF', 'not a RIFF file');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE', 'not a WAVE file');

  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      rate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }

  assert.ok(data, 'the WAV has no data chunk');
  assert.equal(bits, 16, 'expected 16-bit samples');
  const samples = new Int16Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { rate, channels, samples, seconds: samples.length / channels / rate };
}

/**
 * Speech, or something merely shaped like it?
 *
 * A file can be the right length and still be silence, a DC offset or a tone.
 * Real speech swings between syllables and gaps, so the test is that the
 * short-window energy varies — not just that some bytes arrived.
 */
function describeAudio({ samples, rate }) {
  let sumSquares = 0;
  let peak = 0;
  for (const s of samples) {
    sumSquares += s * s;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  const rms = Math.sqrt(sumSquares / samples.length);

  const window = Math.floor(rate / 20); // 50 ms
  const energies = [];
  for (let i = 0; i + window <= samples.length; i += window) {
    let sum = 0;
    for (let j = i; j < i + window; j++) sum += samples[j] * samples[j];
    energies.push(Math.sqrt(sum / window));
  }
  return {
    peak,
    rms,
    windows: energies.length,
    loud: energies.filter((e) => e > rms).length,
    quiet: energies.filter((e) => e < rms * 0.2).length,
  };
}

const SENTENCE = 'The tide had gone out further than Marin remembered, exposing ribs of black rock.';

test(
  'the local voice model really produces speech',
  { skip: ENABLED ? false : 'set BOOKFORGE_KOKORO=1 to run (downloads ~92 MB)' },
  async () => {
    const mirror = MIRROR ? await startMirror(MIRROR) : null;
    const server = await startServer();

    try {
      await withBrowser(async (context) => {
        if (mirror) {
          const redirect = (route, to) =>
            route.fulfill({ status: 302, headers: { location: `${mirror.base}/${to}` }, body: '' });

          await context.route('**://huggingface.co/**', (route) => {
            const after = new URL(route.request().url()).pathname.split('/resolve/main/')[1];
            return after ? redirect(route, after) : route.fulfill({ status: 404, body: 'unexpected' });
          });
          // transformers.js loads the ONNX runtime's wasm from a CDN.
          await context.route('**://cdn.jsdelivr.net/**', (route) => {
            const path = new URL(route.request().url()).pathname;
            return redirect(route, `runtime/${path.slice(path.lastIndexOf('/') + 1)}`);
          });
        }

        const page = await openPage(context, { engine: 'kokoro' });
        await page.goto(`${server.base}/speech`, { waitUntil: 'domcontentloaded' });

        await page.locator('textarea').first().fill(SENTENCE);
        await page.locator('button', { hasText: /Generate speech/i }).click();

        // The player only exists once samples came back, so this waits for
        // audio rather than for the button to stop spinning.
        await page.locator('audio').first().waitFor({ timeout: 900_000 });

        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('button', { hasText: /^\s*WAV\s*$/ }).first().click(),
        ]);

        const chunks = [];
        for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        const wav = readWav(Buffer.concat(chunks));
        const sound = describeAudio(wav);

        assert.equal(wav.rate, 24000, 'Kokoro speaks at 24 kHz');
        assert.equal(wav.channels, 1, 'expected mono');

        // Roughly 14 characters a second is the app's own estimate. The band is
        // wide because pace varies; it is here to catch a clip that is a
        // fraction of the sentence, which is how truncation showed up before.
        const expected = SENTENCE.length / 14;
        assert.ok(
          wav.seconds > expected * 0.5 && wav.seconds < expected * 2.5,
          `${wav.seconds.toFixed(2)}s of audio for ${SENTENCE.length} characters is not a reading of them`,
        );

        assert.ok(sound.peak > 3000, `peak ${sound.peak} — this is silence, not speech`);
        assert.ok(sound.rms > 200, `rms ${sound.rms.toFixed(0)} — too quiet to be a voice`);
        assert.ok(
          sound.loud > 3 && sound.quiet > 1,
          `energy does not rise and fall (${sound.loud} loud, ${sound.quiet} quiet of ${sound.windows}) — a tone, not words`,
        );

        assert.deepEqual(page.pageErrors, []);
      });
    } finally {
      await server.stop();
      await mirror?.stop();
    }
  },
);
