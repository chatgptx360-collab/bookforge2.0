import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  convertTextToDocx,
  convertTextToEpub,
  convertTextToPdf,
  convertTextToRtf,
  createZipArchive,
  decodeHtmlEntities,
  extractEpubText,
  extractTextFromFile,
  parseDocumentStructure,
  parseRtfToText,
  robustJsonParse,
} = require('../server-build/server.cjs');

const MANUSCRIPT = [
  'The Cartographer of Small Hours',
  'A Novel',
  'by Imogen Vale',
  '',
  'Copyright © 2026 by Imogen Vale',
  'All rights reserved. No part of this book may be reproduced without permission.',
  'ISBN-13: 978-0-00-000000-0',
  '',
  'Table of Contents',
  'Chapter 1: The Lighthouse ....... 1',
  'Chapter 2: Tidewrack ....... 24',
  '',
  'Chapter 1: The Lighthouse',
  '',
  'The lamp had not turned in eleven years, and still Marin climbed.',
  '',
  '***',
  '',
  'By dawn the fog had swallowed the jetty whole.',
  '',
  'Chapter 2: Tidewrack',
  '',
  'Salt crusted the hinges of the door she had promised never to open.',
].join('\n');

test('parseDocumentStructure identifies front matter and chapters', () => {
  const parsed = parseDocumentStructure(MANUSCRIPT);

  assert.equal(parsed.title, 'The Cartographer of Small Hours');
  assert.equal(parsed.author, 'Imogen Vale');

  const types = parsed.sections.map((s) => s.type);
  assert.ok(types.includes('title'), 'expected a title section');
  assert.ok(types.includes('copyright'), 'expected a copyright section');
  assert.ok(types.includes('toc'), 'expected a table of contents section');

  const chapters = parsed.sections.filter((s) => s.type === 'chapter');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].chapterNumber, 1);
  assert.equal(chapters[0].title, 'Chapter 1: The Lighthouse');
  assert.match(chapters[0].content, /Marin climbed/);
  // TOC lines must not be mistaken for chapter headings.
  assert.ok(!chapters[0].content.includes('.......'));
});

test('parseDocumentStructure falls back to a single chapter', () => {
  const parsed = parseDocumentStructure('Just a short note with no headings at all.');
  const chapters = parsed.sections.filter((s) => s.type === 'chapter');
  assert.equal(chapters.length, 1);
  assert.match(chapters[0].content, /short note/);
});

test('EPUB output is a valid EPUB 3.0 package', async () => {
  const buffer = convertTextToEpub(MANUSCRIPT, 'The Cartographer of Small Hours', 'Imogen Vale');

  // mimetype must be the first entry, stored uncompressed, at a fixed offset.
  assert.equal(buffer.subarray(30, 38).toString('ascii'), 'mimetype');
  assert.equal(buffer.readUInt16LE(8), 0, 'mimetype must use the "store" method');
  assert.equal(buffer.subarray(38, 58).toString('ascii'), 'application/epub+zip');

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  const names = zip.getEntries().map((e) => e.entryName);

  assert.ok(names.includes('META-INF/container.xml'));
  assert.ok(names.includes('OEBPS/content.opf'));
  assert.ok(names.includes('OEBPS/nav.xhtml'));
  assert.ok(names.includes('OEBPS/stylesheet.css'));
  assert.ok(!names.some((n) => n.endsWith('.ncx')), 'EPUB 3.0 output must not ship an NCX');

  const opf = zip.readAsText('OEBPS/content.opf');
  assert.match(opf, /version="3\.0"/);
  assert.match(opf, /<meta property="dcterms:modified">/);
  assert.match(opf, /properties="nav"/);

  const nav = zip.readAsText('OEBPS/nav.xhtml');
  assert.match(nav, /epub:type="toc"/);
  assert.match(nav, /chapter1\.xhtml/);

  // Every spine idref must resolve to a manifest item.
  const manifestIds = [...opf.matchAll(/<item\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(spineIds.length > 0);
  for (const id of spineIds) assert.ok(manifestIds.includes(id), `spine idref ${id} missing from manifest`);

  // Round-trip: the EPUB reader recovers the prose.
  const recovered = extractEpubText(buffer);
  assert.match(recovered, /The lamp had not turned in eleven years/);
  assert.match(recovered, /Salt crusted the hinges/);
});

test('DOCX output is a readable OOXML package', async () => {
  const buffer = await convertTextToDocx(MANUSCRIPT, 'Test Manuscript');
  assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');

  const text = await extractTextFromFile(buffer, 'roundtrip.docx');
  assert.match(text, /Marin climbed/);
  assert.match(text, /Chapter 2: Tidewrack/);
});

test('PDF output is a well-formed PDF', async () => {
  const buffer = await convertTextToPdf(MANUSCRIPT, 'Test Manuscript');
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(buffer.includes(Buffer.from('%%EOF')));

  const text = await extractTextFromFile(buffer, 'roundtrip.pdf');
  assert.match(text, /Marin climbed/);
});

test('PDF generation survives characters outside WinAnsi', async () => {
  const exotic = 'Chapter 1: Beginnings\n\n“Smart quotes” — em dashes — ❦ fleurons — 日本語 text.';
  const buffer = await convertTextToPdf(exotic, 'Unicode Test');
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('RTF round-trips through the parser', () => {
  const rtf = convertTextToRtf(MANUSCRIPT, 'Test Manuscript');
  assert.ok(rtf.startsWith('{\\rtf1'));
  assert.ok(rtf.trim().endsWith('}'));

  const text = parseRtfToText(rtf);
  assert.match(text, /Marin climbed/);
  assert.match(text, /Salt crusted the hinges/);
  assert.ok(!text.includes('\\pard'), 'control words must be stripped');
});

test('parseRtfToText decodes escapes', () => {
  const text = parseRtfToText("{\\rtf1\\ansi Caf\\'e9 \\u8212? end\\par}");
  assert.match(text, /Café/);
  assert.match(text, /—/);
});

test('createZipArchive produces an archive other readers can open', () => {
  const buffer = createZipArchive([
    { name: 'stored.txt', data: Buffer.from('hello'), store: true },
    { name: 'nested/deflated.txt', data: Buffer.from('world'.repeat(200)) },
  ]);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  assert.equal(zip.readAsText('stored.txt'), 'hello');
  assert.equal(zip.readAsText('nested/deflated.txt'), 'world'.repeat(200));
});

test('decodeHtmlEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeHtmlEntities('a &amp; b &#8212; c &#x2014; d &rsquo;e'), 'a & b — c — d ’e');
  assert.equal(decodeHtmlEntities('&unknownentity;'), '&unknownentity;');
});

test('robustJsonParse recovers from fenced and truncated JSON', () => {
  assert.deepEqual(robustJsonParse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(robustJsonParse('Sure! {"a":1,"b":[2,3]} hope that helps'), { a: 1, b: [2, 3] });

  const truncated = robustJsonParse('{"chapters":[{"title":"One","text":"unfinished pro');
  assert.ok(Array.isArray(truncated.chapters));
  assert.equal(truncated.chapters[0].title, 'One');
});

test('extractTextFromFile rejects unknown extensions', async () => {
  await assert.rejects(() => extractTextFromFile(Buffer.from('x'), 'file.xyz'), /Unsupported file type/);
});

test('reflowPdfText rebuilds paragraphs from printed lines', () => {
  const { reflowPdfText } = require('../server-build/server.cjs');
  const raw = [
    'The Test Book',
    'This is a long opening paragraph that will certainly wrap across several printed lines once it is laid',
    'out on an A4 page at eleven point Helvetica, which is exactly the situation we want to inspect',
    'closely.',
    '',
    'A second short paragraph with a hyphen-',
    'ated word inside it.',
    '-- 1 of 2 --',
    'The Test Book',
    'Chapter 2: Onwards',
    'More prose here.',
    '-- 2 of 2 --',
  ].join('\n');

  const out = reflowPdfText(raw);
  assert.ok(!/-- \d+ of \d+ --/.test(out), 'page markers must be stripped');
  assert.match(out, /laid out on an A4 page/, 'wrapped lines must rejoin');
  assert.match(out, /hyphenated word/, 'hyphenation across lines must be repaired');
  assert.match(out, /^Chapter 2: Onwards$/m, 'headings stay on their own line');
  // "The Test Book" is a running head on both pages; it should survive once at most.
  assert.ok((out.match(/The Test Book/g) ?? []).length <= 1, 'running heads must be dropped');
});

test('sniffFormat identifies real file types', () => {
  const { sniffFormat, convertTextToEpub } = require('../server-build/server.cjs');
  assert.equal(sniffFormat(Buffer.from('%PDF-1.7\n...')), 'pdf');
  assert.equal(sniffFormat(Buffer.from('{\\rtf1\\ansi hello}')), 'rtf');
  assert.equal(sniffFormat(Buffer.from('Just some plain text')), 'txt');
  assert.equal(sniffFormat(convertTextToEpub('Chapter 1: A\n\nBody.', 'T')), 'epub');
  assert.equal(sniffFormat(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])), null);
});

test('extractTextFromFile rejects a file whose bytes are not readable', async () => {
  const { extractTextFromFile } = require('../server-build/server.cjs');
  // A .txt containing NUL bytes is not text.
  await assert.rejects(
    () => extractTextFromFile(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'trap.txt'),
    /not a readable/i,
  );
});

test('DOCX emphasis and headings survive a conversion', async () => {
  const { htmlToBlocks, blocksToDocx, blocksToEpub, blocksToRtf, blockText, extractBlocksFromFile } =
    require('../server-build/server.cjs');

  const html = `<html><body>
    <h1>Chapter 1: The Lighthouse</h1>
    <p>The lamp was <strong>cold</strong> and the keeper was <em>gone</em>.</p>
    <blockquote>Nothing burns forever.</blockquote>
    <ul><li>First finding</li><li>Second finding</li></ul>
    <hr/>
    <h2>Later</h2>
    <p>She climbed again.</p>
  </body></html>`;

  const blocks = htmlToBlocks(html);
  const kinds = blocks.map((b) => b.type);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'quote', 'listItem', 'listItem', 'scene', 'heading', 'paragraph']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[6].level, 2);

  const styled = blocks[1].runs;
  assert.ok(styled.some((r) => r.text === 'cold' && r.bold), 'bold run preserved');
  assert.ok(styled.some((r) => r.text === 'gone' && r.italic), 'italic run preserved');
  assert.equal(blockText(blocks[1]), 'The lamp was cold and the keeper was gone.');

  // DOCX keeps the emphasis in the XML.
  const docx = await blocksToDocx(blocks, 'Styled');
  const AdmZip = require('adm-zip');
  const xml = new AdmZip(docx).readAsText('word/document.xml');
  assert.match(xml, /<w:b\b/, 'bold run reaches the DOCX');
  assert.match(xml, /<w:i\b/, 'italic run reaches the DOCX');

  // Round trip back through the DOCX reader keeps the styling.
  const reparsed = await extractBlocksFromFile(docx, 'styled.docx');
  const flatRuns = reparsed.flatMap((b) => b.runs);
  assert.ok(flatRuns.some((r) => r.bold && r.text.includes('cold')), 'bold survives the round trip');
  assert.ok(flatRuns.some((r) => r.italic && r.text.includes('gone')), 'italic survives the round trip');

  // EPUB keeps semantic tags rather than flattening to <p>.
  const epub = new AdmZip(blocksToEpub(blocks, 'Styled', 'Tester'));
  const chapter = epub.readAsText('OEBPS/chapter1.xhtml');
  assert.match(chapter, /<strong>cold<\/strong>/);
  assert.match(chapter, /<em>gone<\/em>/);
  assert.match(chapter, /<blockquote>/);
  assert.match(chapter, /<li>First finding<\/li>/);
  assert.match(chapter, /<hr class="scene"\/>/);
  // An h2 is a sub-heading inside the chapter, not a new chapter file.
  assert.match(chapter, /<h2>Later<\/h2>/);
  assert.equal(epub.getEntries().filter((e) => /chapter\d+\.xhtml$/.test(e.entryName)).length, 1);

  // RTF carries the same emphasis.
  const rtf = blocksToRtf(blocks, 'Styled');
  assert.match(rtf, /\\b cold\\b0/);
  assert.match(rtf, /\\i gone\\i0/);
});

test('PDF renders styled runs without throwing', async () => {
  const { htmlToBlocks, blocksToPdf } = require('../server-build/server.cjs');
  const blocks = htmlToBlocks('<p>Plain <strong>bold</strong> and <em>italic</em> and <strong><em>both</em></strong>.</p>');
  const pdf = await blocksToPdf(blocks, 'Styled');
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('EPUB accepts a cover and store metadata', () => {
  const { blocksToEpub, textToBlocks, validateEpubStructure } = require('../server-build/server.cjs');
  const AdmZip = require('adm-zip');

  // 1x1 transparent PNG.
  const cover = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const epub = blocksToEpub(textToBlocks('Chapter 1: Alpha\n\nBody text.'), 'Metadata Test', {
    author: 'Imogen Vale',
    language: 'fr',
    publisher: 'Small Hours Press',
    isbn: '978-0-00-000000-0',
    series: 'The Tidewrack Cycle',
    cover: { data: cover, mimeType: 'image/png' },
  });

  const zip = new AdmZip(epub);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('OEBPS/cover.png'), 'cover image is packaged');
  assert.ok(names.includes('OEBPS/cover.xhtml'), 'cover page is packaged');

  const opf = zip.readAsText('OEBPS/content.opf');
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /<dc:identifier id="BookID">urn:isbn:978-0-00-000000-0<\/dc:identifier>/);
  assert.match(opf, /<dc:language>fr<\/dc:language>/);
  assert.match(opf, /<dc:publisher>Small Hours Press<\/dc:publisher>/);
  assert.match(opf, /belongs-to-collection/);
  assert.match(opf, /<itemref idref="cover"\/>/);

  assert.deepEqual(validateEpubStructure(epub), {
    valid: true,
    epubVersion: '3.0',
    isEpub3: true,
    errors: [],
    warnings: [],
  });
});

test('validateEpubStructure reports real structural problems', () => {
  const { convertTextToEpub, validateEpubStructure, createZipArchive } = require('../server-build/server.cjs');

  const good = convertTextToEpub('Chapter 1: Alpha\n\nBody.', 'Good');
  const goodResult = validateEpubStructure(good);
  assert.equal(goodResult.valid, true);
  // No cover was supplied, so the check should say so without failing.
  assert.ok(goodResult.warnings.some((w) => /cover/i.test(w)));

  // An archive whose mimetype is neither first nor stored must be rejected.
  const bad = createZipArchive([
    { name: 'META-INF/container.xml', data: Buffer.from('<container/>') },
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
  ]);
  const badResult = validateEpubStructure(bad);
  assert.equal(badResult.valid, false);
  assert.ok(badResult.errors.some((e) => /mimetype/i.test(e)));

  assert.equal(validateEpubStructure(Buffer.from('not a zip at all')).valid, false);
});

// --- speech planning -------------------------------------------------------

test('speech planning keeps chunks under the limit and loses no text', () => {
  const { planSpeechChunks } = require('../server-build/server.cjs');

  const paragraphs = [];
  for (let i = 0; i < 12; i++) paragraphs.push(`Paragraph ${i}. ` + 'word '.repeat(60).trim() + '.');
  const source = paragraphs.join('\n\n');

  const chunks = planSpeechChunks(source, 900);
  assert.ok(chunks.length > 1, 'a long passage is split');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 900, `chunk of ${chunk.length} exceeds the limit`);
    assert.equal(chunk, chunk.trim(), 'chunks carry no stray whitespace');
  }
  // Nothing may be dropped: every word survives, in order.
  const words = (text) => text.split(/\s+/).filter(Boolean);
  assert.deepEqual(words(chunks.join(' ')), words(source), 'no text is lost or reordered');
});

test('an oversized paragraph is broken at sentence ends, not mid-word', () => {
  const { planSpeechChunks } = require('../server-build/server.cjs');

  const sentence = 'She climbed the stair and the lamp turned once more in the dark.';
  const chunks = planSpeechChunks(Array(40).fill(sentence).join(' '), 400);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 400);
    assert.match(chunk, /[.!?…]$/, 'each chunk ends on a sentence boundary');
  }
});

test('short text is spoken in a single request', () => {
  const { planSpeechChunks } = require('../server-build/server.cjs');
  assert.deepEqual(planSpeechChunks('Just one line.'), ['Just one line.']);
  assert.deepEqual(planSpeechChunks('   '), []);
});

test('the voice catalogue is well formed', () => {
  const { TTS_VOICES } = require('../server-build/server.cjs');
  assert.ok(TTS_VOICES.length >= 20, 'a real catalogue of narrators is offered');

  const names = new Set();
  const ids = new Set();
  for (const voice of TTS_VOICES) {
    // The id is what the model is asked for; the name is what a person reads.
    assert.ok(voice.id && !ids.has(voice.id), `duplicate or missing id: ${voice.id}`);
    ids.add(voice.id);
    assert.ok(voice.name && !names.has(voice.name), `duplicate or missing name: ${voice.name}`);
    assert.notEqual(voice.name, voice.id, `${voice.id} still shows its raw id as a name`);
    names.add(voice.name);
    assert.ok(voice.character && voice.goodFor, `${voice.name} is missing its description`);
    assert.ok(
      ['warm', 'bright', 'deep', 'clear'].includes(voice.timbre),
      `${voice.name} has an unknown timbre ${voice.timbre}`,
    );
    // The picker renders a gender icon per row, so every voice needs one.
    assert.ok(['male', 'female'].includes(voice.gender), `${voice.name} has no gender: ${voice.gender}`);
    assert.ok(
      Array.isArray(voice.bestFor) && voice.bestFor.length >= 2 && voice.bestFor.every((use) => use.trim()),
      `${voice.name} needs at least two concrete uses`,
    );
  }
  // The default the UI ships with must exist in the catalogue, by id.
  assert.ok(ids.has('Sulafat'));
  // Both genders must be usefully represented, or the filter is pointless.
  for (const gender of ['male', 'female']) {
    const count = TTS_VOICES.filter((voice) => voice.gender === gender).length;
    assert.ok(count >= 8, `only ${count} ${gender} voices`);
  }

  // The whole point of the display names is that the gender reads off the name,
  // so the two must never drift apart.
  const FEMALE_NAMES = new Set([
    'Ava', 'Chloe', 'Naomi', 'Nadia', 'Sofia', 'Elena', 'Margaret',
    'Diana', 'Isla', 'Lily', 'Vivian', 'Clara', 'Rose', 'Zoe',
  ]);
  const MALE_NAMES = new Set([
    'Adam', 'Hank', 'Julian', 'Nathan', 'David', 'Elliot', 'Max', 'Ethan',
    'Marcus', 'Charlie', 'Simon', 'Theo', 'Arthur', 'Daniel', 'Owen', 'Jesse',
  ]);
  for (const voice of TTS_VOICES) {
    const expected = voice.gender === 'female' ? FEMALE_NAMES : MALE_NAMES;
    assert.ok(
      expected.has(voice.name),
      `${voice.name} (${voice.id}) is marked ${voice.gender} but is not in that name list`,
    );
  }
});

test('a daily quota is told apart from a per-minute one', () => {
  const { describeQuota } = require('../server-build/server.cjs');

  // The exact shape the API returns when the free tier's daily cap is spent.
  const daily = describeQuota(
    'You exceeded your current quota, please check your plan and billing details. ' +
      'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
      'limit: 10, model: gemini-2.5-flash-tts. Please retry in 32.842259908s. ' +
      '{"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure",' +
      '"violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",' +
      '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"10"}]},' +
      '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"32s"}]}',
  );

  assert.equal(daily.scope, 'day');
  assert.equal(daily.limit, 10);
  // Waiting 32s for an allowance that refills tomorrow would waste the user's
  // time and still fail, so no retry is offered.
  assert.equal(daily.retryAfterSeconds, 0);
  assert.match(daily.message, /per day/);
  assert.match(daily.message, /resets? at midnight Pacific/i);
  assert.ok(!/\{|"quotaId"/.test(daily.message), 'the raw JSON is not shown to the user');

  const perMinute = describeQuota(
    'Quota exceeded for metric: generate_content_free_tier_requests, limit: 3. ' +
      '{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"3"}],' +
      '"retryDelay":"21s"}',
  );
  assert.equal(perMinute.scope, 'minute');
  assert.equal(perMinute.limit, 3);
  assert.ok(perMinute.retryAfterSeconds >= 21 && perMinute.retryAfterSeconds <= 30, perMinute.retryAfterSeconds);
  assert.match(perMinute.message, /per minute/);

  // A bare 429 with nothing parseable must still produce a usable wait.
  const bare = describeQuota('429 RESOURCE_EXHAUSTED');
  assert.equal(bare.scope, 'minute');
  assert.ok(bare.retryAfterSeconds > 0);
});

test('EPUB output is declared 3.0 and free of EPUB 2 constructs', () => {
  const { convertTextToEpub, validateEpubStructure } = require('../server-build/server.cjs');
  const AdmZip = require('adm-zip');

  const epub = convertTextToEpub('Chapter 1: Alpha\n\nBody text here.', 'Version Test', 'Tester');
  const opf = new AdmZip(epub).readAsText('OEBPS/content.opf');

  // Retailers read this attribute; EPUB 3.x always declares exactly "3.0".
  assert.match(opf, /<package[^>]*version="3\.0"/);
  assert.ok(!/<spine[^>]*\btoc=/i.test(opf), 'no EPUB 2 spine toc attribute');
  assert.ok(!/<guide[\s>]/i.test(opf), 'no EPUB 2 guide element');
  assert.match(opf, /<meta property="dcterms:modified">/);

  const check = validateEpubStructure(epub);
  assert.equal(check.epubVersion, '3.0');
  assert.equal(check.isEpub3, true);
  assert.equal(check.valid, true);
  assert.deepEqual(check.errors, []);
});

test('an EPUB 2 package is rejected, not quietly accepted', () => {
  const { createZipArchive, validateEpubStructure } = require('../server-build/server.cjs');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookID">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookID">urn:uuid:x</dc:identifier>
    <dc:title>Old Book</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
  <guide><reference type="text" href="ch1.xhtml"/></guide>
</package>`;

  const epub2 = createZipArchive([
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
    },
    { name: 'content.opf', data: Buffer.from(opf) },
    { name: 'ch1.xhtml', data: Buffer.from('<html><body><p>Old</p></body></html>') },
    { name: 'toc.ncx', data: Buffer.from('<ncx/>') },
  ]);

  const check = validateEpubStructure(epub2);
  assert.equal(check.epubVersion, '2.0');
  assert.equal(check.isEpub3, false);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => /EPUB 3\.0 will reject it/.test(e)), check.errors.join(' | '));
  assert.ok(check.warnings.some((w) => /guide/.test(w)));
  assert.ok(check.warnings.some((w) => /toc attribute/.test(w)));
});

// --- local speech splitting -------------------------------------------------
//
// The model truncates over-long input silently, so the splitter is the only
// thing standing between a book and audio that quietly loses half its words.

test('no piece can reach the model input limit', async () => {
  const { splitForKokoro } = await import('../src/utils/kokoro.ts');

  const cases = [
    'Short line.',
    Array(60).fill('She climbed the stair and the lamp turned once more.').join(' '),
    // The dangerous case: one sentence, no terminal punctuation, far too long.
    'word '.repeat(900).trim(),
    // Clause-heavy prose with no full stop for a very long stretch.
    Array(80).fill('and then, quietly, she went on').join(', '),
    'A'.repeat(2000),
  ];

  for (const source of cases) {
    const pieces = splitForKokoro(source);
    for (const piece of pieces) {
      assert.ok(piece.length <= 320, `piece of ${piece.length} chars exceeds the safe limit`);
    }
    // Nothing may be dropped. Compared without whitespace, because a run with
    // no spaces in it has to be broken somewhere and that break adds one.
    const bare = (t) => t.replace(/\s+/g, '');
    assert.equal(bare(pieces.join('')), bare(source), 'text was lost while splitting');
  }
});

test('splitting prefers sentence ends over mid-sentence cuts', async () => {
  const { splitForKokoro } = await import('../src/utils/kokoro.ts');
  const pieces = splitForKokoro(Array(12).fill('The keeper was gone and the light had failed.').join(' '));
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.match(piece, /\.$/, 'a piece ended mid-sentence');
});

test('a restored voice is never handed to the wrong engine', async () => {
  const { voiceForEngine } = await import('../src/utils/kokoroVoices.ts');

  // The bug this guards: a Gemini voice surviving a switch to the local engine,
  // which then fails with "voice not found" on every chapter.
  assert.equal(voiceForEngine('kokoro', 'Sulafat'), 'af_heart');
  assert.equal(voiceForEngine('gemini', 'af_heart'), 'Sulafat');
  // A valid pairing is left alone.
  assert.equal(voiceForEngine('kokoro', 'bm_george'), 'bm_george');
  assert.equal(voiceForEngine('gemini', 'Orus'), 'Orus');
  // Missing or unknown falls back to that engine's default.
  assert.equal(voiceForEngine('kokoro', undefined), 'af_heart');
  assert.equal(voiceForEngine('kokoro', 'not_a_voice'), 'af_heart');
  assert.equal(voiceForEngine('gemini', undefined), 'Sulafat');
});

test('a scene break becomes a pause, not an utterance', async () => {
  const { splitForKokoro, hasNoSpeech } = await import('../src/utils/kokoro.ts');

  // These reach the model as pieces of their own and phonemise to nothing.
  for (const marker of ['***', '❦', '---', '…', '* * *', '§']) {
    assert.ok(hasNoSpeech(marker), `${marker} should be recognised as unspeakable`);
  }
  for (const words of ['The rain stopped.', 'Chapter 3', 'It was 1943.', '"No," he said.']) {
    assert.ok(!hasNoSpeech(words), `${words} contains speech`);
  }

  // A break sitting between two full-length sentences ends up as a piece of
  // its own — that is the case that used to be handed to the model.
  const pieces = splitForKokoro('A'.repeat(318) + '.\n\n***\n\n' + 'B'.repeat(318) + '.');
  assert.ok(pieces.some((piece) => hasNoSpeech(piece)), `no silent piece in: ${JSON.stringify(pieces.map((x) => x.slice(0, 12)))}`);
  // A section that is nothing but a break is the same situation.
  assert.ok(splitForKokoro('***').every((piece) => hasNoSpeech(piece)));
});

test('a passage opening on an ellipsis keeps it', async () => {
  const { splitForKokoro } = await import('../src/utils/kokoro.ts');
  // A pattern requiring a non-terminator first can never match at position 0,
  // which silently dropped these characters.
  const pieces = splitForKokoro('…and then she ran. It was late.');
  assert.ok(pieces.join(' ').startsWith('…'), pieces.join(' | '));

  const bare = (t) => t.replace(/\s+/g, '');
  for (const source of ['…and then.', '?! Really.', '... wait.', '.'.repeat(10) + ' end.']) {
    assert.equal(bare(splitForKokoro(source).join('')), bare(source), `text lost in: ${source}`);
  }
});

test('audio far shorter than its text is treated as incomplete', async () => {
  const { audioLooksComplete, CHARS_PER_SECOND } = await import('../src/utils/audio.ts');
  const rate = 24000;
  const pcmOf = (seconds) => new Int16Array(Math.round(seconds * rate));
  const text = 'x'.repeat(280); // ~20s of speech

  // A full read passes; so does a brisk one, because pace varies by voice.
  assert.ok(audioLooksComplete(pcmOf(280 / CHARS_PER_SECOND), rate, text).ok);
  assert.ok(audioLooksComplete(pcmOf(14), rate, text).ok, 'a fast but complete read must not be rejected');

  // A paragraph dropped mid-passage, and nothing at all, must both be caught.
  assert.ok(!audioLooksComplete(pcmOf(4), rate, text).ok, 'a truncated passage slipped through');
  assert.ok(!audioLooksComplete(new Int16Array(0), rate, text).ok, 'empty audio slipped through');

  // Very short text is exempt: a two-word line is too noisy to judge.
  assert.ok(audioLooksComplete(pcmOf(0.2), rate, 'Yes.').ok);
});

test('a software adapter is not mistaken for a graphics card', async () => {
  const { inspectGpu } = await import('../src/utils/gpu.ts');

  const scope = (gpu) => ({ navigator: { gpu } });

  // No WebGPU at all.
  assert.equal((await inspectGpu(scope(undefined))).reason, 'unsupported');
  // Present, but refuses to hand over an adapter.
  assert.equal((await inspectGpu(scope({ requestAdapter: async () => null }))).reason, 'unavailable');

  // The case that matters: Chrome reporting "Software only". Accepting this
  // would fetch four times the weights and run them on a CPU rasterizer.
  assert.equal(
    (await inspectGpu(scope({ requestAdapter: async () => ({ isFallbackAdapter: true }) }))).reason,
    'software',
  );
  for (const description of ['SwiftShader Device', 'llvmpipe (LLVM 15)', 'Microsoft Basic Render Driver']) {
    const verdict = await inspectGpu(scope({ requestAdapter: async () => ({ info: { description } }) }));
    assert.equal(verdict.usable, false, `${description} was accepted as hardware`);
    assert.equal(verdict.reason, 'software');
  }

  // A real card is accepted, including via the older info spelling.
  const real = await inspectGpu(scope({ requestAdapter: async () => ({ info: { vendor: 'nvidia', architecture: 'ampere' } }) }));
  assert.equal(real.usable, true, real.describe);
  const older = await inspectGpu(
    scope({ requestAdapter: async () => ({ requestAdapterInfo: async () => ({ vendor: 'apple', architecture: 'metal-3' }) }) }),
  );
  assert.equal(older.usable, true, older.describe);

  // A throwing requestAdapter must not take the page down with it.
  assert.equal((await inspectGpu(scope({ requestAdapter: async () => { throw new Error('no'); } }))).usable, false);
});

// --- front matter -----------------------------------------------------------
//
// A store rejected a generated EPUB for "excessive duplication of text,
// including the title, table of contents, and chapter headings at the
// beginning of the book". The manuscript's own title page and typed contents
// were being kept alongside the ones the EPUB generates for itself.

test('the book does not open by repeating itself', () => {
  const { convertTextToEpub, extractEpubText } = require('../server-build/server.cjs');
  const source = [
    'Ghost Signal', 'A Novel', 'by A. Writer', '',
    'Copyright 2026 by A. Writer', 'All rights reserved.', '',
    'Table of Contents',
    'Chapter 1: The Signal ..... 1',
    'Chapter 2: The Answer ..... 20', '',
    'Chapter 1: The Signal', '', 'Thorne stared at the console.', '',
    'Chapter 2: The Answer', '', 'VERNA said nothing for a long moment.',
  ].join('\n');

  const text = extractEpubText(convertTextToEpub(source, 'Ghost Signal', 'A. Writer'));
  const occurrences = (needle) => text.split(needle).length - 1;

  assert.equal(occurrences('Ghost Signal'), 1, `title appears ${occurrences('Ghost Signal')} times`);
  // Counted as a line of its own: the author's name inside the copyright
  // notice is content, not a repeat of the title page.
  const lines = text.split('\n').map((line) => line.trim());
  assert.equal(lines.filter((line) => line === 'A. Writer').length, 1, 'the author line is repeated');
  assert.equal(lines.filter((line) => line === 'by A. Writer').length, 0, 'the typed byline survived');
  assert.equal(occurrences('Chapter 1: The Signal'), 1, 'the chapter heading is repeated');

  // The typed contents duplicates the nav and is meaningless in a reflowable
  // book, where there are no page numbers.
  assert.ok(!text.includes('Table of Contents'), 'the typed contents survived');
  assert.ok(!text.includes('.....'), 'dot leaders survived');

  // Real content must be untouched.
  assert.match(text, /A Novel/);
  assert.match(text, /Copyright 2026 by A\. Writer/);
  assert.match(text, /All rights reserved\./);
  assert.match(text, /Thorne stared at the console\./);
  assert.match(text, /VERNA said nothing for a long moment\./);
});

test('front matter cleanup cannot reach into the book', () => {
  const { convertTextToEpub, extractEpubText } = require('../server-build/server.cjs');
  // A chapter that legitimately discusses contents pages and repeats the title.
  const source = [
    'The Index', 'by R. Shelf', '',
    'Chapter 1: Beginnings', '',
    'She read the Table of Contents aloud, twice.',
    'The Index was the only book on the shelf.',
    'Entry 4 ..... 12 was circled in red.',
  ].join('\n');

  const text = extractEpubText(convertTextToEpub(source, 'The Index', 'R. Shelf'));
  assert.match(text, /She read the Table of Contents aloud, twice\./);
  assert.match(text, /The Index was the only book on the shelf\./);
  assert.match(text, /Entry 4 \.{5} 12 was circled in red\./);
});

test('a book with no front matter is unchanged', () => {
  const { convertTextToEpub, extractEpubText, validateEpubStructure } = require('../server-build/server.cjs');
  const source = 'Chapter 1: Alone\n\nIt began without ceremony.\n\nChapter 2: Together\n\nAnd ended the same way.';
  const epub = convertTextToEpub(source, 'Plain', 'Nobody');

  const text = extractEpubText(epub);
  assert.match(text, /It began without ceremony\./);
  assert.match(text, /And ended the same way\./);
  assert.equal(validateEpubStructure(epub).valid, true);
});
