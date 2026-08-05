/**
 * Shared harness for the browser suites.
 *
 * These exist because the interesting failures in this app are not unit-sized:
 * a chapter marked done with half its words missing, autosave that looks like
 * it worked until you refresh, a fix button that silently invents text. None
 * of those show up without driving the real UI.
 *
 * The suites run against a dev server the runner starts, and stub
 * /api/tts/speak so no key, no quota and no model download are involved.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';

/** Asks the OS for a port nobody is using. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts a dev server and waits for it to answer.
 *
 * Each suite gets its own port. Sharing one meant a suite could fail because
 * the previous suite's server had not finished releasing it — a failure that
 * looks exactly like a broken feature and is not one.
 *
 * Returns { base, stop }. Callers must call stop or the run will hang.
 */
export async function startServer(env = {}) {
  if (process.env.BOOKFORGE_URL) {
    return { base: process.env.BOOKFORGE_URL, stop: async () => {} };
  }

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const child = spawn('npx', ['tsx', 'server.ts'], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server did not start on ${base}`);
    }
    await sleep(400);
  }

  // /api/health answers before Vite has compiled the client, so the first
  // navigation pays for the whole build. Left unwarmed, the first test in
  // every file times out while the rest pass — a failure about startup, not
  // about the app.
  try {
    await fetch(base, { headers: { accept: 'text/html' } });
  } catch {
    /* the health check already proved it is up */
  }

  return {
    base,
    stop: async () => {
      child.kill('SIGTERM');
      await sleep(300);
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}

/** A tone whose length matches the text, as a real engine's would. */
export function tone(text, frequency = 440) {
  const rate = 24000;
  const seconds = Math.max(0.3, String(text).length / 14);
  const samples = Math.round(seconds * rate);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * frequency * i) / rate)), i * 2);
  }
  return buffer.toString('base64');
}

/**
 * Stubs the hosted speech route.
 *
 * The audio must be proportionate to the text: the client now rejects a clip
 * far shorter than its passage, which is exactly the bug this app shipped
 * once, so a fixed short tone would fail for the right reason and make the
 * suite useless.
 */
export async function stubSpeech(page, { delayMs = 0, frequency = 440, onCall } = {}) {
  await page.route('**/api/tts/speak', async (route) => {
    const said = JSON.parse(route.request().postData() || '{}').text ?? '';
    onCall?.(said);
    if (delayMs) await sleep(delayMs);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        audioBase64: tone(said, frequency),
        mimeType: 'audio/L16;codec=pcm;rate=24000',
        sampleRate: 24000,
      }),
    });
  });
}

/**
 * Noise from the dev server's hot-reload client, not from the app.
 *
 * Each suite starts and tears down its own dev server, so a page can still be
 * completing an HMR handshake when the previous server goes away. The socket
 * then throws, and asserting on raw page errors turned that into five failures
 * that had nothing to do with the application — every suite passed alone and
 * failed in a batch. Only Vite's transport is ignored; a genuine app error
 * still fails the test.
 */
const DEV_SERVER_NOISE = /WebSocket closed without opened|\[vite\]|vite\/client/i;

/** A page with the hosted engine selected and page errors surfaced as failures. */
export async function openPage(context, { engine = 'gemini' } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => {
    if (!DEV_SERVER_NOISE.test(error.message)) errors.push(error.message);
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript((value) => {
    localStorage.setItem('bookforge.speech.engine', value);
  }, engine);
  page.pageErrors = errors;
  return page;
}

/**
 * Finds a Chromium to drive.
 *
 * Playwright normally downloads a build matched to its own version. Some
 * environments ship one already and forbid the download, and the versions do
 * not always line up, so an explicit executable wins when one is offered.
 * Set BOOKFORGE_CHROMIUM to point at a binary; otherwise Playwright's own
 * download is used, which is what `npx playwright install chromium` provides.
 */
function launchOptions() {
  const explicit = process.env.BOOKFORGE_CHROMIUM;
  if (explicit && existsSync(explicit)) return { executablePath: explicit };

  for (const candidate of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ]) {
    if (existsSync(candidate)) return { executablePath: candidate };
  }
  return {};
}

export async function withBrowser(run) {
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    return await run(context);
  } finally {
    await browser.close();
  }
}

/** Waits for a narration run to both start and finish, not merely look idle. */
export async function narrationSettles(page, timeout = 120_000) {
  await page.locator('text=/Stop after this chapter/i').waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return !text.includes('Stop after this chapter') && !/\bpart \d+\//.test(text);
    },
    null,
    { timeout },
  );
  // The counter commits a frame after the run ends.
  await page.locator('text=/\\d+\\/\\d+ sections/').first().waitFor({ timeout: 30_000 });
}

export function manuscript(chapters = 4) {
  return Array.from(
    { length: chapters },
    (_, i) => `Chapter ${i + 1}: Part ${i + 1}\n\nBody of chapter ${i + 1}, long enough to be worth speaking aloud.`,
  ).join('\n\n');
}

export const FLAWED = [
  'Ghost Signal',
  '',
  'Table of Contents',
  'Chapter 1: The Signal ..... 1',
  'Chapter 2: The Answer ..... 20',
  '',
  'Chapter 1: The Signal',
  '',
  'Thorne stared at the console while the hull groaned around him in the dark.',
  '',
  '"Protocol seven requires immediate withdrawal, Commander."',
  '',
  '"Shut up, VERNA."',
  '',
  'Thorne stared at the console while the hull groaned around him in the dark.',
  '',
  '"Shut up, VERNA."',
  '',
  'Chapter 2: The Answer',
  '',
  '"Shut up, VERNA."',
  '',
  'The weight of it washed over him in that moment, a testament to unwavering dread.',
].join('\n');

export const CLEAN = [
  'Chapter 1: Low Water',
  '',
  'The tide had gone out further than Marin remembered, exposing ribs of black rock.',
  '',
  '"You came back," her mother said, not turning from the window.',
  '',
  'She had rehearsed an answer for eleven years and still had none ready.',
  '',
  'Chapter 2: The Keeper',
  '',
  'Salt had eaten the hinges to lace. Beyond the door, the stair climbed into dark.',
  '',
  'Marin counted the steps aloud, the way frightened people count anything.',
].join('\n');

/**
 * A real DOCX that is mostly not words.
 *
 * This is the shape of the file that broke the converter: a manuscript whose
 * size comes from embedded media, not text. The filler is random so the zip
 * cannot compress it away, and it sits under word/media where a picture would
 * — Word and mammoth both ignore parts they were not told about.
 */
export async function bigDocx(lines, padMegabytes) {
  const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
  const { default: AdmZip } = await import('adm-zip');
  const { randomBytes } = await import('node:crypto');

  const document = new Document({
    sections: [
      {
        // "Chapter 4: Drift" is a heading; "Chapter 4, paragraph 2" is not.
        // A looser test made every body line a heading and collapsed the book
        // into one section.
        children: lines.map((line) =>
          /^Chapter \d+:/.test(line)
            ? new Paragraph({ text: line, heading: HeadingLevel.HEADING_1 })
            : new Paragraph(line),
        ),
      },
    ],
  });

  const zip = new AdmZip(await Packer.toBuffer(document));
  zip.addFile('word/media/filler.bin', randomBytes(padMegabytes * 1024 * 1024));
  return zip.toBuffer();
}

export const upload = (page, name, body) =>
  page.locator('input[type=file]').first().setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(body),
  });
