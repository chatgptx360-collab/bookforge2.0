import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';
import type { BookProject } from '../types';

const BODY_FONT = 'Georgia';

/** Builds a KDP-ready DOCX entirely in the browser and triggers a download. */
export async function exportToKDPDocx(project: BookProject): Promise<void> {
  const outline = project.outline;
  if (!outline) throw new Error('Create the outline blueprint before exporting.');

  const title = outline.suggestedBookTitle || project.title || 'Untitled Manuscript';
  const subtitle = outline.suggestedSubTitle || project.subtitle || '';
  const penName = project.penName || project.authorPersona || 'Unknown Author';
  const year = new Date().getFullYear();

  const children: Paragraph[] = [];
  const blank = (count = 1) => {
    for (let i = 0; i < count; i++) children.push(new Paragraph({ text: '' }));
  };
  const centered = (text: string, size: number, opts: { bold?: boolean; italics?: boolean; color?: string; after?: number } = {}) =>
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: opts.after ?? 240 },
        children: [
          new TextRun({
            text,
            font: BODY_FONT,
            size,
            bold: opts.bold,
            italics: opts.italics,
            color: opts.color ?? '000000',
          }),
        ],
      }),
    );
  const pageBreak = () => children.push(new Paragraph({ children: [new TextRun('')], pageBreakBefore: true }));

  // ---- Title page -------------------------------------------------------
  blank(8);
  centered(title.toUpperCase(), 56, { bold: true });
  if (subtitle) centered(subtitle, 28, { italics: true, color: '444444', after: 720 });
  blank(6);
  centered('WRITTEN BY', 18, { color: '666666', after: 120 });
  centered(penName, 32, { bold: true, after: 480 });
  blank(4);
  centered('PREMIUM KDP EDITION', 16, { bold: true, color: '888888' });
  pageBreak();

  // ---- Copyright --------------------------------------------------------
  blank(4);
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: title, font: BODY_FONT, size: 24, bold: true })],
    }),
  );
  if (subtitle) {
    children.push(
      new Paragraph({
        spacing: { after: 480 },
        children: [new TextRun({ text: subtitle, font: BODY_FONT, size: 20, italics: true })],
      }),
    );
  }
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: `Copyright © ${year} by ${penName}`, font: BODY_FONT, size: 20, bold: true })],
    }),
  );
  [
    'All rights reserved. No part of this book may be reproduced or used in any manner without written permission of the copyright owner.',
    'ISBN-13: [Placeholder for KDP registration ISBN]',
    `First edition: ${year}`,
  ].forEach((line) =>
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: 180, line: 288 },
        children: [new TextRun({ text: line, font: BODY_FONT, size: 20, color: '555555' })],
      }),
    ),
  );
  pageBreak();

  // ---- Dedication -------------------------------------------------------
  if (project.dedicationText) {
    blank(10);
    centered(project.dedicationText, 24, { italics: true });
    pageBreak();
  }

  // ---- Table of contents ------------------------------------------------
  blank(2);
  centered('TABLE OF CONTENTS', 32, { bold: true, after: 480 });
  const tocEntry = (name: string, page: string, bold = false) =>
    children.push(
      new Paragraph({
        spacing: { after: 140 },
        children: [
          new TextRun({ text: name, font: BODY_FONT, size: 22, bold }),
          new TextRun({
            text: ` ${'.'.repeat(Math.max(10, 75 - name.length))} ${page}`,
            font: BODY_FONT,
            size: 18,
            color: '888888',
          }),
        ],
      }),
    );
  tocEntry('Title Page', 'i', true);
  tocEntry('Copyright', 'ii', true);
  outline.chapters.forEach((chapter) => {
    const name = `Chapter ${chapter.chapterNumber}: ${chapter.title.replace(/^Chapter\s+\d+:\s*/i, '')}`;
    tocEntry(name, String(chapter.chapterNumber + 4));
  });
  tocEntry('Acknowledgements', 'Back Matter', true);
  tocEntry('About the Author', 'Back Matter', true);
  pageBreak();

  // ---- Chapters ---------------------------------------------------------
  outline.chapters.forEach((chapterOutline) => {
    const draft = project.chapters.find((c) => c.chapterNumber === chapterOutline.chapterNumber);
    const chapterTitle = chapterOutline.title.replace(/^Chapter\s+\d+:\s*/i, '');
    blank(3);
    centered(`CHAPTER ${chapterOutline.chapterNumber}`, 24, { bold: true, color: '777777', after: 120 });
    centered(chapterTitle.toUpperCase(), 36, { bold: true, after: 720 });
    blank(1);

    if (draft?.text?.trim()) {
      let isFirstParagraph = true;
      for (const rawLine of draft.text.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (/^#{1,2}\s+chapter\s+\d+/i.test(trimmed) || /^#\s+/.test(trimmed)) continue;
        if (/^#{2,4}\s+/.test(trimmed)) {
          children.push(
            new Paragraph({
              spacing: { before: 180, after: 120 },
              children: [
                new TextRun({ text: trimmed.replace(/^#+\s+/, ''), font: BODY_FONT, size: 24, bold: true }),
              ],
            }),
          );
          isFirstParagraph = true;
          continue;
        }
        const cleanText = trimmed
          .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
          .replace(/\*\*(.*?)\*\*/g, '$1')
          .replace(/\*(.*?)\*/g, '$1')
          .replace(/^_{3,}$|^-{3,}$/g, '');
        if (!cleanText) continue;
        children.push(
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            indent: { firstLine: isFirstParagraph ? 0 : 720 },
            spacing: { after: 180, line: 360 },
            children: [new TextRun({ text: cleanText, font: BODY_FONT, size: 22 })],
          }),
        );
        isFirstParagraph = false;
      }
    } else {
      centered('Chapter content pending.', 22, { italics: true, color: '888888' });
    }
    pageBreak();
  });

  // ---- Back matter ------------------------------------------------------
  if (project.acknowledgementsText) {
    blank(2);
    centered('ACKNOWLEDGEMENTS', 32, { bold: true, after: 480 });
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        indent: { firstLine: 720 },
        spacing: { line: 360, after: 180 },
        children: [new TextRun({ text: project.acknowledgementsText, font: BODY_FONT, size: 22 })],
      }),
    );
    pageBreak();
  }

  if (project.aboutAuthorText) {
    blank(2);
    centered('ABOUT THE AUTHOR', 32, { bold: true, after: 480 });
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        indent: { firstLine: 720 },
        spacing: { line: 360, after: 180 },
        children: [new TextRun({ text: project.aboutAuthorText, font: BODY_FONT, size: 22 })],
      }),
    );
  }

  const doc = new Document({
    creator: penName,
    title,
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^a-zA-Z0-9]+/g, '_')}_KDP_Edition.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
