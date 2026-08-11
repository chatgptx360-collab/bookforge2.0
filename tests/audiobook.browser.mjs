/**
 * Audiobook Studio, driven through the real UI.
 *
 * Covers the failures that only show up in a browser: work lost to a refresh,
 * a section narrated that was meant to be skipped, a redo that re-serves the
 * old clip, and a stop that gets recorded as a failure.
 */

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import {
  CLEAN,
  manuscript,
  narrationSettles,
  openPage,
  startServer,
  stubSpeech,
  upload,
  withBrowser,
} from './harness.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

test('a book narrates, survives a refresh, and is not re-generated', async () => {
  await withBrowser(async (context) => {
    const spoken = [];
    const page = await openPage(context);
    await stubSpeech(page, { onCall: (text) => spoken.push(text) });

    await page.goto(`${server.base}/audiobook`, { waitUntil: 'networkidle' });
    await upload(page, 'Ghost_Signal.txt', manuscript(4));
    await page.getByRole('button', { name: /Narrate the book/i }).click();
    await narrationSettles(page);

    const before = (await page.locator('text=/\\d+\\/\\d+ sections/').first().innerText()).trim();
    assert.match(before, /^(\d+)\/\1 sections/, `run did not complete: ${before}`);
    assert.ok(spoken.length >= 4, `expected a call per section, got ${spoken.length}`);

    // Autosave is what makes an overnight run survivable.
    await page.locator('text=/Saved .* safe to refresh/i').waitFor({ timeout: 20_000 });
    const callsBefore = spoken.length;
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('text=/\\d+\\/\\d+ sections/').first().waitFor({ timeout: 20_000 });

    const after = (await page.locator('text=/\\d+\\/\\d+ sections/').first().innerText()).trim();
    assert.equal(after, before, 'progress was lost across a refresh');
    assert.equal(spoken.length, callsBefore, 'audio was regenerated instead of restored');
    assert.ok((await page.locator('audio').count()) >= 4, 'players were not restored');

    // Restored audio must be real bytes, not an empty placeholder.
    const bytes = await page.evaluate(async () => {
      const src = document.querySelector('audio')?.getAttribute('src');
      return src ? (await (await fetch(src)).arrayBuffer()).byteLength : 0;
    });
    assert.ok(bytes > 10_000, `restored clip was ${bytes} bytes`);
    assert.deepEqual(page.pageErrors, []);
  });
});

test('a skipped section is never sent', async () => {
  await withBrowser(async (context) => {
    const spoken = [];
    const page = await openPage(context);
    await stubSpeech(page, { onCall: (text) => spoken.push(text) });

    // Front matter and a typed contents list, as a real manuscript has.
    const book = [
      'Ghost Signal', '', 'A novel by A. Writer', '',
      'Contents', 'Chapter 1: One ..... 1', 'Chapter 2: Two ..... 14', '',
      'Chapter 1: One', '', 'The keeper was gone.', '',
      'Chapter 2: Two', '', 'She climbed on.',
    ].join('\n');

    await page.goto(`${server.base}/audiobook`, { waitUntil: 'networkidle' });
    await upload(page, 'Front_Matter.txt', book);
    await page.getByRole('button', { name: /Narrate the book/i }).waitFor({ timeout: 20_000 });

    const boxes = page.locator('input[type=checkbox][aria-label^="Narrate "]');
    const states = await boxes.evaluateAll((nodes) =>
      nodes.map((node) => ({ label: node.getAttribute('aria-label'), on: node.checked })),
    );
    const contents = states.find((s) => /contents/i.test(s.label));
    assert.ok(contents && contents.on === false, 'a table of contents must start unticked');

    await page.getByRole('button', { name: /Narrate the book/i }).click();
    await narrationSettles(page);

    assert.ok(!spoken.some((t) => t.includes('.....')), 'the contents list was spoken');
    const progress = (await page.locator('text=/\\d+\\/\\d+ sections/').first().innerText()).trim();
    assert.match(progress, /^(\d+)\/\1 sections/, `${progress} — ${page.narrationError ?? 'no error shown'}`);
    assert.ok(progress.startsWith(`${states.length - 1}/`), `count should exclude the skipped section: ${progress}`);
  });
});

test('redo replaces a section rather than re-serving it', async () => {
  await withBrowser(async (context) => {
    // A different pitch on the second pass proves the audio is genuinely new;
    // a redo that quietly returned the cached clip would otherwise pass.
    let pass = 0;
    const spoken = [];
    const page = await openPage(context);
    await page.route('**/api/tts/speak', async (route) => {
      const said = JSON.parse(route.request().postData() || '{}').text ?? '';
      spoken.push(said);
      const { tone } = await import('./harness.mjs');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          audioBase64: tone(said, pass === 0 ? 440 : 880),
          mimeType: 'audio/L16;codec=pcm;rate=24000',
          sampleRate: 24000,
        }),
      });
    });

    await page.goto(`${server.base}/audiobook`, { waitUntil: 'networkidle' });
    await upload(page, 'Redo.txt', manuscript(3));
    await page.getByRole('button', { name: /Narrate the book/i }).click();
    await narrationSettles(page);

    const crossings = () =>
      page.evaluate(async () => {
        const src = document.querySelector('audio')?.getAttribute('src');
        const buffer = await (await fetch(src)).arrayBuffer();
        const pcm = new Int16Array(buffer, 44);
        let count = 0;
        for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) count++;
        return { count, bytes: buffer.byteLength };
      });

    const before = await crossings();
    pass = 1;
    const callsBefore = spoken.length;

    await page.locator('button[aria-label^="Redo "]').first().click();
    await page.waitForFunction(() => !document.body.innerText.includes('Stop after this chapter'), null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(500);
    const after = await crossings();

    assert.equal(spoken.length - callsBefore, 1, 'redo must re-speak exactly one section');
    assert.ok(after.count > before.count * 1.5, `audio was not replaced (${before.count} -> ${after.count})`);
    assert.ok(Math.abs(after.bytes - before.bytes) < before.bytes * 0.2, 'the clip was appended, not replaced');
    assert.equal(await page.locator('audio').count(), 3, 'other sections were disturbed');
  });
});

test('stopping keeps finished work and is not reported as a failure', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await stubSpeech(page, { delayMs: 1200 });

    await page.goto(`${server.base}/audiobook`, { waitUntil: 'networkidle' });
    await upload(page, 'Stop.txt', manuscript(8));
    await page.getByRole('button', { name: /Narrate the book/i }).click();
    await page.locator('text=/Stop after this chapter/i').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: /Stop after this chapter/i }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Stop after this chapter'), null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(600);

    assert.equal(await page.locator('p.text-red-400').count(), 0, 'a stopped section was marked failed');
    assert.equal(await page.locator('[role=alert]').count(), 0, 'stopping raised an error banner');
    assert.equal(await page.getByRole('button', { name: /^Retry \d+$/ }).count(), 0, 'stopping offered a retry');

    const progress = (await page.locator('text=/\\d+\\/\\d+ sections/').first().innerText()).trim();
    assert.match(progress, /^[1-9]/, `finished sections were discarded: ${progress}`);
  });
});

test('a clean manuscript narrates without a single flagged section', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await stubSpeech(page);
    await page.goto(`${server.base}/audiobook`, { waitUntil: 'networkidle' });
    await upload(page, 'Low_Water.txt', CLEAN);
    await page.getByRole('button', { name: /Narrate the book/i }).click();
    await narrationSettles(page);

    assert.equal(await page.locator('p.text-red-400').count(), 0);
    assert.deepEqual(page.pageErrors, []);
  });
});
