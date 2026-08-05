/**
 * Converter and speech views, driven through the real UI.
 *
 * The upload case is here because it shipped broken: the app advertised a
 * limit the platform did not honour, and twenty-three files became seven with
 * a bare 413. The test asserts the file is refused *before* it is sent.
 */

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { openPage, startServer, stubSpeech, upload, withBrowser } from './harness.mjs';

let server;
// One megabyte, so an oversized file is cheap to construct.
before(async () => { server = await startServer({ MAX_UPLOAD_MB: '1' }); });
after(async () => { await server?.stop(); });

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
