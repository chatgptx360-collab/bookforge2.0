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
