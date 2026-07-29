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
  for (const voice of TTS_VOICES) {
    assert.ok(voice.name && !names.has(voice.name), `duplicate or missing name: ${voice.name}`);
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
  // The default the UI ships with must exist in the catalogue.
  assert.ok(names.has('Sulafat'));
  // Both genders must be usefully represented, or the filter is pointless.
  for (const gender of ['male', 'female']) {
    const count = TTS_VOICES.filter((voice) => voice.gender === gender).length;
    assert.ok(count >= 8, `only ${count} ${gender} voices`);
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
