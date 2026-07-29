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

  assert.deepEqual(validateEpubStructure(epub), { valid: true, errors: [], warnings: [] });
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

// --- manuscript translation ------------------------------------------------

test('translation serialization round-trips structure and emphasis', () => {
  const { htmlToBlocks, serializeBlocksForTranslation, parseTranslatedBlocks, blockText } =
    require('../server-build/server.cjs');

  const blocks = htmlToBlocks(`<html><body>
    <h1>Chapter One</h1>
    <p>The lamp was <strong>cold</strong> and the keeper was <em>gone</em>.</p>
    <blockquote>Nothing burns forever.</blockquote>
    <ul><li>First</li></ul>
    <hr/>
    <p>She climbed again.</p>
  </body></html>`);

  const wire = serializeBlocksForTranslation(blocks);
  assert.match(wire, /^\[1\|h1\] Chapter One$/m);
  assert.match(wire, /\[2\|p\] The lamp was <b>cold<\/b> and the keeper was <i>gone<\/i>\./);
  assert.match(wire, /^\[5\|scene\]$/m);

  // A well-formed model reply.
  const reply = [
    '[1|h1] Capítulo Uno',
    '[2|p] La lámpara estaba <b>fría</b> y el farero se había <i>marchado</i>.',
    '[3|quote] Nada arde para siempre.',
    '[4|li] Primero',
    '[5|scene]',
    '[6|p] Volvió a subir.',
  ].join('\n');

  const { blocks: out, missing } = parseTranslatedBlocks(reply, blocks);
  assert.equal(missing.length, 0);
  assert.equal(out.length, blocks.length);
  assert.deepEqual(out.map((b) => b.type), blocks.map((b) => b.type));
  assert.equal(out[0].level, 1);
  assert.equal(blockText(out[1]), 'La lámpara estaba fría y el farero se había marchado.');
  assert.ok(out[1].runs.some((r) => r.text === 'fría' && r.bold), 'bold survives translation');
  assert.ok(out[1].runs.some((r) => r.text === 'marchado' && r.italic), 'italic survives translation');
  assert.equal(out[4].type, 'scene');
});

test('a dropped line keeps the source text instead of losing it', () => {
  const { textToBlocks, parseTranslatedBlocks, blockText } = require('../server-build/server.cjs');
  const blocks = textToBlocks('First paragraph.\nSecond paragraph.\nThird paragraph.');

  // The model skipped line 2 entirely.
  const { blocks: out, missing } = parseTranslatedBlocks('[1|p] Primer párrafo.\n[3|p] Tercer párrafo.', blocks);
  assert.deepEqual(missing, [2]);
  assert.equal(blockText(out[0]), 'Primer párrafo.');
  assert.equal(blockText(out[1]), 'Second paragraph.', 'untranslated text is preserved, not dropped');
  assert.equal(blockText(out[2]), 'Tercer párrafo.');
});

test('malformed replies degrade safely', () => {
  const { textToBlocks, parseTranslatedBlocks, blockText } = require('../server-build/server.cjs');
  const blocks = textToBlocks('Only one paragraph here.');

  // Commentary and no tags at all.
  const { blocks: out, missing } = parseTranslatedBlocks('Sure! Here is your translation:\nUn párrafo.', blocks);
  assert.deepEqual(missing, [1]);
  assert.equal(blockText(out[0]), 'Only one paragraph here.');

  // Wrapped line: the tag is present but the text continues on the next line.
  const wrapped = parseTranslatedBlocks('[1|p] Un solo\npárrafo aquí.', blocks);
  assert.match(blockText(wrapped.blocks[0]), /Un solo/);
});

test('segment planning breaks at chapters and never splits a paragraph', () => {
  const { textToBlocks, planTranslationSegments } = require('../server-build/server.cjs');
  const lines = [];
  for (let chapter = 1; chapter <= 3; chapter++) {
    lines.push(`Chapter ${chapter}: Section ${chapter}`, '');
    for (let p = 0; p < 6; p++) lines.push(`${'word '.repeat(120).trim()}`, '');
  }
  const blocks = textToBlocks(lines.join('\n'));
  const segments = planTranslationSegments(blocks, 400);

  assert.ok(segments.length >= 3, `expected several segments, got ${segments.length}`);
  // Contiguous, gapless, and covering every block exactly once.
  assert.equal(segments[0].startBlock, 0);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].startBlock, segments[i - 1].endBlock + 1, 'segments must be contiguous');
  }
  assert.equal(segments.at(-1).endBlock, blocks.length - 1, 'segments must cover the whole book');
  assert.ok(segments.some((s) => /Chapter 2/.test(s.label)), 'segments are labelled by chapter');
});

test('emphasis parsing tolerates what models actually return', () => {
  const { textToBlocks, parseTranslatedBlocks, blockText } = require('../server-build/server.cjs');
  const blocks = textToBlocks('placeholder');

  const styled = (reply) => parseTranslatedBlocks(reply, blocks).blocks[0].runs;

  // Uppercase tags.
  assert.ok(styled('[1|p] La lámpara estaba <B>fría</B>.').some((r) => r.text === 'fría' && r.bold));
  // Spaced tags.
  assert.ok(styled('[1|p] Estaba < i >fría</ i >.').some((r) => r.text === 'fría' && r.italic));
  // HTML synonyms.
  assert.ok(styled('[1|p] Estaba <strong>fría</strong> y <em>sola</em>.').some((r) => r.text === 'fría' && r.bold));
  // Markdown instead of tags.
  const markdown = styled('[1|p] Estaba **fría** y *sola*.');
  assert.ok(markdown.some((r) => r.text === 'fría' && r.bold), 'markdown bold understood');
  assert.ok(markdown.some((r) => r.text === 'sola' && r.italic), 'markdown italic understood');
  // Unbalanced tag must not swallow the line.
  const unbalanced = parseTranslatedBlocks('[1|p] Estaba <b>fría y sola.', blocks).blocks[0];
  assert.equal(blockText(unbalanced), 'Estaba fría y sola.');
  // No emphasis at all still yields clean text.
  assert.equal(blockText(parseTranslatedBlocks('[1|p] Texto simple.', blocks).blocks[0]), 'Texto simple.');
});
