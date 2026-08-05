/**
 * Converter and speech views, driven through the real UI.
 *
 * The upload case is here because it shipped broken: the app advertised a
 * limit the platform did not honour, and twenty-three files became seven with
 * a bare 413. The test asserts the file is refused *before* it is sent.
 */

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { bigDocx, openPage, startServer, stubSpeech, upload, withBrowser } from './harness.mjs';

let server;
// One megabyte, so an oversized file is cheap to construct.
before(async () => { server = await startServer({ MAX_UPLOAD_MB: '1' }); });
after(async () => { await server?.stop(); });

const CHAPTER_TITLES = [
  'Low Water', 'The Keeper', 'Salt and Iron', 'What the Tide Left', 'Nine Fathoms',
  'The Long Room', 'Her Mothers Hands', 'Coldharbour', 'The Second Lamp', 'Drift',
  'A Letter Unsent', 'The Wreck of the Ardent', 'Storm Glass', 'Northerly', 'The Quiet Hour',
  'What Marin Knew', 'The Turning', 'Deep Water', 'Landfall', 'Low Water Again',
];

const BODY = [
  'The tide had gone out further than she remembered, exposing ribs of black rock.',
  'Salt had eaten the hinges to lace, and the door gave without being asked.',
  'She counted the steps aloud, the way frightened people count anything.',
  'The lamp room smelled of paraffin and of something older underneath it.',
  'Nothing moved on the water, and that was the wrong kind of quiet.',
];

test('an oversized file is refused before it is uploaded', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    let sent = 0;
    await page.route('**/api/book/convert', (route) => { sent++; route.continue(); });

    await page.goto(`${server.base}/converter`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.locator('input[type=file]').first().setInputFiles([
      { name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('Chapter 1: Small\n\nThis one fits.') },
      {
        name: 'big.txt',
        mimeType: 'text/plain',
        buffer: Buffer.concat([Buffer.from('Chapter 1: Big\n\n'), Buffer.alloc(2 * 1024 * 1024, 0x61)]),
      },
    ]);
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /convert/i }).last().click();
    await page.waitForTimeout(9000);

    const body = await page.locator('body').innerText();
    assert.match(body, /2\.0 MB is over the 1\.0 MB/i, `the offender was not named: ${body.match(/[^\n]*limit[^\n]*/)}`);
    assert.equal(sent, 1, `the oversized file was uploaded anyway (${sent} requests)`);
    assert.ok(!/HTTP 413/.test(body), 'a raw status code reached the user');
    assert.deepEqual(page.pageErrors, []);
  });
});

test('a DOCX far over the limit converts anyway, because it is unwrapped here', async () => {
  const docx = await bigDocx(['Chapter 1: Deep Water', 'The tide had gone out further than Marin remembered.'], 6);
  assert.ok(docx.length > 6 * 1024 * 1024, `fixture is only ${docx.length} bytes`);

  await withBrowser(async (context) => {
    const page = await openPage(context);
    let posted = -1;
    await page.route('**/api/book/convert', (route) => {
      posted = (route.request().postDataBuffer() ?? Buffer.alloc(0)).length;
      route.continue();
    });

    await page.goto(`${server.base}/converter`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.locator('input[type=file]').first().setInputFiles({
      name: 'novel.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: docx,
    });
    await page.waitForTimeout(600);
    // DOCX to EPUB is the workflow that broke; the default target is PDF.
    await page.locator('#target-format').selectOption('epub');
    await page.getByRole('button', { name: /convert/i }).last().click();
    await page.waitForTimeout(12_000);

    const body = await page.locator('body').innerText();
    assert.ok(!/is over the/i.test(body), `it was refused for its size: ${body.match(/[^\n]*is over the[^\n]*/)}`);
    assert.ok(!/HTTP 413|too large/i.test(body), `the host rejected it: ${body.match(/[^\n]*(413|too large)[^\n]*/)}`);
    assert.match(body, /novel\.epub/, 'no converted file was produced');

    // The whole point: what left the browser was the manuscript, not the file.
    assert.ok(posted > 0, 'nothing was posted');
    assert.ok(posted < 1024 * 1024, `${posted} bytes was sent for a ${docx.length}-byte file`);
    assert.deepEqual(page.pageErrors, []);
  });
});

test('a whole twenty-chapter book survives the trip', async () => {
  const lines = [];
  for (let c = 1; c <= 20; c++) {
    lines.push(`Chapter ${c}: ${CHAPTER_TITLES[c - 1]}`);
    for (let p = 0; p < 6; p++) {
      lines.push(`Chapter ${c}, paragraph ${p + 1}. ${BODY[(c + p) % BODY.length]}`);
    }
  }
  const docx = await bigDocx(lines, 6);

  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/converter`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // By path rather than by buffer: a large file as base64 over the debug
    // protocol does not arrive, and the page simply never sees it.
    const source = join(tmpdir(), `bookforge-twenty-${process.pid}.docx`);
    writeFileSync(source, docx);
    try {
      await page.locator('input[type=file]').first().setInputFiles(source);
      await page.locator('#target-format').waitFor({ timeout: 60_000 });
      await page.locator('#target-format').selectOption('epub');

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 180_000 }),
        page.getByRole('button', { name: /convert/i }).last().click(),
      ]);

      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      const zip = new AdmZip(Buffer.concat(chunks));
      const names = zip.getEntries().map((e) => e.entryName);

      const chapters = names.filter((n) => /chapter\d+\.xhtml$/.test(n));
      assert.equal(chapters.length, 20, `${chapters.length} chapters came out of a twenty-chapter book`);

      const headings = names
        .filter((n) => /\.xhtml$/.test(n))
        .flatMap((n) => [...zip.readAsText(n).matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)])
        .map((m) => m[1].replace(/<[^>]+>/g, '').trim());
      const repeated = headings.filter((h, i) => headings.indexOf(h) !== i);
      // A title page repeating chapter one is the duplication stores count first.
      assert.deepEqual(repeated, [], `headings appear twice: ${repeated}`);

      const text = names
        .filter((n) => /chapter\d+\.xhtml$/.test(n))
        .map((n) => zip.readAsText(n).replace(/<[^>]+>/g, ' '))
        .join(' ');
      for (const title of CHAPTER_TITLES) {
        assert.ok(text.includes(title), `"${title}" is missing from the EPUB`);
      }
      assert.ok(text.includes('Chapter 20, paragraph 6'), 'the last paragraph of the last chapter was lost');

      const opf = zip.readAsText(names.find((n) => n.endsWith('.opf')));
      assert.match(opf, /<package[^>]*version="3\.0"/, 'not an EPUB 3.0 package');
      assert.deepEqual(page.pageErrors, []);
    } finally {
      rmSync(source, { force: true });
    }
  });
});

test('the reported limit is the one actually enforced', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/converter`, { waitUntil: 'networkidle' });
    const reported = await page.evaluate(async () => (await (await fetch('/api/health')).json()).maxUploadBytes);
    // The client checks against this number, so a wrong one means a bare 413.
    assert.equal(reported, 1024 * 1024, `health reported ${reported}`);
  });
});

test('a conversion produces a valid EPUB and a quality badge', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/converter`, { waitUntil: 'networkidle' });

    const result = await page.evaluate(async () => {
      const form = new FormData();
      form.append('file', new File(['Chapter 1: A\n\nBody text here.'], 'x.txt', { type: 'text/plain' }));
      form.append('targetFormat', 'epub');
      const response = await fetch('/api/book/convert', { method: 'POST', body: form });
      return {
        ok: response.ok,
        valid: response.headers.get('X-Epub-Valid'),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    });

    assert.ok(result.ok, 'conversion failed');
    assert.equal(result.valid, 'true', 'the EPUB did not pass its own structural check');
    assert.ok(result.bytes > 1000, `suspiciously small: ${result.bytes} bytes`);
  });
});

test('the speech view offers voices and states which engine will run', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context, { engine: 'kokoro' });
    await stubSpeech(page);
    await page.goto(`${server.base}/speech`, { waitUntil: 'networkidle' });
    await page.locator('button[aria-label^="Hear "]').first().waitFor({ timeout: 20_000 });

    // The local engine ships 28 voices; the hosted one 30.
    assert.equal(await page.locator('button[aria-label^="Hear "]').count(), 28);
    // It cannot be given a delivery instruction, so the box must be absent.
    assert.equal(await page.locator('span', { hasText: /^Delivery$/ }).count(), 0);

    const body = await page.locator('body').innerText();
    assert.match(body, /CPU core|graphics card is available/i, 'the execution path must be stated, not implied');

    await page.locator('button', { hasText: /Gemini/i }).first().click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('button[aria-label^="Hear "]').count(), 30);
    assert.ok((await page.locator('span', { hasText: /^Delivery$/ }).count()) > 0, 'the hosted engine takes direction');
  });
});

test('every view renders under cross-origin isolation', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    const response = await page.goto(`${server.base}/speech`, { waitUntil: 'networkidle' });

    // Isolation is what enables multi-threaded inference; it is also site-wide,
    // so it is worth proving it did not break anything else.
    assert.equal(response.headers()['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers()['cross-origin-embedder-policy'], 'credentialless');
    assert.equal(await page.evaluate(() => window.crossOriginIsolated), true);
    assert.equal(await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined'), true);

    for (const [path, marker] of [
      ['/converter', /Convert|File Converter/i],
      ['/reader', /Reader/i],
      ['/audiobook', /Audiobook/i],
      ['/check', /Manuscript Check/i],
    ]) {
      await page.goto(`${server.base}${path}`, { waitUntil: 'networkidle' });
      assert.match(await page.locator('body').innerText(), marker, `${path} did not render`);
    }
    assert.deepEqual(page.pageErrors, []);
  });
});
