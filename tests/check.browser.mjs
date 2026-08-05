/**
 * Manuscript Check, driven through the real UI.
 *
 * The property that matters most is negative: the fix must only ever delete.
 * A "fix" that invents or reorders a sentence would corrupt a book silently,
 * so that is asserted directly against the original text rather than inferred.
 */

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CLEAN, FLAWED, openPage, startServer, upload, withBrowser } from './harness.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

test('the check finds what a store would reject', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/check`, { waitUntil: 'networkidle' });
    await upload(page, 'Ghost_Signal.txt', FLAWED);
    await page.locator('text=/Fixable automatically|Needs rewriting/i').first().waitFor({ timeout: 30_000 });

    const body = await page.locator('body').innerText();
    assert.match(body, /duplicated paragraph/i, 'the repeated paragraph was missed');
    assert.match(body, /typed table of contents/i, 'the typed contents was missed');
    assert.match(body, /same line of dialogue/i, 'the repeated dialogue was missed');

    // Findings quote the text, so a claim can be checked rather than believed.
    assert.match(body, /Shut up, VERNA/);
    // The two kinds of finding are kept apart, because only one is safe to fix.
    assert.match(body, /Fixable automatically/i);
    assert.match(body, /Needs rewriting/i);
    // No score: ours would measure different things from the store's.
    assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(body), 'a score was shown');
    assert.deepEqual(page.pageErrors, []);
  });
});

test('fixing removes repetition and never invents text', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/check`, { waitUntil: 'networkidle' });
    await upload(page, 'Ghost_Signal.txt', FLAWED);
    await page.getByRole('button', { name: 'Fix errors', exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Fix errors', exact: true }).click();
    await page.locator('text=/what changed|nothing needed removing/i').waitFor({ timeout: 30_000 });

    const after = await page.locator('body').innerText();
    assert.match(after, /Removed \d+ duplicated paragraph/i);
    // Prose problems must not be silently cleared by a fix that cannot fix them.
    assert.match(after, /same line of dialogue/i);

    const wait = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /Download cleaned text/i }).click();
    const cleaned = await readFile(await (await wait).path(), 'utf8');

    assert.ok(cleaned.includes('Thorne stared at the console'), 'prose was lost');
    assert.equal(cleaned.split('Thorne stared at the console').length - 1, 1, 'the duplicate survived');
    assert.ok(!cleaned.includes('.....'), 'the typed contents survived');

    // The guarantee: every surviving paragraph came from the original, in order.
    let cursor = -1;
    for (const paragraph of cleaned.split('\n\n').map((p) => p.trim()).filter(Boolean)) {
      const at = FLAWED.indexOf(paragraph, cursor + 1);
      assert.ok(at > cursor, `"${paragraph.slice(0, 40)}" was invented or reordered`);
      cursor = at;
    }
  });
});

test('clean prose is not flagged and no promise is made about acceptance', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/check`, { waitUntil: 'networkidle' });
    await upload(page, 'Low_Water.txt', CLEAN);
    await page.locator('text=/Nothing flagged|Fixable automatically|Needs rewriting/i').first().waitFor({
      timeout: 30_000,
    });

    const body = await page.locator('body').innerText();
    assert.match(body, /Nothing flagged/i, `false positives: ${body.match(/[^\n]*(issue|flag)[^\n]*/g)?.join(' | ')}`);
    assert.match(body, /does not promise/i, 'a clean result must not imply a store will accept it');
  });
});

test('revising prose refuses a reply that is not a rewrite', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);

    // Stand in for the model with the replies that would wreck a book: a
    // summary, and a note about the task. Both must be refused, leaving the
    // original in place rather than corrupting the manuscript.
    await page.route('**/api/book/revise', async (route) => {
      const { text } = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text,
          changes: [],
          revised: 0,
          skipped: 3,
          targets: 3,
          rejected: [{ index: 1, reason: 'the reply talks about the text instead of being it' }],
          before: { findings: [], stats: {}, fixableCount: 0 },
          after: { findings: [], stats: { words: 0, chapters: 0, vocabularyRatio: 0, duplicateParagraphs: 0 }, fixableCount: 0 },
        }),
      });
    });

    await page.goto(`${server.base}/check`, { waitUntil: 'networkidle' });
    await upload(page, 'Ghost_Signal.txt', FLAWED);
    await page.getByRole('button', { name: 'Revise prose', exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Revise prose', exact: true }).click();
    await page.locator('text=/Rewrote 0 of 3/i').waitFor({ timeout: 30_000 });

    const body = await page.locator('body').innerText();
    assert.match(body, /kept unchanged because the rewrite failed its check/i,
      'a refused rewrite must be reported, not hidden');

    const wait = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /Download cleaned text/i }).click();
    const out = await readFile(await (await wait).path(), 'utf8');
    assert.ok(out.includes('Thorne stared at the console'), 'the original prose must survive a refused rewrite');
  });
});

test('the revise button explains that it changes the author\'s words', async () => {
  await withBrowser(async (context) => {
    const page = await openPage(context);
    await page.goto(`${server.base}/check`, { waitUntil: 'networkidle' });
    await upload(page, 'Ghost_Signal.txt', FLAWED);
    await page.getByRole('button', { name: 'Revise prose', exact: true }).waitFor({ timeout: 30_000 });

    const body = await page.locator('body').innerText();
    assert.match(body, /rewrites your words/i, 'the consequence must be stated before the button is pressed');
    assert.match(body, /Read the result before you publish/i);
  });
});
