/**
 * Line Bank, driven through the real UI.
 *
 * The planning is covered by unit tests; what only a browser can answer is
 * whether a run actually produces an archive — the loop, the encoder and the
 * zip together. The hosted engine is used here so the speech route can be
 * stubbed: the point is the bank, not the model, and the local engine would
 * mean a 92 MB download inside a test.
 */

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { openPage, startServer, stubSpeech, withBrowser } from './harness.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

test('a list and a template become an archive of clips', async () => {
  await withBrowser(async (context) => {
    const spoken = [];
    const page = await openPage(context, { engine: 'gemini' });
    await stubSpeech(page, { onCall: (text) => spoken.push(text) });
    await page.goto(`${server.base}/lines`, { waitUntil: 'networkidle' });

    await page.locator('textarea').first().fill('Ada Hegerberg\nSam Kerr\nMicky van de Ven');
    // Third box is templates; {} marks where an entry is spoken.
    await page.locator('textarea').nth(2).fill('And it is {} with the finish!');
    await page.locator('button', { hasText: /Last name only/i }).click();
    await page.waitForTimeout(400);

    // Three surnames plus the two halves of the template.
    const summary = await page.locator('body').innerText();
    assert.match(summary, /Clips to make\s*5/i, `plan is wrong: ${summary.match(/Clips to make[^\n]*/)}`);

    await page.locator('button', { hasText: /Build 5 clips/i }).click();
    const link = page.locator('a[download$=".zip"]');
    await link.waitFor({ timeout: 120_000 });

    // Every clip was actually asked for, and the surname rule was applied.
    assert.equal(spoken.length, 5, `spoke ${spoken.length}: ${spoken}`);
    assert.ok(spoken.includes('van de Ven'), `particle dropped: ${spoken}`);
    assert.ok(spoken.includes('Hegerberg') && !spoken.includes('Ada Hegerberg'), `${spoken}`);
    assert.ok(spoken.includes('And it is'), `template not split: ${spoken}`);

    assert.match(await link.getAttribute('download'), /line-bank-5\.zip/);
    assert.deepEqual(page.pageErrors, []);
  });
});

test('a bank is not offered before there is anything to say', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context, { engine: 'gemini' });
    await page.goto(`${server.base}/lines`, { waitUntil: 'networkidle' });

    // Nothing entered: the button must not invite a run that would do nothing.
    const build = page.locator('button', { hasText: /^Build/i }).first();
    assert.equal(await build.isDisabled(), true, 'an empty bank was offered');
    assert.equal(await page.locator('a[download$=".zip"]').count(), 0);
  });
});
